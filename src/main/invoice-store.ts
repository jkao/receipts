import { randomUUID } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";

import { normalizeHours } from "../shared/finance";
import { invoiceToCsv, invoiceToTsv } from "../shared/tabular";
import {
  INVOICE_DELETION_SCHEMA_VERSION,
  INVOICE_SCHEMA_VERSION,
  type ImportMethod,
  type InvoiceDeletionSentinel,
  type InvoiceDocument,
  type InvoicePeriod,
  type InvoiceRemovalResult,
  type InvoiceReviewAcknowledgement,
  type InvoiceRow,
  type InvoiceSummary,
  type ReceiptRecord,
  type ReceiptStatus,
  type RemoveInvoiceOptions,
  type SourceKind,
} from "../shared/types";

export type BaseFolderGetter = () => string | null | undefined | Promise<string | null | undefined>;

export interface InvoiceStoreOptions {
  getDefaultRateMinor?: () => number | Promise<number>;
  now?: () => Date;
  idFactory?: () => string;
}

export interface InvoiceHashMatch {
  invoiceId: string;
  invoiceName: string;
  receiptId: string;
  relativePath: string;
}

export type InvoiceMutator = (
  draft: InvoiceDocument
) => undefined | InvoiceDocument | Promise<undefined | InvoiceDocument>;

interface DiscoveredInvoice {
  folder: string;
  invoice: InvoiceDocument;
}

const RECEIPT_STATUSES = new Set<ReceiptStatus>([
  "needs-key",
  "queued",
  "scanning",
  "ready",
  "needs-review",
  "error",
]);
const IMPORT_METHODS = new Set<ImportMethod>(["drag-drop", "file-picker", "folder", "watcher"]);
const SOURCE_KINDS = new Set<SourceKind>(["manual", "automation"]);

export class RevisionConflictError extends Error {
  readonly invoiceId: string;
  readonly expectedRevision: number;
  readonly actualRevision: number;

  constructor(invoiceId: string, expectedRevision: number, actualRevision: number) {
    super(
      `Invoice ${invoiceId} changed: expected revision ${expectedRevision}, ` +
        `found ${actualRevision}`
    );
    this.name = "RevisionConflictError";
    this.invoiceId = invoiceId;
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

export class InvoiceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvoiceValidationError";
  }
}

export class InvoiceNotFoundError extends Error {
  constructor(invoiceId: string) {
    super(`Invoice not found: ${invoiceId}`);
    this.name = "InvoiceNotFoundError";
  }
}

export class InvoiceDeletedError extends Error {
  readonly invoiceId: string;
  readonly invoiceName: string;
  readonly deletedAt: string;

  constructor(deletion: InvoiceDeletionSentinel) {
    super(
      deletion.hardDeleteIncomplete
        ? `${deletion.invoiceName} has an incomplete permanent deletion recorded in ` +
            "DELETED.json. Some local files may already be missing; inspect the folder before " +
            "removing the marker."
        : `${deletion.invoiceName} is marked deleted by DELETED.json. ` +
            "Remove DELETED.json from its folder to recover the local invoice files."
    );
    this.name = "InvoiceDeletedError";
    this.invoiceId = deletion.invoiceId;
    this.invoiceName = deletion.invoiceName;
    this.deletedAt = deletion.deletedAt;
  }
}

export class BaseFolderNotConfiguredError extends Error {
  constructor() {
    super("Choose a base folder before working with invoices");
    this.name = "BaseFolderNotConfiguredError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw new InvoiceValidationError(`${label} must be a string`);
  }
  return value;
}

function nullableString(value: unknown, label: string): string | null {
  if (value === null) {
    return null;
  }
  return requiredString(value, label);
}

function safeInteger(value: unknown, label: string, minimum?: number): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    (minimum !== undefined && value < minimum)
  ) {
    throw new InvoiceValidationError(`${label} must be a safe integer`);
  }
  return value;
}

function nullableSafeInteger(value: unknown, label: string): number | null {
  return value === null ? null : safeInteger(value, label);
}

function canonicalIsoTimestamp(value: unknown, label: string): string {
  const timestamp = requiredString(value, label);
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== timestamp) {
    throw new InvoiceValidationError(`${label} must use canonical ISO-8601 format`);
  }
  return timestamp;
}

