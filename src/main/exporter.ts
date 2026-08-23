import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { type BrowserWindow, clipboard, dialog, shell } from "electron";
import { invoiceToCsv, invoiceToTsv } from "../shared/tabular";
import type {
  ExportPackageOptions,
  ExportPackageResult,
  InvoiceDocument,
  ReceiptDebug,
  ReceiptPreviewPayload,
  ReceiptRecord,
} from "../shared/types";
import { runBounded } from "./bounded-operations";
import type { InvoiceStore } from "./invoice-store";
import { readReceiptDebugFile } from "./receipt-debug";
import { pathExists, receiptPreviewBytes, resolveInside, sha256File } from "./receipt-files";

const execFileAsync = promisify(execFile);
const VALID_SHA256 = /^[0-9a-f]{64}$/;
export const EXPORT_FILE_CONCURRENCY = 4;

interface ReceiptContext {
  invoiceFolder: string;
  receipt: ReceiptRecord;
}

type ExportStore = Pick<InvoiceStore, "loadInvoice" | "getInvoiceFolder">;

export class InvoiceExporter {
  private readonly receiptContextLoads = new Map<string, Promise<ReceiptContext>>();

  constructor(
    private readonly invoices: ExportStore,
    private readonly getWindow: () => BrowserWindow | null
  ) {}

  async copyTsv(
    invoiceId: string,
    rowIds: string[] | null,
    includeHeaders: boolean,
    includeTotals: boolean
  ): Promise<void> {
    const invoice = await this.invoices.loadInvoice(invoiceId);
    const tsv = invoiceToTsv(invoice, {
      rowIds,
      includeHeaders,
      includeTotals,
      fullYearDates: false,
    });
    clipboard.writeText(tsv);
  }

  async revealInvoice(invoiceId: string): Promise<void> {
    const folder = await this.invoices.getInvoiceFolder(invoiceId);
    const error = await shell.openPath(folder);
    if (error) {
      throw new Error(error);
    }
  }

  async getReceiptPreview(invoiceId: string, receiptId: string): Promise<ReceiptPreviewPayload> {
    const { invoiceFolder, receipt } = await this.getReceiptContext(invoiceId, receiptId);
    const filePath = resolveInside(invoiceFolder, receipt.relativePath);
    const preview = await receiptPreviewBytes(filePath);
    return {
      filename: receipt.originalFilename,
      mimeType: preview.mimeType,
      bytes: preview.bytes,
      managedPath: filePath,
    };
  }

  async getReceiptDebug(invoiceId: string, receiptId: string): Promise<ReceiptDebug | null> {
    const { invoiceFolder, receipt } = await this.getReceiptContext(invoiceId, receiptId);
    const debugPath = resolveInside(invoiceFolder, receipt.debugPath);
    return readReceiptDebugFile(debugPath, receipt.id);
  }

  private getReceiptContext(invoiceId: string, receiptId: string): Promise<ReceiptContext> {
    const key = JSON.stringify([invoiceId, receiptId]);
    const existing = this.receiptContextLoads.get(key);
    if (existing) return existing;

    const pending = (async () => {
      const invoice = await this.invoices.loadInvoice(invoiceId);
      const receipt = invoice.receipts.find((item) => item.id === receiptId);
      if (!receipt) {
        throw new Error("Receipt not found.");
      }
      const invoiceFolder = await this.invoices.getInvoiceFolder(invoice.id);
      return { invoiceFolder, receipt };
    })();
    this.receiptContextLoads.set(key, pending);
    const clear = () => {
      if (this.receiptContextLoads.get(key) === pending) {
        this.receiptContextLoads.delete(key);
      }
    };
    void pending.then(clear, clear);
    return pending;
  }

