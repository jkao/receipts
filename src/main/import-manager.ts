import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { parseMoneyToMinor } from "../shared/finance";
import type {
  ImportBatchResult,
  ImportDuplicate,
  ImportFilesOptions,
  ImportJobCancelResult,
  ImportJobStartResult,
  ImportProgress,
  InvoiceDocument,
  InvoiceRow,
  ReceiptDebug,
  ReceiptRecord,
} from "../shared/types";
import { atomicWriteFile, isErrno } from "./atomic-file";
import { ConcurrencyLimiter, mapBounded } from "./bounded-operations";
import type { InvoiceStore } from "./invoice-store";
import { OpenAiReceiptClient } from "./openai";
import {
  MAX_RECEIPT_FILE_BYTES,
  MAX_RECEIPT_FILE_SIZE_LABEL,
  managedReceiptFilename,
  mimeTypeForPath,
  pathExists,
  readExtractionInput,
  resolveInside,
  sha256File,
  writeJsonAtomic,
} from "./receipt-files";
import { KeyedSerialQueue } from "./serial-queue";
import type { SettingsStore } from "./settings";

type ProgressSink = (progress: ImportProgress) => void;
type ApiKeyReader = Pick<SettingsStore, "getOpenAiKey">;
type ReceiptClient = Pick<OpenAiReceiptClient, "extract">;
type ReceiptClientFactory = (apiKey: string) => ReceiptClient;

interface HashedSource {
  sourcePath: string;
  filename: string;
  current: number;
  sha256: string;
  mimeType: string;
}

interface CopiedReceipt {
  source: HashedSource;
  receipt: ReceiptRecord;
  row: InvoiceRow;
  destination: string;
}

interface PreparedImportBatch {
  invoiceId: string;
  invoiceFolder: string;
  total: number;
  apiKey: string | null;
  scans: CopiedReceipt[];
  importedCount: number;
  duplicates: ImportDuplicate[];
  errors: Array<{ filename: string; message: string }>;
  jobId?: string;
}

interface DebugRollback {
  filePath: string;
  previousContents: Buffer | null;
}

interface ActiveImportJob {
  jobId: string;
  invoiceId: string;
  batch: PreparedImportBatch;
  controller: AbortController;
  state: "queued" | "running";
  finished: boolean;
  lastCurrent: number;
}

class ImportCancelledError extends Error {
  constructor() {
    super("Receipt import was cancelled.");
    this.name = "ImportCancelledError";
  }
}

class ReceiptStateRecoveryError extends Error {
  constructor(receiptId: string, state: "error" | "queued", cause: unknown) {
    super(`Could not persist receipt ${receiptId} as ${state}: ${messageFor(cause)}`);
    this.name = "ReceiptStateRecoveryError";
  }
}

export const RECEIPT_SCAN_CONCURRENCY = 2;