export function validateInvoiceDeletionSentinel(value: unknown): InvoiceDeletionSentinel {
  if (!isRecord(value)) {
    throw new InvoiceValidationError("DELETED.json must contain an object");
  }
  if (value.schemaVersion !== INVOICE_DELETION_SCHEMA_VERSION) {
    throw new InvoiceValidationError(
      `Unsupported DELETED.json schema version: ${String(value.schemaVersion)}`
    );
  }
  if (value.hardDeleteIncomplete !== undefined && typeof value.hardDeleteIncomplete !== "boolean") {
    throw new InvoiceValidationError("DELETED.json hard-delete state must be a boolean");
  }
  return {
    schemaVersion: INVOICE_DELETION_SCHEMA_VERSION,
    invoiceId: requiredString(value.invoiceId, "DELETED.json invoice id"),
    invoiceName: requiredString(value.invoiceName, "DELETED.json invoice name"),
    lastRevision: safeInteger(value.lastRevision, "DELETED.json last revision", 0),
    deletedAt: canonicalIsoTimestamp(value.deletedAt, "DELETED.json deletion timestamp"),
    ...(value.hardDeleteIncomplete === undefined
      ? {}
      : { hardDeleteIncomplete: value.hardDeleteIncomplete }),
  };
}

function receiptSha256(value: unknown, label: string): string {
  const sha256 = requiredString(value, label);
  if (!/^[0-9a-f]{64}$/i.test(sha256)) {
    throw new InvoiceValidationError(`${label} must be a 64-character hexadecimal value`);
  }
  return sha256.toLowerCase();
}

function validateReviewAcknowledgement(
  value: unknown,
  index: number
): InvoiceReviewAcknowledgement {
  const label = `Review acknowledgement ${index + 1}`;
  if (!isRecord(value)) {
    throw new InvoiceValidationError(`${label} must be an object`);
  }
  const fingerprint = requiredString(value.fingerprint, `${label} fingerprint`);
  if (!/^[0-9a-f]{64}$/.test(fingerprint)) {
    throw new InvoiceValidationError(`${label} fingerprint must be a lowercase SHA-256 value`);
  }
  const acknowledgedAt = canonicalIsoTimestamp(value.acknowledgedAt, `${label} timestamp`);
  return { fingerprint, acknowledgedAt };
}