  async exportPackage(
    invoiceId: string,
    options: ExportPackageOptions
  ): Promise<ExportPackageResult> {
    const initialInvoice = await this.invoices.loadInvoice(invoiceId);
    const invoiceFolder = await this.invoices.getInvoiceFolder(initialInvoice.name);

    if (options.asZip) {
      const defaultPath = path.join(path.dirname(invoiceFolder), `${initialInvoice.name}.zip`);
      const result = await dialog.showSaveDialog(this.windowOptions(), {
        title: "Export invoice ZIP",
        defaultPath,
        buttonLabel: "Export ZIP",
        filters: [{ name: "ZIP archive", extensions: ["zip"] }],
      });
      if (result.canceled || !result.filePath) {
        return { canceled: true };
      }
      const outputPath = result.filePath.toLowerCase().endsWith(".zip")
        ? result.filePath
        : `${result.filePath}.zip`;
      const canonicalInvoiceFolder = await fs.realpath(invoiceFolder);
      const canonicalOutputParent = await fs.realpath(path.dirname(outputPath));
      const canonicalOutputPath = path.join(canonicalOutputParent, path.basename(outputPath));
      if (isInsideOrEqual(canonicalOutputPath, canonicalInvoiceFolder)) {
        throw new Error("Choose a ZIP destination outside the live invoice folder.");
      }
      const invoice = await this.invoices.loadInvoice(invoiceId);
      await this.verifyManagedFiles(invoice, invoiceFolder);
      await this.writeZip(invoiceFolder, invoice, outputPath, options.includeDebug);
      return { canceled: false, outputPath };
    }

    const result = await dialog.showOpenDialog(this.windowOptions(), {
      title: "Choose a folder for the exported copy",
      buttonLabel: "Export here",
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true };
    }

    const selectedParent = await canonicalOrdinaryDirectory(result.filePaths[0]);
    const baseFolder = await fs.realpath(path.dirname(invoiceFolder));
    if (isInsideOrEqual(selectedParent, baseFolder)) {
      throw new Error("Choose a destination outside the live invoice base folder.");
    }

    const invoice = await this.invoices.loadInvoice(invoiceId);
    await this.verifyManagedFiles(invoice, invoiceFolder);
    const outputPath = await availableExportFolder(selectedParent, invoice.name);
    const stagedOutput = path.join(
      selectedParent,
      `.${path.basename(outputPath)}.tmp-${randomUUID()}`
    );
    try {
      await this.copyPackage(invoiceFolder, stagedOutput, options.includeDebug, invoice);
      await fs.rename(stagedOutput, outputPath);
    } finally {
      await fs.rm(stagedOutput, { recursive: true, force: true }).catch(() => undefined);
    }
    return { canceled: false, outputPath };
  }

  private async verifyManagedFiles(invoice: InvoiceDocument, invoiceFolder: string): Promise<void> {
    await runBounded(
      invoice.receipts.map((receipt) => async () => {
        const expectedSha256 = normalizedReceiptHash(receipt.sha256);
        const receiptPath = resolveInside(invoiceFolder, receipt.relativePath);
        const metadata = await lstatIfExists(receiptPath);
        if (!metadata) {
          throw new Error(`Missing receipt file: ${receipt.originalFilename}`);
        }
        if (metadata.isSymbolicLink() || !metadata.isFile()) {
          throw new Error(`Receipt is not an ordinary file: ${receipt.originalFilename}`);
        }
        const actual = await sha256File(receiptPath);
        if (actual !== expectedSha256) {
          throw new Error(`Receipt changed since import: ${receipt.originalFilename}`);
        }
      }),
      EXPORT_FILE_CONCURRENCY
    );
  }

