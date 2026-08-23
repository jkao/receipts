import { createHash } from "node:crypto";
import path from "node:path";

import { normalizeHours } from "../shared/finance";
import {
  type ImportMethod,
  INVOICE_DELETION_SCHEMA_VERSION,
  INVOICE_SCHEMA_VERSION,
  type InvoiceDeletionSentinel,
  type InvoiceDocument,
  type InvoicePeriod,
  type InvoiceReviewAcknowledgement,
  type InvoiceRow,
  type ReceiptRecord,
  type ReceiptStatus,
  type SourceKind,
} from "../shared/types";

export const INVOICE_VIEW_STATE_SCHEMA_VERSION = 1 as const;

export interface InvoiceViewState {
  schemaVersion: typeof INVOICE_VIEW_STATE_SCHEMA_VERSION;
  revision: number;
  invoiceSha256: string;
  state: "clean" | "dirty";
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

export class InvoiceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvoiceValidationError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function requiredString(value: unknown, label: string, allowEmpty = false): string {
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

export function safeInteger(value: unknown, label: string, minimum?: number): number {
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

export function validateInvoiceViewState(value: unknown): InvoiceViewState {
  if (!isRecord(value)) {
    throw new InvoiceValidationError("Invoice view state must contain an object");
  }
  if (value.schemaVersion !== INVOICE_VIEW_STATE_SCHEMA_VERSION) {
    throw new InvoiceValidationError(
      `Unsupported invoice view state schema version: ${String(value.schemaVersion)}`
    );
  }
  if (value.state !== "clean" && value.state !== "dirty") {
    throw new InvoiceValidationError("Invoice view state must be clean or dirty");
  }
  const invoiceSha256 = requiredString(value.invoiceSha256, "Invoice view source fingerprint");
  if (!/^[0-9a-f]{64}$/.test(invoiceSha256)) {
    throw new InvoiceValidationError(
      "Invoice view source fingerprint must be a lowercase SHA-256 value"
    );
  }
  return {
    schemaVersion: INVOICE_VIEW_STATE_SCHEMA_VERSION,
    revision: safeInteger(value.revision, "Invoice view revision", 0),
    invoiceSha256,
    state: value.state,
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

export function validatePeriod(value: unknown, label = "Invoice period"): InvoicePeriod {
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

export function cloneInvoiceDocument(invoice: InvoiceDocument): InvoiceDocument {
  return structuredClone(invoice);
}

export function serializeInvoiceDocument(invoice: InvoiceDocument): string {
  return `${JSON.stringify(invoice, null, 2)}\n`;
}

export function invoiceDocumentFingerprint(invoice: InvoiceDocument): string {
  return createHash("sha256").update(serializeInvoiceDocument(invoice)).digest("hex");
}

export function serializeInvoiceDeletionSentinel(deletion: InvoiceDeletionSentinel): string {
  return `${JSON.stringify(deletion, null, 2)}\n`;
}

export function serializeInvoiceViewState(state: InvoiceViewState): string {
  return `${JSON.stringify(state, null, 2)}\n`;
}
