import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { parseMoneyToMinor } from "../shared/finance";
import type {
  ImportBatchResult,
  ImportDuplicate,
  ImportFilesOptions,
  ImportProgress,
  InvoiceDocument,
  InvoiceRow,
  ReceiptDebug,
  ReceiptRecord,
} from "../shared/types";
import type { InvoiceStore } from "./invoice-store";
import { OpenAiReceiptClient } from "./openai";
import {
  assertReceiptFileSize,
  isSupportedReceipt,
  managedReceiptFilename,
  mimeTypeForPath,
  pathExists,
  readExtractionInput,
  resolveInside,
  sha256File,
  writeJsonAtomic,
} from "./receipt-files";
import type { SettingsStore } from "./settings";

type ProgressSink = (progress: ImportProgress) => void;
type ApiKeyReader = Pick<SettingsStore, "getOpenAiKey">;
type ReceiptClient = Pick<OpenAiReceiptClient, "extract">;
type ReceiptClientFactory = (apiKey: string) => ReceiptClient;

export class ImportManager {
  constructor(
    private readonly invoices: InvoiceStore,
    private readonly settings: ApiKeyReader,
    private readonly onProgress: ProgressSink,
    private readonly createClient: ReceiptClientFactory = (apiKey) =>
      new OpenAiReceiptClient(apiKey)
  ) {}

  async importFiles(
    invoiceId: string,
    sourcePaths: string[],
    options: ImportFilesOptions = {}
  ): Promise<ImportBatchResult> {
    const uniquePaths = [...new Set(sourcePaths.map((item) => path.resolve(item)))];
    const duplicates: ImportDuplicate[] = [];
    const errors: Array<{ filename: string; message: string }> = [];
    let importedCount = 0;

    for (let index = 0; index < uniquePaths.length; index += 1) {
      const sourcePath = uniquePaths[index];
      const filename = path.basename(sourcePath);
      try {
        this.progress(invoiceId, index + 1, uniquePaths.length, filename, "copying");
        await this.validateSource(sourcePath);
        const sha256 = await sha256File(sourcePath);
        const matches = await this.invoices.findHash(sha256);
        const sameInvoice = matches.find((match) => match.invoiceId === invoiceId);
        const otherInvoice = matches.find((match) => match.invoiceId !== invoiceId);

        if (sameInvoice || (otherInvoice && !options.allowCrossInvoiceDuplicates)) {
          const match = sameInvoice ?? otherInvoice;
          if (match) {
            duplicates.push({
              path: sourcePath,
              filename,
              matchInvoiceName: match.invoiceName,
              sameInvoice: Boolean(sameInvoice),
            });
            this.progress(
              invoiceId,
              index + 1,
              uniquePaths.length,
              filename,
              "duplicate",
              `Already imported in ${match.invoiceName}`
            );
          }
          continue;
        }

        const receipt = await this.copyAndCreateReceipt(
          invoiceId,
          sourcePath,
          sha256,
          options.method ?? "file-picker"
        );
        importedCount += 1;

        const apiKey = await this.settings.getOpenAiKey();
        if (!apiKey) {
          await this.setReceiptState(invoiceId, receipt.id, "needs-key");
          this.progress(
            invoiceId,
            index + 1,
            uniquePaths.length,
            filename,
            "needs-key",
            "Add an OpenAI key in Settings to scan."
          );
          continue;
        }

        try {
          await this.scanReceipt(invoiceId, receipt.id, apiKey, index + 1, uniquePaths.length);
        } catch (error) {
          errors.push({ filename, message: messageFor(error) });
        }
      } catch (error) {
        errors.push({ filename, message: messageFor(error) });
        this.progress(
          invoiceId,
          index + 1,
          uniquePaths.length,
          filename,
          "error",
          messageFor(error)
        );
      }
    }

    return {
      invoice: await this.invoices.loadInvoice(invoiceId),
      importedCount,
      duplicates,
      errors,
    };
  }

  async retryReceipts(invoiceId: string, receiptIds: string[]): Promise<InvoiceDocument> {
    const apiKey = await this.settings.getOpenAiKey();
    if (!apiKey) {
      throw new Error("Add an OpenAI API key in Settings first.");
    }
    const uniqueIds = [...new Set(receiptIds)];
    for (let index = 0; index < uniqueIds.length; index += 1) {
      try {
        await this.scanReceipt(invoiceId, uniqueIds[index], apiKey, index + 1, uniqueIds.length);
      } catch {
        // scanReceipt records the error on the receipt so the rest can continue.
      }
    }
    return this.invoices.loadInvoice(invoiceId);
  }