  private async writeZip(
    invoiceFolder: string,
    invoice: InvoiceDocument,
    outputPath: string,
    includeDebug: boolean
  ): Promise<void> {
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "receipt-invoice-export-"));
    const stagedOutput = `${outputPath}.tmp-${randomUUID()}`;
    try {
      const packageFolder = path.join(temporaryRoot, invoice.name);
      await this.copyPackage(invoiceFolder, packageFolder, includeDebug, invoice);
      const temporaryZip = path.join(temporaryRoot, `${invoice.name}.zip`);
      await execFileAsync("/usr/bin/ditto", [
        "-c",
        "-k",
        "--sequesterRsrc",
        "--keepParent",
        packageFolder,
        temporaryZip,
      ]);
      await fs.copyFile(temporaryZip, stagedOutput);
      await fs.rename(stagedOutput, outputPath);
    } finally {
      await fs.rm(stagedOutput, { force: true }).catch(() => undefined);
      await fs.rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async copyPackage(
    invoiceFolder: string,
    outputFolder: string,
    includeDebug: boolean,
    invoice: InvoiceDocument
  ): Promise<void> {
    await fs.mkdir(outputFolder, { recursive: false });
    try {
      const exportOptions = { includeHeaders: true, includeTotals: true } as const;
      await fs.writeFile(
        path.join(outputFolder, "invoice.tsv"),
        invoiceToTsv(invoice, exportOptions),
        "utf8"
      );
      await fs.writeFile(
        path.join(outputFolder, "invoice.csv"),
        invoiceToCsv(invoice, exportOptions),
        "utf8"
      );
      await fs.mkdir(path.join(outputFolder, "receipts"));

      const copyOperations: Array<() => Promise<void>> = invoice.receipts.map(
        (receipt) => () =>
          copyRegularFile(
            resolveInside(invoiceFolder, receipt.relativePath),
            resolveInside(outputFolder, receipt.relativePath),
            `Receipt ${receipt.originalFilename}`,
            normalizedReceiptHash(receipt.sha256)
          )
      );
      if (includeDebug) {
        await fs.writeFile(
          path.join(outputFolder, "invoice.json"),
          `${JSON.stringify(invoice, null, 2)}\n`,
          "utf8"
        );
        await fs.mkdir(path.join(outputFolder, "debug"));
        for (const receipt of invoice.receipts) {
          const source = resolveInside(invoiceFolder, receipt.debugPath);
          copyOperations.push(async () => {
            if (await pathExists(source)) {
              await copyRegularFile(
                source,
                resolveInside(outputFolder, receipt.debugPath),
                `Debug data for ${receipt.originalFilename}`
              );
            }
          });
        }
      }
      await runBounded(copyOperations, EXPORT_FILE_CONCURRENCY);
    } catch (error) {
      await fs.rm(outputFolder, { recursive: true, force: true });
      throw error;
    }
  }

  private windowOptions(): BrowserWindow {
    const window = this.getWindow();
    if (!window) {
      throw new Error("The app window is unavailable.");
    }
    return window;
  }
}

async function availableExportFolder(parent: string, invoiceName: string): Promise<string> {
  const preferred = path.join(parent, invoiceName);
  if (!(await pathExists(preferred))) {
    return preferred;
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const timestamped = path.join(parent, `${invoiceName}-export-${timestamp}`);
  if (!(await pathExists(timestamped))) {
    return timestamped;
  }
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${timestamped}-${suffix}`;
    if (!(await pathExists(candidate))) {
      return candidate;
    }
  }
}

async function copyRegularFile(
  source: string,
  destination: string,
  label: string,
  expectedSha256?: string
): Promise<void> {
  const metadata = await fs.lstat(source);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`${label} is not an ordinary file.`);
  }
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(source, destination);
  if (expectedSha256 && (await sha256File(destination)) !== expectedSha256) {
    throw new Error(`${label} changed while it was being exported.`);
  }
}

async function lstatIfExists(
  filePath: string
): Promise<Awaited<ReturnType<typeof fs.lstat>> | null> {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function normalizedReceiptHash(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!VALID_SHA256.test(normalized)) {
    throw new Error("Receipt has an invalid saved SHA-256 value.");
  }
  return normalized;
}

function isInsideOrEqual(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function canonicalOrdinaryDirectory(directory: string): Promise<string> {
  const resolved = path.resolve(directory);
  const metadata = await fs.lstat(resolved);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("The export destination must be an ordinary directory.");
  }
  return fs.realpath(resolved);
}