function managedRelativePath(
  value: unknown,
  requiredDirectory: "receipts" | "debug",
  label: string
): string {
  const candidate = requiredString(value, label);
  if (candidate.includes("\0") || path.isAbsolute(candidate)) {
    throw new InvoiceValidationError(`${label} must be a relative managed path`);
  }
  const normalized = path.normalize(candidate);
  const relative = path.relative(requiredDirectory, normalized);
  if (
    relative === "" ||
    relative.startsWith(`..${path.sep}`) ||
    relative === ".." ||
    path.isAbsolute(relative)
  ) {
    throw new InvoiceValidationError(`${label} must stay inside ${requiredDirectory}/`);
  }
  return normalized;
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function validatePeriod(value: unknown, label = "Invoice period"): InvoicePeriod {
  if (!isRecord(value)) {
    throw new InvoiceValidationError(`${label} must be an object`);
  }
  const startDate = requiredString(value.startDate, `${label} start date`);
  const endDate = requiredString(value.endDate, `${label} end date`);
  if (!isIsoDate(startDate) || !isIsoDate(endDate)) {
    throw new InvoiceValidationError(`${label} dates must use valid YYYY-MM-DD values`);
  }
  if (startDate > endDate) {
    throw new InvoiceValidationError(`${label} start date must not follow its end date`);
  }
  return { startDate, endDate };
}

function validateRow(value: unknown, index: number): InvoiceRow {
  const label = `Invoice row ${index + 1}`;
  if (!isRecord(value)) {
    throw new InvoiceValidationError(`${label} must be an object`);
  }

  const date = nullableString(value.date, `${label} date`);
  if (date !== null && !isIsoDate(date)) {
    throw new InvoiceValidationError(`${label} date must use YYYY-MM-DD`);
  }
  const hours = requiredString(value.hours, `${label} hours`, true);
  try {
    normalizeHours(hours);
  } catch (error) {
    throw new InvoiceValidationError(
      `${label} hours are invalid: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  return {
    id: requiredString(value.id, `${label} id`),
    date,
    groceriesMinor: nullableSafeInteger(value.groceriesMinor, `${label} groceries amount`),
    hours,
    rateMinor: nullableSafeInteger(value.rateMinor, `${label} rate`),
    comment: requiredString(value.comment, `${label} comment`, true),
    receiptId: nullableString(value.receiptId, `${label} receipt id`),
  };
}

function validateReceipt(value: unknown, index: number): ReceiptRecord {
  const label = `Receipt ${index + 1}`;
  if (!isRecord(value) || !isRecord(value.source)) {
    throw new InvoiceValidationError(`${label} must be an object with a source`);
  }

  const kind = requiredString(value.source.kind, `${label} source kind`) as SourceKind;
  const method = requiredString(value.source.method, `${label} import method`) as ImportMethod;
  const status = requiredString(value.status, `${label} status`) as ReceiptStatus;
  if (!SOURCE_KINDS.has(kind) || !IMPORT_METHODS.has(method)) {
    throw new InvoiceValidationError(`${label} has invalid source metadata`);
  }
  if (!RECEIPT_STATUSES.has(status)) {
    throw new InvoiceValidationError(`${label} has an invalid status`);
  }

  const receipt: ReceiptRecord = {
    id: requiredString(value.id, `${label} id`),
    relativePath: managedRelativePath(value.relativePath, "receipts", `${label} relative path`),
    debugPath: managedRelativePath(value.debugPath, "debug", `${label} debug path`),
    originalFilename: requiredString(value.originalFilename, `${label} original filename`),
    mimeType: requiredString(value.mimeType, `${label} MIME type`),
    sha256: receiptSha256(value.sha256, `${label} SHA-256`),
    source: { kind, method },
    status,
    importedAt: canonicalIsoTimestamp(value.importedAt, `${label} imported at`),
  };
  if (value.error !== undefined) {
    receipt.error = requiredString(value.error, `${label} error`, true);
  }
  return receipt;
}

export function validateInvoiceDocument(value: unknown): InvoiceDocument {
  if (!isRecord(value)) {
    throw new InvoiceValidationError("Invoice JSON must contain an object");
  }
  if (value.schemaVersion !== INVOICE_SCHEMA_VERSION) {
    throw new InvoiceValidationError(
      `Unsupported invoice schema version: ${String(value.schemaVersion)}`
    );
  }
  if (!Array.isArray(value.rows) || !Array.isArray(value.receipts)) {
    throw new InvoiceValidationError("Invoice rows and receipts must be arrays");
  }

  const rows = value.rows.map(validateRow);
  const receipts = value.receipts.map(validateReceipt);
  const reviewAcknowledgements =
    value.reviewAcknowledgements === undefined
      ? []
      : Array.isArray(value.reviewAcknowledgements)
        ? value.reviewAcknowledgements.map(validateReviewAcknowledgement)
        : (() => {
            throw new InvoiceValidationError("Invoice review acknowledgements must be an array");
          })();
  if (new Set(rows.map((row) => row.id)).size !== rows.length) {
    throw new InvoiceValidationError("Invoice row IDs must be unique");
  }
  if (new Set(receipts.map((receipt) => receipt.id)).size !== receipts.length) {
    throw new InvoiceValidationError("Receipt IDs must be unique");
  }
  if (
    new Set(reviewAcknowledgements.map(({ fingerprint }) => fingerprint)).size !==
    reviewAcknowledgements.length
  ) {
    throw new InvoiceValidationError("Invoice review acknowledgement fingerprints must be unique");
  }
  if (
    new Set(receipts.map((receipt) => receipt.relativePath)).size !== receipts.length ||
    new Set(receipts.map((receipt) => receipt.debugPath)).size !== receipts.length
  ) {
    throw new InvoiceValidationError("Managed receipt and debug paths must be unique");
  }
  const receiptIds = new Set(receipts.map((receipt) => receipt.id));
  const rowReceiptIds = rows
    .map((row) => row.receiptId)
    .filter((receiptId): receiptId is string => receiptId !== null);
  if (new Set(rowReceiptIds).size !== rowReceiptIds.length) {
    throw new InvoiceValidationError("A receipt can belong to only one invoice row");
  }
  if (rowReceiptIds.some((receiptId) => !receiptIds.has(receiptId))) {
    throw new InvoiceValidationError("Invoice rows cannot reference missing receipts");
  }
  if (value.currency !== "USD") {
    throw new InvoiceValidationError("Invoice currency must be USD");
  }

  return {
    schemaVersion: INVOICE_SCHEMA_VERSION,
    id: requiredString(value.id, "Invoice id"),
    name: requiredString(value.name, "Invoice name"),
    period: validatePeriod(value.period),
    defaultRateMinor: safeInteger(value.defaultRateMinor, "Default rate", 0),
    currency: "USD",
    revision: safeInteger(value.revision, "Invoice revision", 0),
    rows,
    receipts,
    reviewAcknowledgements,
    createdAt: canonicalIsoTimestamp(value.createdAt, "Invoice created timestamp"),
    updatedAt: canonicalIsoTimestamp(value.updatedAt, "Invoice updated timestamp"),
  };
}

function cloneInvoice(invoice: InvoiceDocument): InvoiceDocument {
  return structuredClone(invoice);
}

function isErrno(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

async function exists(filename: string): Promise<boolean> {
  try {
    await fs.access(filename, fsConstants.F_OK);
    return true;
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(directory, "r");
    await handle.sync();
  } catch (error) {
    // Directory fsync is not available on every platform/filesystem. The files
    // themselves have already been synced, so only ignore those platform cases.
    if (
      !isErrno(error, "EINVAL") &&
      !isErrno(error, "ENOTSUP") &&
      !isErrno(error, "EISDIR") &&
      !isErrno(error, "EBADF")
    ) {
      throw error;
    }
  } finally {
    await handle?.close();
  }
}

async function atomicWriteFile(
  filename: string,
  contents: string | Buffer,
  options: { mode: number; retainBackup?: boolean }
): Promise<void> {
  const directory = path.dirname(filename);
  const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  await fs.mkdir(directory, { recursive: true });

  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  let renamed = false;
  try {
    handle = await fs.open(temporary, "wx", options.mode);
    await handle.chmod(options.mode);
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    handle = undefined;

    if (options.retainBackup && (await exists(filename))) {
      const previous = await fs.readFile(filename);
      await atomicWriteFile(`${filename}.bak`, previous, { mode: options.mode });
    }

    await fs.rename(temporary, filename);
    renamed = true;
    // The rename is the caller-visible commit point. A directory-sync failure
    // can make crash durability uncertain, but must not turn a committed write
    // into a reported failure that causes higher-level file rollbacks.
    await syncDirectory(directory).catch(() => undefined);
  } finally {
    await handle?.close();
    if (!renamed) {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}

async function ensureOrdinaryDirectory(directory: string, label: string): Promise<void> {
  try {
    const metadata = await fs.lstat(directory);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new InvoiceValidationError(`${label} must be an ordinary directory`);
    }
  } catch (error) {
    if (!isErrno(error, "ENOENT")) {
      throw error;
    }
    await fs.mkdir(directory, { recursive: true });
    const metadata = await fs.lstat(directory);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new InvoiceValidationError(`${label} must be an ordinary directory`);
    }
  }
}

function invoiceFolderName(period: InvoicePeriod): string {
  return `invoice-${period.startDate}-${period.endDate}`;
}

function validateRemoveInvoiceOptions(value: unknown): Required<RemoveInvoiceOptions> {
  if (!isRecord(value)) {
    throw new InvoiceValidationError("Invoice removal options must be an object");
  }
  if (value.hardDelete !== undefined && typeof value.hardDelete !== "boolean") {
    throw new InvoiceValidationError("Hard delete must be a boolean");
  }
  return {
    expectedRevision: safeInteger(value.expectedRevision, "Expected revision", 0),
    hardDelete: value.hardDelete ?? false,
  };
}

function deletionWarning(): string {
  return (
    "Permanent deletion could not be completed. Some local files may already be missing; " +
    "anything remaining stays hidden by DELETED.json and can be inspected manually."
  );
}

export class InvoiceStore {
  private readonly queues = new Map<string, Promise<void>>();
  private admissionTail: Promise<void> = Promise.resolve();
  private readonly now: () => Date;
  private readonly idFactory: () => string;

  constructor(
    private readonly getBaseFolderValue: BaseFolderGetter,
    private readonly options: InvoiceStoreOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? (() => `inv_${randomUUID()}`);
  }

  private async baseFolder(): Promise<string> {
    const configured = await this.getBaseFolderValue();
    if (typeof configured !== "string" || configured.trim() === "") {
      throw new BaseFolderNotConfiguredError();
    }
    const resolved = path.resolve(configured);
    let metadata: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      metadata = await fs.lstat(resolved);
    } catch (error) {
      if (isErrno(error, "ENOENT")) {
        throw new InvoiceValidationError(
          "The invoice base folder is unavailable. Reconnect it or choose it again."
        );
      }
      throw error;
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new InvoiceValidationError("The invoice base folder must be an ordinary directory");
    }
    return resolved;
  }

  private enqueue<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined
    );
    this.queues.set(key, tail);
    return result.finally(() => {
      if (this.queues.get(key) === tail) {
        this.queues.delete(key);
      }
    });
  }

  private invoiceQueueKey(folder: string): string {
    return `invoice:${path.resolve(folder)}`;
  }

  /**
   * Resolve caller-facing ID/name aliases in invocation order, then hand the
   * operation to the canonical per-folder queue. Only alias resolution is
   * globally serialized; operations for different invoices still run in
   * parallel once admitted.
   */
  private enqueueByInvoiceAlias<T>(
    invoiceId: string,
    operation: (folder: string) => Promise<T>
  ): Promise<T> {
    let queued: Promise<T> | undefined;
    const admission = this.admissionTail
      .catch(() => undefined)
      .then(async () => {
        const { folder } = await this.findInvoice(invoiceId);
        queued = this.enqueue(this.invoiceQueueKey(folder), () => operation(folder));
      });
    this.admissionTail = admission.then(
      () => undefined,
      () => undefined
    );
    return admission.then(() => {
      if (!queued) {
        throw new InvoiceNotFoundError(invoiceId);
      }
      return queued;
    });
  }

  private async readDeletionSentinel(folder: string): Promise<InvoiceDeletionSentinel | null> {
    const filename = path.join(folder, "DELETED.json");
    let metadata: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      metadata = await fs.lstat(filename);
    } catch (error) {
      if (isErrno(error, "ENOENT")) {
        return null;
      }
      throw error;
    }
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new InvoiceValidationError(`DELETED.json must be an ordinary file: ${filename}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(await fs.readFile(filename, "utf8"));
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new InvoiceValidationError(`Invalid JSON in ${filename}: ${error.message}`);
      }
      throw error;
    }
    const deletion = validateInvoiceDeletionSentinel(parsed);
    if (deletion.invoiceName !== path.basename(folder)) {
      throw new InvoiceValidationError(
        `DELETED.json invoice name does not match folder ${path.basename(folder)}`
      );
    }
    return deletion;
  }

  private async readInvoiceFile(folder: string): Promise<InvoiceDocument> {
    const deletion = await this.readDeletionSentinel(folder);
    if (deletion) {
      throw new InvoiceDeletedError(deletion);
    }
    const filename = path.join(folder, "invoice.json");
    let parsed: unknown;
    try {
      const metadata = await fs.lstat(filename);
      if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw new InvoiceValidationError(`Invoice JSON must be an ordinary file: ${filename}`);
      }
      parsed = JSON.parse(await fs.readFile(filename, "utf8"));
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new InvoiceValidationError(`Invalid JSON in ${filename}: ${error.message}`);
      }
      throw error;
    }
    const invoice = validateInvoiceDocument(parsed);
    const folderName = path.basename(folder);
    if (invoice.name !== folderName || invoice.name !== invoiceFolderName(invoice.period)) {
      throw new InvoiceValidationError(`Invoice name and period do not match folder ${folderName}`);
    }
    return invoice;
  }

  private async discoverInvoices(): Promise<DiscoveredInvoice[]> {
    const base = await this.baseFolder();
    const entries = await fs.readdir(base, { withFileTypes: true });
    const discovered: DiscoveredInvoice[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const folder = path.join(base, entry.name);
      try {
        if (await this.readDeletionSentinel(folder)) {
          continue;
        }
        if (!(await exists(path.join(folder, "invoice.json")))) {
          continue;
        }
        discovered.push({ folder, invoice: await this.readInvoiceFile(folder) });
      } catch (error) {
        // A corrupt or future-version invoice should not hide every healthy
        // invoice from the picker. Loading its folder directly still surfaces it.
        if (!(error instanceof InvoiceValidationError)) {
          throw error;
        }
      }
    }
    return discovered;
  }

  private async findInvoice(invoiceId: string): Promise<DiscoveredInvoice> {
    const base = await this.baseFolder();
    const directFolder = path.join(base, invoiceId);
    if (path.dirname(directFolder) === base) {
      const deletion = await this.readDeletionSentinel(directFolder);
      if (deletion && (deletion.invoiceId === invoiceId || deletion.invoiceName === invoiceId)) {
        throw new InvoiceDeletedError(deletion);
      }
      if (await exists(path.join(directFolder, "invoice.json"))) {
        const invoice = await this.readInvoiceFile(directFolder);
        if (invoice.id === invoiceId || invoice.name === invoiceId) {
          return { folder: directFolder, invoice };
        }
      }
    }

    const match = (await this.discoverInvoices()).find(
      ({ invoice }) => invoice.id === invoiceId || invoice.name === invoiceId
    );
    if (match) {
      return match;
    }

    const entries = await fs.readdir(base, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const deletion = await this.readDeletionSentinel(path.join(base, entry.name));
      if (deletion?.invoiceId === invoiceId || deletion?.invoiceName === invoiceId) {
        throw new InvoiceDeletedError(deletion);
      }
    }
    throw new InvoiceNotFoundError(invoiceId);
  }

  private async writeViews(folder: string, invoice: InvoiceDocument): Promise<void> {
    const exportOptions = { includeHeaders: true, includeTotals: true } as const;
    const results = await Promise.allSettled([
      atomicWriteFile(path.join(folder, "invoice.tsv"), invoiceToTsv(invoice, exportOptions), {
        mode: 0o644,
      }),
      atomicWriteFile(path.join(folder, "invoice.csv"), invoiceToCsv(invoice, exportOptions), {
        mode: 0o644,
      }),
    ]);
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : []
    );
    if (failures.length === 1) {
      throw failures[0];
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, "Could not regenerate invoice views");
    }
  }

  private async writeInvoice(folder: string, invoice: InvoiceDocument): Promise<void> {
    const json = `${JSON.stringify(invoice, null, 2)}\n`;
    // invoice.json is authoritative. Write the replaceable views first so a
    // rejected operation always leaves the authoritative revision unchanged.
    await this.writeViews(folder, invoice);
    await atomicWriteFile(path.join(folder, "invoice.json"), json, {
      mode: 0o600,
      retainBackup: true,
    });
  }

  private async ensureInvoiceDirectories(folder: string): Promise<void> {
    await ensureOrdinaryDirectory(folder, "Invoice folder");
    await Promise.all(
      ["receipts", "debug", ".trash"].map((name) =>
        ensureOrdinaryDirectory(path.join(folder, name), `${name} directory`)
      )
    );
  }

  private async canonicalInvoiceFolderForRemoval(
    folder: string,
    invoice: InvoiceDocument
  ): Promise<{ base: string; folder: string }> {
    const base = await this.baseFolder();
    const resolvedFolder = path.resolve(folder);
    if (
      resolvedFolder === base ||
      path.dirname(resolvedFolder) !== base ||
      path.basename(resolvedFolder) !== invoice.name
    ) {
      throw new InvoiceValidationError("Refusing to remove a path outside the invoice base folder");
    }

    const metadata = await fs.lstat(resolvedFolder);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new InvoiceValidationError("Invoice removal requires an ordinary invoice folder");
    }
    const [canonicalBase, canonicalFolder] = await Promise.all([
      fs.realpath(base),
      fs.realpath(resolvedFolder),
    ]);
    if (
      canonicalFolder === canonicalBase ||
      path.dirname(canonicalFolder) !== canonicalBase ||
      path.basename(canonicalFolder) !== invoice.name
    ) {
      throw new InvoiceValidationError(
        "Refusing to remove a non-canonical invoice folder or symbolic link"
      );
    }

    const rechecked = await fs.lstat(resolvedFolder);
    if (
      rechecked.isSymbolicLink() ||
      !rechecked.isDirectory() ||
      rechecked.dev !== metadata.dev ||
      rechecked.ino !== metadata.ino
    ) {
      throw new InvoiceValidationError("The invoice folder changed during removal");
    }
    return { base: canonicalBase, folder: canonicalFolder };
  }

  private async hardDeleteMarkedFolder(
    canonicalBase: string,
    canonicalFolder: string,
    deletion: InvoiceDeletionSentinel
  ): Promise<boolean> {
    const sentinelPath = path.join(canonicalFolder, "DELETED.json");
    try {
      const metadata = await fs.lstat(canonicalFolder);
      const realFolder = await fs.realpath(canonicalFolder);
      if (
        metadata.isSymbolicLink() ||
        !metadata.isDirectory() ||
        realFolder !== canonicalFolder ||
        path.dirname(realFolder) !== canonicalBase ||
        path.basename(realFolder) !== deletion.invoiceName
      ) {
        return false;
      }

      const entries = await fs.readdir(canonicalFolder);
      const removableEntries = entries.filter(
        (entry) => entry !== "DELETED.json" && entry !== "invoice.json"
      );
      if (entries.includes("invoice.json")) {
        removableEntries.push("invoice.json");
      }

      for (const entry of removableEntries) {
        const child = path.join(canonicalFolder, entry);
        if (path.dirname(child) !== canonicalFolder) {
          throw new InvoiceValidationError("Refusing to remove an unsafe invoice child path");
        }
        const metadata = await fs.lstat(child);
        if (metadata.isSymbolicLink()) {
          await fs.unlink(child);
        } else {
          await fs.rm(child, { recursive: true, force: false });
        }
      }

      await fs.unlink(sentinelPath);
      try {
        await fs.rmdir(canonicalFolder);
      } catch {
        return this.restoreDeletionSentinelOrConfirmRemoved(
          canonicalBase,
          canonicalFolder,
          deletion
        );
      }
      await syncDirectory(canonicalBase).catch(() => undefined);
      return true;
    } catch {
      return this.restoreDeletionSentinelOrConfirmRemoved(canonicalBase, canonicalFolder, deletion);
    }
  }

  private async restoreDeletionSentinelOrConfirmRemoved(
    canonicalBase: string,
    canonicalFolder: string,
    deletion: InvoiceDeletionSentinel
  ): Promise<boolean> {
    let metadata: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      metadata = await fs.lstat(canonicalFolder);
    } catch (error) {
      return isErrno(error, "ENOENT");
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      return false;
    }

    try {
      const realFolder = await fs.realpath(canonicalFolder);
      if (
        realFolder !== canonicalFolder ||
        path.dirname(realFolder) !== canonicalBase ||
        path.basename(realFolder) !== deletion.invoiceName
      ) {
        return false;
      }
      await atomicWriteFile(
        path.join(realFolder, "DELETED.json"),
        `${JSON.stringify(deletion, null, 2)}\n`,
        { mode: 0o600 }
      );
    } catch {
      // Never follow a replacement folder or link merely to restore the marker.
    }
    return false;
  }

  async listInvoices(): Promise<InvoiceSummary[]> {
    const invoices = await this.discoverInvoices();
    return invoices
      .map(({ invoice }) => ({
        id: invoice.id,
        name: invoice.name,
        period: { ...invoice.period },
        rowCount: invoice.rows.length,
        receiptCount: invoice.receipts.length,
        updatedAt: invoice.updatedAt,
      }))
      .sort(
        (left, right) =>
          right.period.startDate.localeCompare(left.period.startDate) ||
          right.updatedAt.localeCompare(left.updatedAt) ||
          left.name.localeCompare(right.name)
      );
  }

  async createInvoice(
    periodValue: InvoicePeriod,
    defaultRateMinor?: number
  ): Promise<InvoiceDocument> {
    const period = validatePeriod(periodValue);
    const name = invoiceFolderName(period);
    const base = await this.baseFolder();
    const folder = path.join(base, name);

    return this.enqueue(this.invoiceQueueKey(folder), async () => {
      if (await exists(folder)) {
        await ensureOrdinaryDirectory(folder, "Invoice folder");
        const deletion = await this.readDeletionSentinel(folder);
        if (deletion) {
          throw new InvoiceDeletedError(deletion);
        }
      }
      const invoiceFilename = path.join(folder, "invoice.json");
      if (await exists(invoiceFilename)) {
        const existing = await this.readInvoiceFile(folder);
        if (
          existing.name !== name ||
          existing.period.startDate !== period.startDate ||
          existing.period.endDate !== period.endDate
        ) {
          throw new InvoiceValidationError(`Existing ${name} contains a different invoice period`);
        }
        await this.ensureInvoiceDirectories(folder);
        await this.writeViews(folder, existing);
        return cloneInvoice(existing);
      }

      if (await exists(folder)) {
        const contents = await fs.readdir(folder);
        if (contents.length > 0) {
          throw new InvoiceValidationError(
            `Cannot create ${name}: the folder exists without invoice.json`
          );
        }
      }

      const configuredRate =
        defaultRateMinor ??
        (this.options.getDefaultRateMinor ? await this.options.getDefaultRateMinor() : 4500);
      safeInteger(configuredRate, "Default rate", 0);
      const timestamp = this.now().toISOString();
      const invoice: InvoiceDocument = {
        schemaVersion: INVOICE_SCHEMA_VERSION,
        id: this.idFactory(),
        name,
        period,
        defaultRateMinor: configuredRate,
        currency: "USD",
        revision: 0,
        rows: [],
        receipts: [],
        reviewAcknowledgements: [],
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const validated = validateInvoiceDocument(invoice);

      await fs.mkdir(folder, { recursive: true });
      await this.ensureInvoiceDirectories(folder);
      await this.writeInvoice(folder, validated);
      return cloneInvoice(validated);
    });
  }

  async loadInvoice(invoiceId: string): Promise<InvoiceDocument> {
    return this.enqueueByInvoiceAlias(invoiceId, async (folder) => {
      const current = await this.readInvoiceFile(folder);
      await this.ensureInvoiceDirectories(folder);
      await this.writeViews(folder, current);
      return cloneInvoice(current);
    });
  }

  async removeInvoice(
    invoiceId: string,
    optionsValue: RemoveInvoiceOptions
  ): Promise<InvoiceRemovalResult> {
    const validatedInvoiceId = requiredString(invoiceId, "Invoice id");
    const options = validateRemoveInvoiceOptions(optionsValue);
    return this.enqueueByInvoiceAlias(validatedInvoiceId, async (folder) => {
      const current = await this.readInvoiceFile(folder);
      if (current.revision !== options.expectedRevision) {
        throw new RevisionConflictError(current.id, options.expectedRevision, current.revision);
      }

      const canonical = await this.canonicalInvoiceFolderForRemoval(folder, current);
      const deletion: InvoiceDeletionSentinel = {
        schemaVersion: INVOICE_DELETION_SCHEMA_VERSION,
        invoiceId: current.id,
        invoiceName: current.name,
        lastRevision: current.revision,
        deletedAt: this.now().toISOString(),
        ...(options.hardDelete ? { hardDeleteIncomplete: true } : {}),
      };
      await atomicWriteFile(
        path.join(canonical.folder, "DELETED.json"),
        `${JSON.stringify(deletion, null, 2)}\n`,
        { mode: 0o600 }
      );

      if (!options.hardDelete) {
        return {
          invoiceId: current.id,
          invoiceName: current.name,
          mode: "soft",
          deletedAt: deletion.deletedAt,
        };
      }

      let rechecked: { base: string; folder: string };
      try {
        rechecked = await this.canonicalInvoiceFolderForRemoval(folder, current);
      } catch {
        return {
          invoiceId: current.id,
          invoiceName: current.name,
          mode: "soft",
          deletedAt: deletion.deletedAt,
          warning: deletionWarning(),
        };
      }
      const hardDeleted = await this.hardDeleteMarkedFolder(
        rechecked.base,
        rechecked.folder,
        deletion
      );
      return {
        invoiceId: current.id,
        invoiceName: current.name,
        mode: hardDeleted ? "hard" : "soft",
        deletedAt: deletion.deletedAt,
        ...(hardDeleted ? {} : { warning: deletionWarning() }),
      };
    });
  }

  async saveRows(
    invoiceId: string,
    rows: InvoiceRow[],
    expectedRevision: number
  ): Promise<InvoiceDocument> {
    const rowsSnapshot = structuredClone(rows);
    return this.mutateInvoice(
      invoiceId,
      (draft) => {
        draft.rows = rowsSnapshot;
      },
      expectedRevision
    );
  }

  async mutateInvoice(
    invoiceId: string,
    mutator: InvoiceMutator,
    expectedRevision?: number
  ): Promise<InvoiceDocument> {
    if (expectedRevision !== undefined) {
      safeInteger(expectedRevision, "Expected revision", 0);
    }
    return this.enqueueByInvoiceAlias(invoiceId, async (folder) => {
      const current = await this.readInvoiceFile(folder);
      if (expectedRevision !== undefined && current.revision !== expectedRevision) {
        throw new RevisionConflictError(current.id, expectedRevision, current.revision);
      }

      const draft = cloneInvoice(current);
      const returned = await mutator(draft);
      const candidate = validateInvoiceDocument(returned ?? draft);
      candidate.schemaVersion = INVOICE_SCHEMA_VERSION;
      candidate.id = current.id;
      candidate.name = current.name;
      candidate.period = { ...current.period };
      candidate.createdAt = current.createdAt;
      candidate.revision = safeInteger(current.revision + 1, "Invoice revision", 0);
      candidate.updatedAt = this.now().toISOString();

      await this.writeInvoice(folder, candidate);
      return cloneInvoice(candidate);
    });
  }

  async runAtRevision<T>(
    invoiceId: string,
    expectedRevision: number,
    operation: (invoice: InvoiceDocument, invoiceFolder: string) => T | Promise<T>
  ): Promise<T> {
    safeInteger(expectedRevision, "Expected revision", 0);
    return this.enqueueByInvoiceAlias(invoiceId, async (folder) => {
      const current = await this.readInvoiceFile(folder);
      if (current.revision !== expectedRevision) {
        throw new RevisionConflictError(current.id, expectedRevision, current.revision);
      }
      return operation(cloneInvoice(current), folder);
    });
  }

  async getInvoiceFolder(invoiceId: string): Promise<string> {
    return (await this.findInvoice(invoiceId)).folder;
  }

  async findHash(sha256: string): Promise<InvoiceHashMatch[]> {
    const normalized = sha256.trim().toLowerCase();
    if (normalized === "") {
      return [];
    }
    return (await this.findHashes([normalized])).get(normalized) ?? [];
  }

  async findHashes(sha256Values: Iterable<string>): Promise<Map<string, InvoiceHashMatch[]>> {
    const normalizedHashes = new Set(
      [...sha256Values]
        .map((sha256) => sha256.trim().toLowerCase())
        .filter((sha256) => sha256 !== "")
    );
    const matchesByHash = new Map<string, InvoiceHashMatch[]>(
      [...normalizedHashes].map((sha256) => [sha256, []])
    );
    if (normalizedHashes.size === 0) {
      return matchesByHash;
    }

    for (const { invoice } of await this.discoverInvoices()) {
      for (const receipt of invoice.receipts) {
        const normalized = receipt.sha256.trim().toLowerCase();
        const matches = matchesByHash.get(normalized);
        if (matches) {
          matches.push({
            invoiceId: invoice.id,
            invoiceName: invoice.name,
            receiptId: receipt.id,
            relativePath: receipt.relativePath,
          });
        }
      }
    }
    for (const matches of matchesByHash.values()) {
      matches.sort(
        (left, right) =>
          left.invoiceName.localeCompare(right.invoiceName) ||
          left.invoiceId.localeCompare(right.invoiceId) ||
          left.receiptId.localeCompare(right.receiptId)
      );
    }
    return matchesByHash;
  }

  async regenerateViews(invoiceOrId: InvoiceDocument | string): Promise<void> {
    const invoiceId = typeof invoiceOrId === "string" ? invoiceOrId : invoiceOrId.id;
    await this.enqueueByInvoiceAlias(invoiceId, async (folder) => {
      // invoice.json is authoritative. Re-read inside the invoice queue so a
      // stale caller object can never roll the generated views backwards.
      const current = await this.readInvoiceFile(folder);
      await this.writeViews(folder, current);
    });
  }
}