  private async copyAndCreateReceipt(
    invoiceId: string,
    sourcePath: string,
    sha256: string,
    method: "drag-drop" | "file-picker"
  ): Promise<ReceiptRecord> {
    const invoice = await this.invoices.loadInvoice(invoiceId);
    const invoiceFolder = await this.invoices.getInvoiceFolder(invoice.name);
    const receiptId = `rcpt_${crypto.randomUUID()}`;
    const rowId = `row_${crypto.randomUUID()}`;
    const desiredName = managedReceiptFilename(sourcePath, sha256);
    const storedName = await availableFilename(
      path.join(invoiceFolder, "receipts"),
      desiredName,
      receiptId.slice(-8)
    );
    const relativePath = path.join("receipts", storedName);
    const debugPath = path.join("debug", `${receiptId}.json`);
    const destination = resolveInside(invoiceFolder, relativePath);
    const now = new Date().toISOString();
    const mimeType = mimeTypeForPath(sourcePath);
    if (!mimeType) {
      throw new Error("Unsupported receipt file type.");
    }

    const receipt: ReceiptRecord = {
      id: receiptId,
      relativePath,
      debugPath,
      originalFilename: path.basename(sourcePath),
      mimeType,
      sha256,
      source: { kind: "manual", method },
      status: "queued",
      importedAt: now,
    };
    const row: InvoiceRow = {
      id: rowId,
      date: null,
      groceriesMinor: null,
      hours: "",
      rateMinor: invoice.defaultRateMinor,
      comment: humanizeFilename(sourcePath),
      receiptId,
    };

    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(sourcePath, destination, fsConstants.COPYFILE_EXCL);
    try {
      const copiedSha256 = await sha256File(destination);
      if (copiedSha256 !== sha256) {
        throw new Error("The source file changed while it was being imported. Try again.");
      }
      await this.invoices.mutateInvoice(invoiceId, (next) => {
        next.receipts.push(receipt);
        next.rows.push(row);
      });
    } catch (error) {
      await fs.rm(destination, { force: true });
      throw error;
    }
    return receipt;
  }

  private async scanReceipt(
    invoiceId: string,
    receiptId: string,
    apiKey: string,
    current: number,
    total: number
  ): Promise<void> {
    const invoice = await this.invoices.loadInvoice(invoiceId);
    const receipt = invoice.receipts.find((item) => item.id === receiptId);
    if (!receipt) {
      throw new Error("Receipt not found.");
    }
    const invoiceFolder = await this.invoices.getInvoiceFolder(invoice.name);
    const receiptPath = resolveInside(invoiceFolder, receipt.relativePath);
    await this.setReceiptState(invoiceId, receiptId, "scanning");
    this.progress(invoiceId, current, total, receipt.originalFilename, "scanning");

    let prepared: Awaited<ReturnType<typeof readExtractionInput>> | undefined;
    try {
      prepared = await readExtractionInput(receiptPath);
      const client = this.createClient(apiKey);
      const result = await client.extract(prepared.buffer, prepared.filename, prepared.mimeType);
      const warnings = [...result.validationWarnings];
      const groceriesMinor = parseMoneyToMinor(result.extraction.total);
      if (result.extraction.total !== null && groceriesMinor === null) {
        warnings.push("The final total could not be converted to cents.");
      }

      const debug: ReceiptDebug = {
        receiptId,
        provider: "openai",
        model: result.model,
        scannedAt: new Date().toISOString(),
        extraction: result.extraction,
        validationWarnings: warnings,
        usage: result.usage,
      };
      await writeJsonAtomic(resolveInside(invoiceFolder, receipt.debugPath), debug);

      await this.invoices.mutateInvoice(invoiceId, (next) => {
        const nextReceipt = next.receipts.find((item) => item.id === receiptId);
        if (!nextReceipt) {
          throw new Error("Receipt was removed while it was scanning.");
        }
        nextReceipt.status = warnings.length > 0 ? "needs-review" : "ready";
        delete nextReceipt.error;
        const row = next.rows.find((item) => item.receiptId === receiptId);
        if (row) {
          row.date = result.extraction.date;
          row.groceriesMinor = groceriesMinor;
          row.comment = result.extraction.merchant?.trim() || row.comment;
        }
      });
      this.progress(
        invoiceId,
        current,
        total,
        receipt.originalFilename,
        warnings.length > 0 ? "needs-review" : "ready",
        warnings[0]
      );
    } catch (error) {
      await this.invoices.mutateInvoice(invoiceId, (next) => {
        const nextReceipt = next.receipts.find((item) => item.id === receiptId);
        if (nextReceipt) {
          nextReceipt.status = "error";
          nextReceipt.error = messageFor(error);
        }
      });
      this.progress(
        invoiceId,
        current,
        total,
        receipt.originalFilename,
        "error",
        messageFor(error)
      );
      throw error;
    } finally {
      await prepared?.cleanup();
    }
  }

  private async setReceiptState(
    invoiceId: string,
    receiptId: string,
    status: ReceiptRecord["status"]
  ): Promise<void> {
    await this.invoices.mutateInvoice(invoiceId, (invoice) => {
      const receipt = invoice.receipts.find((item) => item.id === receiptId);
      if (receipt) {
        receipt.status = status;
        if (status !== "error") {
          delete receipt.error;
        }
      }
    });
  }

  private progress(
    invoiceId: string,
    current: number,
    total: number,
    filename: string,
    status: ImportProgress["status"],
    message?: string
  ): void {
    this.onProgress({
      invoiceId,
      current,
      total,
      filename,
      status,
      message,
    });
  }

  private async validateSource(sourcePath: string): Promise<void> {
    if (!isSupportedReceipt(sourcePath)) {
      throw new Error("Unsupported file. Use JPEG, PNG, WebP, HEIC/HEIF, or PDF.");
    }
    const stat = await fs.stat(sourcePath);
    if (!stat.isFile()) {
      throw new Error("The selected path is not a file.");
    }
    await assertReceiptFileSize(sourcePath);
  }
}

async function availableFilename(
  directory: string,
  desired: string,
  suffix: string
): Promise<string> {
  const candidate = path.join(directory, desired);
  if (!(await pathExists(candidate))) {
    return desired;
  }
  const extension = path.extname(desired);
  const base = path.basename(desired, extension);
  return `${base}-${suffix}${extension}`;
}

function humanizeFilename(filePath: string): string {
  return path
    .basename(filePath, path.extname(filePath))
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected import error.";
}