export class ImportManager {
  private readonly preparationOperations = new KeyedSerialQueue<string>();
  private readonly scanOperations = new KeyedSerialQueue<string>();
  private readonly providerScans = new ConcurrencyLimiter(RECEIPT_SCAN_CONCURRENCY);
  private readonly activeJobs = new Map<string, ActiveImportJob>();

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
    const batch = await this.prepareSerialized(invoiceId, sourcePaths, options);
    await this.scanOperations.run(batch.invoiceId, () => this.scanPreparedBatch(batch));
    return {
      invoice: await this.invoices.loadInvoice(batch.invoiceId),
      importedCount: batch.importedCount,
      duplicates: batch.duplicates,
      errors: batch.errors,
    };
  }

  async startImport(
    invoiceId: string,
    sourcePaths: string[],
    options: ImportFilesOptions = {}
  ): Promise<ImportJobStartResult> {
    const jobId = `import_${crypto.randomUUID()}`;
    let batch: PreparedImportBatch;
    let invoice: InvoiceDocument;
    try {
      batch = await this.prepareSerialized(invoiceId, sourcePaths, options, jobId);
      invoice = await this.invoices.loadInvoice(batch.invoiceId);
    } catch (error) {
      this.onProgress({
        invoiceId,
        current: 0,
        total: sourcePaths.length,
        filename: "Receipt import",
        status: "failed",
        message: `Import could not start: ${messageFor(error)}`,
      });
      throw error;
    }
    const job: ActiveImportJob = {
      jobId,
      invoiceId: batch.invoiceId,
      batch,
      controller: new AbortController(),
      state: "queued",
      finished: false,
      lastCurrent: 0,
    };
    this.activeJobs.set(jobId, job);
    this.scheduleImportJob(job);

    return {
      jobId,
      invoice,
      importedCount: batch.importedCount,
      duplicates: [...batch.duplicates],
      errors: [...batch.errors],
    };
  }

  cancelImport(jobId: string): ImportJobCancelResult {
    const job = this.activeJobs.get(jobId);
    if (!job || job.finished || job.controller.signal.aborted) {
      return { jobId, cancelled: false };
    }

    job.controller.abort(new ImportCancelledError());
    if (job.state === "queued") {
      this.finishImportJob(job, "cancelled");
    }
    return { jobId, cancelled: true };
  }

  async retryReceipts(invoiceId: string, receiptIds: string[]): Promise<InvoiceDocument> {
    const canonicalInvoiceId = (await this.invoices.loadInvoice(invoiceId)).id;
    return this.scanOperations.run(canonicalInvoiceId, () =>
      this.retryReceiptsNow(canonicalInvoiceId, receiptIds)
    );
  }

  private async retryReceiptsNow(
    invoiceId: string,
    receiptIds: string[]
  ): Promise<InvoiceDocument> {
    const apiKey = await this.settings.getOpenAiKey();
    if (!apiKey) {
      throw new Error("Add an OpenAI API key in Settings first.");
    }

    const invoice = await this.invoices.loadInvoice(invoiceId);
    const invoiceFolder = await this.invoices.getInvoiceFolder(invoice.name);
    const receiptsById = new Map(invoice.receipts.map((receipt) => [receipt.id, receipt]));
    const receipts = [...new Set(receiptIds)].flatMap((receiptId) => {
      const receipt = receiptsById.get(receiptId);
      return receipt ? [receipt] : [];
    });
    if (receipts.length === 0) {
      return invoice;
    }
    let client: ReceiptClient;
    try {
      client = this.createClient(apiKey);
    } catch (error) {
      await this.markReceiptsErrored(
        invoiceId,
        receipts.map((receipt, index) => ({ receipt, current: index + 1 })),
        receipts.length,
        error
      );
      return this.invoices.loadInvoice(invoiceId);
    }
    for (let index = 0; index < receipts.length; index += 1) {
      const receipt = receipts[index];
      try {
        await this.scanReceipt(
          invoiceId,
          invoiceFolder,
          receipt,
          client,
          index + 1,
          receipts.length
        );
      } catch {
        // scanReceipt records the error on the receipt so the rest can continue.
      }
    }
    return this.invoices.loadInvoice(invoiceId);
  }

  private async prepareSerialized(
    invoiceId: string,
    sourcePaths: string[],
    options: ImportFilesOptions,
    jobId?: string
  ): Promise<PreparedImportBatch> {
    const invoice = await this.invoices.loadInvoice(invoiceId);
    return this.preparationOperations.run(invoice.id, () =>
      this.prepareImportBatch(invoice, sourcePaths, options, jobId)
    );
  }

  /**
   * Validate, deduplicate, copy, and durably queue a batch without starting
   * provider work. Keeping this boundary explicit lets callers eventually
   * return after local preparation and run scanPreparedBatch in the background.
   */
  private async prepareImportBatch(
    invoice: InvoiceDocument,
    sourcePaths: string[],
    options: ImportFilesOptions,
    jobId?: string
  ): Promise<PreparedImportBatch> {
    const invoiceId = invoice.id;
    const uniquePaths = [...new Set(sourcePaths.map((item) => path.resolve(item)))];
    const duplicates: ImportDuplicate[] = [];
    const errors: Array<{ filename: string; message: string }> = [];
    const invoiceFolder = await this.invoices.getInvoiceFolder(invoice.name);
    const sources: HashedSource[] = [];
    for (let index = 0; index < uniquePaths.length; index += 1) {
      const sourcePath = uniquePaths[index];
      const filename = path.basename(sourcePath);
      try {
        this.progress(
          invoiceId,
          index + 1,
          uniquePaths.length,
          filename,
          "copying",
          undefined,
          jobId
        );
        const mimeType = await this.validateSource(sourcePath);
        sources.push({
          sourcePath,
          filename,
          current: index + 1,
          sha256: await sha256File(sourcePath),
          mimeType,
        });
      } catch (error) {
        errors.push({ filename, message: messageFor(error) });
        this.progress(
          invoiceId,
          index + 1,
          uniquePaths.length,
          filename,
          "error",
          messageFor(error),
          jobId
        );
      }
    }

    const matchesByHash = await this.invoices.findHashes(sources.map((source) => source.sha256));
    const potentiallyImportable = sources.some((source) => {
      const matches = matchesByHash.get(source.sha256) ?? [];
      const sameInvoice = matches.some((match) => match.invoiceId === invoice.id);
      const otherInvoice = matches.some((match) => match.invoiceId !== invoice.id);
      return !sameInvoice && (!otherInvoice || options.allowCrossInvoiceDuplicates);
    });

    let apiKey: string | null = null;
    let apiKeyError: string | null = null;
    if (potentiallyImportable) {
      try {
        apiKey = await this.settings.getOpenAiKey();
      } catch (error) {
        apiKeyError = messageFor(error);
      }
    }

    const copied: CopiedReceipt[] = [];
    const copiedHashes = new Set<string>();
    const pendingBatchDuplicates: HashedSource[] = [];
    for (const source of sources) {
      const matches = matchesByHash.get(source.sha256) ?? [];
      const sameInvoice = matches.find((match) => match.invoiceId === invoice.id);
      const otherInvoice = matches.find((match) => match.invoiceId !== invoice.id);
      const blockedMatch =
        sameInvoice ??
        (otherInvoice && !options.allowCrossInvoiceDuplicates ? otherInvoice : undefined);
      if (blockedMatch) {
        duplicates.push({
          path: source.sourcePath,
          filename: source.filename,
          matchInvoiceName: blockedMatch.invoiceName,
          sameInvoice: Boolean(sameInvoice),
        });
        this.progress(
          invoiceId,
          source.current,
          uniquePaths.length,
          source.filename,
          "duplicate",
          `Already imported in ${blockedMatch.invoiceName}`,
          jobId
        );
        continue;
      }

      if (copiedHashes.has(source.sha256)) {
        pendingBatchDuplicates.push(source);
        continue;
      }

      try {
        const next = await this.copyReceipt(
          invoice,
          invoiceFolder,
          source,
          options.method ?? "file-picker",
          apiKey || apiKeyError ? "queued" : "needs-key"
        );
        copied.push(next);
        copiedHashes.add(source.sha256);
      } catch (error) {
        errors.push({ filename: source.filename, message: messageFor(error) });
        this.progress(
          invoiceId,
          source.current,
          uniquePaths.length,
          source.filename,
          "error",
          messageFor(error),
          jobId
        );
      }
    }

    if (copied.length > 0) {
      try {
        await this.invoices.mutateInvoice(invoiceId, (next) => {
          next.receipts.push(...copied.map(({ receipt }) => receipt));
          next.rows.push(...copied.map(({ row }) => row));
        });
      } catch (error) {
        const rollbackMessage = await rollbackCopiedFiles(copied, error);
        for (const source of [...copied.map((item) => item.source), ...pendingBatchDuplicates]) {
          errors.push({ filename: source.filename, message: rollbackMessage });
          this.progress(
            invoiceId,
            source.current,
            uniquePaths.length,
            source.filename,
            "error",
            rollbackMessage,
            jobId
          );
        }
        return {
          invoiceId,
          invoiceFolder,
          total: uniquePaths.length,
          apiKey: null,
          scans: [],
          importedCount: 0,
          duplicates,
          errors,
          jobId,
        };
      }
    }

    for (const source of pendingBatchDuplicates) {
      duplicates.push({
        path: source.sourcePath,
        filename: source.filename,
        matchInvoiceName: invoice.name,
        sameInvoice: true,
      });
      this.progress(
        invoiceId,
        source.current,
        uniquePaths.length,
        source.filename,
        "duplicate",
        `Already imported in ${invoice.name}`,
        jobId
      );
    }

    if (apiKeyError) {
      for (const { source } of copied) {
        errors.push({ filename: source.filename, message: apiKeyError });
        this.progress(
          invoiceId,
          source.current,
          uniquePaths.length,
          source.filename,
          "error",
          apiKeyError,
          jobId
        );
      }
    } else if (!apiKey) {
      for (const { source } of copied) {
        this.progress(
          invoiceId,
          source.current,
          uniquePaths.length,
          source.filename,
          "needs-key",
          "Add an OpenAI key in Settings to scan.",
          jobId
        );
      }
    }

    return {
      invoiceId,
      invoiceFolder,
      total: uniquePaths.length,
      apiKey,
      scans: apiKey ? copied : [],
      importedCount: copied.length,
      duplicates,
      errors,
      jobId,
    };
  }

  private scheduleImportJob(job: ActiveImportJob): void {
    // Enqueue immediately to preserve per-invoice ordering, but yield one event
    // loop turn so the structured start-import response can reach the renderer
    // before scan progress begins.
    const responseGate = new Promise<void>((resolve) => setImmediate(resolve));
    void this.scanOperations
      .run(job.invoiceId, async () => {
        await responseGate;
        if (job.finished) return;
        job.state = "running";
        const status = await this.scanPreparedBatch(job.batch, job.controller.signal);
        this.finishImportJob(job, status);
      })
      .catch(async (error) => {
        if (job.finished) return;
        const resetError = await this.requeueScanningReceipts(job.batch).catch(
          (resetFailure) => resetFailure
        );
        if (job.finished) return;
        const cancelled =
          job.controller.signal.aborted &&
          !(error instanceof ReceiptStateRecoveryError) &&
          !resetError;
        this.finishImportJob(
          job,
          cancelled ? "cancelled" : "failed",
          cancelled
            ? undefined
            : `Receipt import stopped: ${messageFor(error)}${
                resetError ? ` Receipt state recovery also failed: ${messageFor(resetError)}` : ""
              }`
        );
      });
  }

  private finishImportJob(
    job: ActiveImportJob,
    status: "complete" | "cancelled" | "failed",
    message?: string
  ): void {
    if (job.finished) return;
    job.finished = true;
    if (this.activeJobs.get(job.jobId) === job) {
      this.activeJobs.delete(job.jobId);
    }
    const issueCount = job.batch.errors.length;
    this.onProgress({
      jobId: job.jobId,
      invoiceId: job.invoiceId,
      current: status === "complete" ? job.batch.total : job.lastCurrent,
      total: job.batch.total,
      filename: "Receipt import",
      status,
      message:
        message ??
        (status === "cancelled"
          ? "Import cancelled. Unscanned receipts remain queued."
          : status === "failed"
            ? "Receipt import failed."
            : issueCount > 0
              ? `Import complete with ${issueCount} issue${issueCount === 1 ? "" : "s"}.`
              : "Import complete."),
    });
  }

  private async requeueScanningReceipts(batch: PreparedImportBatch): Promise<void> {
    const receiptIds = new Set(batch.scans.map(({ receipt }) => receipt.id));
    if (receiptIds.size === 0) return;
    const current = await this.invoices.loadInvoice(batch.invoiceId);
    if (
      !current.receipts.some(
        (receipt) => receiptIds.has(receipt.id) && receipt.status === "scanning"
      )
    ) {
      return;
    }
    await this.invoices.mutateInvoice(batch.invoiceId, (invoice) => {
      for (const receipt of invoice.receipts) {
        if (!receiptIds.has(receipt.id) || receipt.status !== "scanning") continue;
        receipt.status = "queued";
        delete receipt.error;
      }
    });
  }

  private async copyReceipt(
    invoice: InvoiceDocument,
    invoiceFolder: string,
    source: HashedSource,
    method: "drag-drop" | "file-picker",
    status: ReceiptRecord["status"]
  ): Promise<CopiedReceipt> {
    const receiptId = `rcpt_${crypto.randomUUID()}`;
    const rowId = `row_${crypto.randomUUID()}`;
    const desiredName = managedReceiptFilename(source.sourcePath, source.sha256);
    const storedName = await availableFilename(
      path.join(invoiceFolder, "receipts"),
      desiredName,
      receiptId.slice(-8)
    );
    const relativePath = path.join("receipts", storedName);
    const debugPath = path.join("debug", `${receiptId}.json`);
    const destination = resolveInside(invoiceFolder, relativePath);
    const now = new Date().toISOString();

    const receipt: ReceiptRecord = {
      id: receiptId,
      relativePath,
      debugPath,
      originalFilename: source.filename,
      mimeType: source.mimeType,
      sha256: source.sha256,
      source: { kind: "manual", method },
      status,
      importedAt: now,
    };
    const row: InvoiceRow = {
      id: rowId,
      date: null,
      groceriesMinor: null,
      hours: "",
      rateMinor: invoice.defaultRateMinor,
      comment: humanizeFilename(source.sourcePath),
      receiptId,
    };

    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(source.sourcePath, destination, fsConstants.COPYFILE_EXCL);
    try {
      const copiedSha256 = await sha256File(destination);
      if (copiedSha256 !== source.sha256) {
        throw new Error("The source file changed while it was being imported. Try again.");
      }
    } catch (error) {
      await fs.rm(destination, { force: true });
      throw error;
    }
    return { source, receipt, row, destination };
  }

  /** Run a small provider pool after every accepted file is locally durable. */
  private async scanPreparedBatch(
    batch: PreparedImportBatch,
    signal?: AbortSignal
  ): Promise<"complete" | "cancelled"> {
    if (signal?.aborted) return "cancelled";
    if (!batch.apiKey || batch.scans.length === 0) return "complete";
    let client: ReceiptClient;
    try {
      client = this.createClient(batch.apiKey);
    } catch (error) {
      await this.markReceiptsErrored(
        batch.invoiceId,
        batch.scans.map((item) => ({ receipt: item.receipt, current: item.source.current })),
        batch.total,
        error,
        batch.jobId
      );
      for (const item of batch.scans) {
        batch.errors.push({
          filename: item.source.filename,
          message: messageFor(error),
        });
      }
      return "complete";
    }
    const outcomes = await mapBounded(
      batch.scans,
      RECEIPT_SCAN_CONCURRENCY,
      async (item): Promise<{ cancelled?: true; error?: unknown }> => {
        if (signal?.aborted) return { cancelled: true };
        try {
          await this.scanReceipt(
            batch.invoiceId,
            batch.invoiceFolder,
            item.receipt,
            client,
            item.source.current,
            batch.total,
            signal,
            batch.jobId
          );
          return {};
        } catch (error) {
          if (error instanceof ReceiptStateRecoveryError) throw error;
          if (signal?.aborted || error instanceof ImportCancelledError) {
            return { cancelled: true };
          }
          return { error };
        }
      }
    );
    for (let index = 0; index < outcomes.length; index += 1) {
      const error = outcomes[index].error;
      if (error) {
        batch.errors.push({
          filename: batch.scans[index].source.filename,
          message: messageFor(error),
        });
      }
    }
    if (outcomes.some((outcome) => outcome.cancelled)) return "cancelled";
    // Reaching the end means the last receipt crossed its commit point. An
    // abort that arrived during that write must not misreport durable data as
    // cancelled. Earlier aborts return from the checks/catch paths above.
    return "complete";
  }

  private async scanReceipt(
    invoiceId: string,
    invoiceFolder: string,
    receipt: ReceiptRecord,
    client: ReceiptClient,
    current: number,
    total: number,
    signal?: AbortSignal,
    jobId?: string
  ): Promise<void> {
    const receiptPath = resolveInside(invoiceFolder, receipt.relativePath);
    let scanningStarted = false;
    let debugRollback: DebugRollback | undefined;
    let extractionCommitted = false;
    try {
      const result = await this.providerScans.run(async () => {
        await this.setReceiptState(invoiceId, receipt.id, "scanning");
        scanningStarted = true;
        this.progress(
          invoiceId,
          current,
          total,
          receipt.originalFilename,
          "scanning",
          undefined,
          jobId
        );
        signal?.throwIfAborted();
        let prepared: Awaited<ReturnType<typeof readExtractionInput>> | undefined;
        try {
          prepared = await readExtractionInput(receiptPath);
          signal?.throwIfAborted();
          const extraction = await client.extract(
            prepared.buffer,
            prepared.filename,
            prepared.mimeType,
            signal
          );
          signal?.throwIfAborted();
          return extraction;
        } finally {
          await prepared?.cleanup();
        }
      }, signal);
      signal?.throwIfAborted();
      const warnings = [...result.validationWarnings];
      const groceriesMinor = parseMoneyToMinor(result.extraction.total);
      if (result.extraction.total !== null && groceriesMinor === null) {
        warnings.push("The final total could not be converted to cents.");
      }

      const debug: ReceiptDebug = {
        receiptId: receipt.id,
        provider: "openai",
        model: result.model,
        scannedAt: new Date().toISOString(),
        extraction: result.extraction,
        validationWarnings: warnings,
        usage: result.usage,
      };
      const debugPath = resolveInside(invoiceFolder, receipt.debugPath);
      debugRollback = {
        filePath: debugPath,
        previousContents: await readOptionalFile(debugPath),
      };
      await writeJsonAtomic(debugPath, debug);
      signal?.throwIfAborted();

      // This mutation is the durable extraction commit point. Cancellation is
      // honored immediately above, but once this write is enqueued it wins the
      // race: never discard a successfully committed extraction afterward.
      await this.invoices.mutateInvoice(invoiceId, (next) => {
        const nextReceipt = next.receipts.find((item) => item.id === receipt.id);
        if (!nextReceipt) {
          throw new Error("Receipt was removed while it was scanning.");
        }
        nextReceipt.status = warnings.length > 0 ? "needs-review" : "ready";
        delete nextReceipt.error;
        const row = next.rows.find((item) => item.receiptId === receipt.id);
        if (row) {
          row.date = result.extraction.date;
          row.groceriesMinor = groceriesMinor;
          row.comment = result.extraction.merchant?.trim() || row.comment;
        }
      });
      extractionCommitted = true;
      this.progress(
        invoiceId,
        current,
        total,
        receipt.originalFilename,
        warnings.length > 0 ? "needs-review" : "ready",
        warnings[0],
        jobId
      );
    } catch (error) {
      if (!extractionCommitted && debugRollback) {
        await restoreDebugFile(debugRollback).catch(() => undefined);
      }
      if (signal?.aborted || error instanceof ImportCancelledError) {
        if (scanningStarted) {
          try {
            await this.setReceiptState(invoiceId, receipt.id, "queued");
          } catch (recoveryError) {
            throw new ReceiptStateRecoveryError(receipt.id, "queued", recoveryError);
          }
        }
        throw new ImportCancelledError();
      }
      try {
        await this.invoices.mutateInvoice(invoiceId, (next) => {
          const nextReceipt = next.receipts.find((item) => item.id === receipt.id);
          if (nextReceipt) {
            nextReceipt.status = "error";
            nextReceipt.error = messageFor(error);
          }
        });
      } catch (recoveryError) {
        throw new ReceiptStateRecoveryError(receipt.id, "error", recoveryError);
      }
      this.progress(
        invoiceId,
        current,
        total,
        receipt.originalFilename,
        "error",
        messageFor(error),
        jobId
      );
      throw error;
    }
  }

  private async setReceiptState(
    invoiceId: string,
    receiptId: string,
    status: ReceiptRecord["status"]
  ): Promise<void> {
    await this.invoices.mutateInvoice(invoiceId, (invoice) => {
      const receipt = invoice.receipts.find((item) => item.id === receiptId);
      if (!receipt) {
        throw new Error("Receipt not found.");
      }
      receipt.status = status;
      if (status !== "error") {
        delete receipt.error;
      }
    });
  }

  private async markReceiptsErrored(
    invoiceId: string,
    items: Array<{ receipt: ReceiptRecord; current: number }>,
    total: number,
    error: unknown,
    jobId?: string
  ): Promise<void> {
    const message = messageFor(error);
    const ids = new Set(items.map(({ receipt }) => receipt.id));
    await this.invoices.mutateInvoice(invoiceId, (invoice) => {
      for (const receipt of invoice.receipts) {
        if (!ids.has(receipt.id)) continue;
        receipt.status = "error";
        receipt.error = message;
      }
    });
    for (const { receipt, current } of items) {
      this.progress(invoiceId, current, total, receipt.originalFilename, "error", message, jobId);
    }
  }

  private progress(
    invoiceId: string,
    current: number,
    total: number,
    filename: string,
    status: ImportProgress["status"],
    message?: string,
    jobId?: string
  ): void {
    const job = jobId ? this.activeJobs.get(jobId) : undefined;
    if (job) job.lastCurrent = Math.max(job.lastCurrent, current);
    this.onProgress({
      ...(jobId ? { jobId } : {}),
      invoiceId,
      current: job?.lastCurrent ?? current,
      total,
      filename,
      status,
      message,
    });
  }

  private async validateSource(sourcePath: string): Promise<string> {
    const mimeType = mimeTypeForPath(sourcePath);
    if (!mimeType) {
      throw new Error("Unsupported file. Use JPEG, PNG, WebP, HEIC/HEIF, or PDF.");
    }
    const stat = await fs.stat(sourcePath);
    if (!stat.isFile()) {
      throw new Error("The selected path is not a file.");
    }
    if (stat.size === 0) {
      throw new Error("The selected file is empty.");
    }
    if (stat.size > MAX_RECEIPT_FILE_BYTES) {
      throw new Error(
        `The selected receipt exceeds the ${MAX_RECEIPT_FILE_SIZE_LABEL} safe processing limit.`
      );
    }
    return mimeType;
  }
}

async function readOptionalFile(filePath: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(filePath);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return null;
    throw error;
  }
}

async function restoreDebugFile({ filePath, previousContents }: DebugRollback): Promise<void> {
  if (previousContents === null) {
    await fs.rm(filePath, { force: true });
    return;
  }
  await atomicWriteFile(filePath, previousContents, { mode: 0o600 });
}

async function rollbackCopiedFiles(copied: CopiedReceipt[], cause: unknown): Promise<string> {
  const results = await Promise.allSettled(
    copied.map(({ destination }) => fs.rm(destination, { force: true }))
  );
  const cleanupFailures = results.filter((result) => result.status === "rejected").length;
  const message = messageFor(cause);
  return cleanupFailures === 0
    ? message
    : `${message} Could not remove ${cleanupFailures} copied file${cleanupFailures === 1 ? "" : "s"}; inspect the invoice receipts folder.`;
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
