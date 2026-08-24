import { IPC } from "./ipc";
import type {
  ExportPackageOptions,
  ExportPackageResult,
  ImportBatchResult,
  ImportFilesOptions,
  ImportJobCancelResult,
  ImportJobStartResult,
  ImportProgress,
  InvoiceCheckResult,
  InvoiceDocument,
  InvoiceOutputResult,
  InvoicePeriod,
  InvoiceRemovalResult,
  InvoiceReviewUpdateResult,
  InvoiceRow,
  InvoiceSummary,
  KeyTestResult,
  ReceiptDebug,
  ReceiptPreviewPayload,
  RemoveInvoiceOptions,
  SettingsView,
} from "./types";

interface Request<Args extends unknown[], Result> {
  args: Args;
  result: Result;
}

/**
 * The single compile-time source of truth for renderer-to-main request channels.
 * Runtime validation still belongs at the trust boundary in the handler/preload.
 */
export interface IpcRequestContract {
  [IPC.settingsGet]: Request<[], SettingsView>;
  [IPC.settingsChooseBase]: Request<[], SettingsView>;
  [IPC.settingsUpdateRate]: Request<[rateMinor: number], SettingsView>;
  [IPC.settingsSaveKey]: Request<[apiKey: string], SettingsView>;
  [IPC.settingsDeleteKey]: Request<[], SettingsView>;
  [IPC.settingsTestKey]: Request<[temporaryKey?: string], KeyTestResult>;
  [IPC.invoicesList]: Request<[], InvoiceSummary[]>;
  [IPC.invoicesCreate]: Request<[period: InvoicePeriod], InvoiceDocument>;
  [IPC.invoicesLoad]: Request<[invoiceId: string], InvoiceDocument>;
  [IPC.invoicesUpdatePeriod]: Request<
    [invoiceId: string, period: InvoicePeriod, expectedRevision: number],
    InvoiceDocument
  >;
  [IPC.invoicesRemove]: Request<
    [invoiceId: string, options: RemoveInvoiceOptions],
    InvoiceRemovalResult
  >;
  [IPC.invoicesCheck]: Request<[invoiceId: string], InvoiceCheckResult>;
  [IPC.invoicesSetReviewAcknowledgement]: Request<
    [invoiceId: string, fingerprint: string, acknowledged: boolean, expectedRevision: number],
    InvoiceReviewUpdateResult
  >;
  [IPC.invoicesSaveRows]: Request<
    [invoiceId: string, rows: InvoiceRow[], expectedRevision: number],
    InvoiceDocument
  >;
  [IPC.receiptsChoose]: Request<[], string[]>;
  [IPC.receiptsImport]: Request<
    [invoiceId: string, paths: string[], options?: ImportFilesOptions],
    ImportBatchResult
  >;
  [IPC.receiptsImportStart]: Request<
    [invoiceId: string, paths: string[], options?: ImportFilesOptions],
    ImportJobStartResult
  >;
  [IPC.receiptsImportCancel]: Request<[jobId: string], ImportJobCancelResult>;
  [IPC.receiptsRetry]: Request<[invoiceId: string, receiptIds: string[]], InvoiceDocument>;
  [IPC.rowsDelete]: Request<[invoiceId: string, rowIds: string[]], InvoiceDocument>;
  [IPC.rowsUndoDelete]: Request<[invoiceId: string], InvoiceDocument>;
  [IPC.receiptPreview]: Request<[invoiceId: string, receiptId: string], ReceiptPreviewPayload>;
  [IPC.receiptDebug]: Request<[invoiceId: string, receiptId: string], ReceiptDebug | null>;
  [IPC.invoiceCopyTsv]: Request<
    [invoiceId: string, rowIds: string[] | null, includeHeaders: boolean, includeTotals: boolean],
    void
  >;
  [IPC.invoiceReveal]: Request<[invoiceId: string], void>;
  [IPC.invoiceBuildOutput]: Request<[invoiceId: string], InvoiceOutputResult>;
  [IPC.invoiceRevealOutput]: Request<[invoiceId: string], void>;
  [IPC.invoiceExport]: Request<
    [invoiceId: string, options: ExportPackageOptions],
    ExportPackageResult
  >;
}

export interface IpcEventContract {
  [IPC.importProgress]: [progress: ImportProgress];
}

export type IpcRequestChannel = keyof IpcRequestContract;
export type IpcArgs<Channel extends IpcRequestChannel> = IpcRequestContract[Channel]["args"];
export type IpcResult<Channel extends IpcRequestChannel> = IpcRequestContract[Channel]["result"];
