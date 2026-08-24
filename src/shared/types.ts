export const INVOICE_SCHEMA_VERSION = 1 as const;
export const INVOICE_DELETION_SCHEMA_VERSION = 1 as const;

export type ReceiptStatus =
  | "needs-key"
  | "queued"
  | "scanning"
  | "ready"
  | "needs-review"
  | "error";

export type ImportMethod = "drag-drop" | "file-picker" | "folder" | "watcher";
export type SourceKind = "manual" | "automation";

export interface InvoicePeriod {
  startDate: string;
  endDate: string;
}

export interface InvoiceRow {
  id: string;
  date: string | null;
  groceriesMinor: number | null;
  hours: string;
  rateMinor: number | null;
  comment: string;
  receiptId: string | null;
}

export interface ReceiptSource {
  kind: SourceKind;
  method: ImportMethod;
}

export interface ReceiptRecord {
  id: string;
  relativePath: string;
  debugPath: string;
  originalFilename: string;
  mimeType: string;
  sha256: string;
  source: ReceiptSource;
  status: ReceiptStatus;
  importedAt: string;
  error?: string;
}

export interface InvoiceReviewAcknowledgement {
  /** SHA-256 of the finding and the data that caused it. */
  fingerprint: string;
  acknowledgedAt: string;
}

export interface InvoiceDocument {
  schemaVersion: typeof INVOICE_SCHEMA_VERSION;
  id: string;
  name: string;
  period: InvoicePeriod;
  defaultRateMinor: number;
  currency: "USD";
  revision: number;
  rows: InvoiceRow[];
  receipts: ReceiptRecord[];
  /** Missing schema-v1 JSON is migrated to an empty list when loaded. */
  reviewAcknowledgements: InvoiceReviewAcknowledgement[];
  createdAt: string;
  updatedAt: string;
}

export interface InvoiceSummary {
  id: string;
  name: string;
  period: InvoicePeriod;
  rowCount: number;
  receiptCount: number;
  updatedAt: string;
}

/** Visible folder-local marker used for recoverable invoice deletion. */
export interface InvoiceDeletionSentinel {
  schemaVersion: typeof INVOICE_DELETION_SCHEMA_VERSION;
  invoiceId: string;
  invoiceName: string;
  lastRevision: number;
  deletedAt: string;
  /** A requested permanent deletion stopped after one or more files may have been removed. */
  hardDeleteIncomplete?: boolean;
}

export interface RemoveInvoiceOptions {
  expectedRevision: number;
  /** Permanently remove the invoice folder instead of writing DELETED.json. */
  hardDelete?: boolean;
}

export interface InvoiceRemovalResult {
  invoiceId: string;
  invoiceName: string;
  mode: "soft" | "hard";
  deletedAt: string;
  /** Present when a requested hard deletion could only be completed as a soft deletion. */
  warning?: string;
}

export type InvoiceCheckIssueCode =
  | "exact-receipt-duplicate"
  | "likely-transaction-duplicate"
  | "receipt-scan-not-ready"
  | "receipt-scan-warning"
  | "receipt-fields-incomplete"
  | "date-outside-period";

export interface InvoiceCheckIssue {
  /** Changes whenever the data responsible for this finding materially changes. */
  fingerprint: string;
  acknowledgeable: boolean;
  acknowledgedAt: string | null;
  code: InvoiceCheckIssueCode;
  message: string;
  rowIds: string[];
  receiptIds: string[];
}

export interface InvoiceCheckResult {
  invoiceId: string;
  revision: number;
  checkedAt: string;
  issues: InvoiceCheckIssue[];
}

export interface InvoiceReviewUpdateResult {
  invoice: InvoiceDocument;
  check: InvoiceCheckResult;
}

export interface InvoiceTotals {
  groceriesMinor: number;
  hours: string;
  labourMinor: number;
  invoiceMinor: number;
}

export interface ReceiptItem {
  description: string | null;
  quantity: string | null;
  unitPrice: string | null;
  lineTotal: string | null;
}

export interface ReceiptAdjustment {
  description: string | null;
  amount: string | null;
}

export interface ReceiptExtraction {
  merchant: string | null;
  date: string | null;
  currency: string | null;
  subtotal: string | null;
  tax: string | null;
  tip: string | null;
  adjustments: ReceiptAdjustment[];
  total: string | null;
  items: ReceiptItem[];
}

export interface ReceiptUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface ReceiptDebug {
  receiptId: string;
  provider: "openai";
  model: string;
  scannedAt: string;
  extraction: ReceiptExtraction;
  validationWarnings: string[];
  usage: ReceiptUsage;
}

export interface AppSettings {
  schemaVersion: 1;
  baseFolder: string | null;
  openaiApiKeyEncrypted?: string;
  defaultRateMinor: number;
}

export interface SettingsView {
  baseFolder: string | null;
  hasOpenAiKey: boolean;
  defaultRateMinor: number;
}

export interface ImportProgress {
  /** Present for cancelable background imports; omitted by legacy synchronous work. */
  jobId?: string;
  invoiceId: string;
  current: number;
  total: number;
  filename: string;
  status: ReceiptStatus | "copying" | "duplicate" | "complete" | "cancelled" | "failed";
  message?: string;
}

export interface ImportDuplicate {
  path: string;
  filename: string;
  matchInvoiceName: string;
  sameInvoice: boolean;
}

export interface ImportBatchResult {
  invoice: InvoiceDocument;
  importedCount: number;
  duplicates: ImportDuplicate[];
  errors: Array<{ filename: string; message: string }>;
}

/** Durable local result returned before a background receipt scan begins. */
export interface ImportJobStartResult extends ImportBatchResult {
  jobId: string;
}

export interface ImportJobCancelResult {
  jobId: string;
  /** False when the job is unknown, already finished, or already cancelling. */
  cancelled: boolean;
}

export interface ImportFilesOptions {
  allowCrossInvoiceDuplicates?: boolean;
  method?: Extract<ImportMethod, "drag-drop" | "file-picker">;
}

export interface ReceiptPreview {
  filename: string;
  mimeType: string;
  dataUrl: string;
  managedPath: string;
}

/** Binary IPC payload converted to a short-lived Blob URL by the preload bridge. */
export interface ReceiptPreviewPayload {
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
  managedPath: string;
}

export interface ExportPackageOptions {
  includeDebug: boolean;
  asZip: boolean;
}

export interface ExportPackageResult {
  canceled: boolean;
  outputPath?: string;
}

export interface InvoiceOutputResult {
  outputPath: string;
  archivePath: string;
  receiptCount: number;
}

export interface KeyTestResult {
  ok: boolean;
  message: string;
}

export interface DesktopApi {
  getSettings(): Promise<SettingsView>;
  chooseBaseFolder(): Promise<SettingsView>;
  updateDefaultRate(rateMinor: number): Promise<SettingsView>;
  saveOpenAiKey(apiKey: string): Promise<SettingsView>;
  deleteOpenAiKey(): Promise<SettingsView>;
  testOpenAiKey(apiKey?: string): Promise<KeyTestResult>;
  listInvoices(): Promise<InvoiceSummary[]>;
  createInvoice(period: InvoicePeriod): Promise<InvoiceDocument>;
  loadInvoice(invoiceId: string): Promise<InvoiceDocument>;
  updateInvoicePeriod(
    invoiceId: string,
    period: InvoicePeriod,
    expectedRevision: number
  ): Promise<InvoiceDocument>;
  removeInvoice(invoiceId: string, options: RemoveInvoiceOptions): Promise<InvoiceRemovalResult>;
  checkInvoice(invoiceId: string): Promise<InvoiceCheckResult>;
  setReviewAcknowledgement(
    invoiceId: string,
    fingerprint: string,
    acknowledged: boolean,
    expectedRevision: number
  ): Promise<InvoiceReviewUpdateResult>;
  saveRows(
    invoiceId: string,
    rows: InvoiceRow[],
    expectedRevision: number
  ): Promise<InvoiceDocument>;
  chooseReceiptFiles(): Promise<string[]>;
  pathForFile(file: File): string;
  importFiles(
    invoiceId: string,
    paths: string[],
    options?: ImportFilesOptions
  ): Promise<ImportBatchResult>;
  startImport(
    invoiceId: string,
    paths: string[],
    options?: ImportFilesOptions
  ): Promise<ImportJobStartResult>;
  cancelImport(jobId: string): Promise<ImportJobCancelResult>;
  retryReceipts(invoiceId: string, receiptIds: string[]): Promise<InvoiceDocument>;
  deleteRows(invoiceId: string, rowIds: string[]): Promise<InvoiceDocument>;
  undoLastDelete(invoiceId: string): Promise<InvoiceDocument>;
  getReceiptPreview(invoiceId: string, receiptId: string): Promise<ReceiptPreview>;
  /** Release the active receipt Blob URL and invalidate any pending preview request. */
  releaseReceiptPreview(): void;
  /** Load an independently managed preview for a receipt-gallery card. */
  getReceiptThumbnail(invoiceId: string, receiptId: string): Promise<ReceiptPreview>;
  /** Release one gallery-card Blob URL and invalidate its pending request. */
  releaseReceiptThumbnail(invoiceId: string, receiptId: string): void;
  getReceiptDebug(invoiceId: string, receiptId: string): Promise<ReceiptDebug | null>;
  copyTsv(
    invoiceId: string,
    rowIds: string[] | null,
    includeHeaders: boolean,
    includeTotals: boolean
  ): Promise<void>;
  revealInvoice(invoiceId: string): Promise<void>;
  buildInvoiceOutput(invoiceId: string): Promise<InvoiceOutputResult>;
  revealOutput(invoiceId: string): Promise<void>;
  exportPackage(invoiceId: string, options: ExportPackageOptions): Promise<ExportPackageResult>;
  onImportProgress(callback: (progress: ImportProgress) => void): () => void;
}
