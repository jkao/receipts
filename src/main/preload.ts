import { contextBridge, ipcRenderer, webUtils } from "electron";
import { IPC } from "../shared/ipc";
import type {
  DesktopApi,
  ExportPackageOptions,
  ImportFilesOptions,
  ImportProgress,
  InvoicePeriod,
  InvoiceRow,
  ReceiptPreview,
  ReceiptPreviewPayload,
  RemoveInvoiceOptions,
} from "../shared/types";

const authorizedImportPaths = new Set<string>();
let activePreviewUrl: string | null = null;
let previewRequestSequence = 0;

function authorizeImportPath(filePath: string): string {
  if (filePath) {
    authorizedImportPaths.add(filePath);
  }
  return filePath;
}

function assertAuthorizedImportPaths(paths: string[]): void {
  if (
    !Array.isArray(paths) ||
    paths.some(
      (filePath) =>
        typeof filePath !== "string" ||
        filePath.length === 0 ||
        !authorizedImportPaths.has(filePath)
    )
  ) {
    throw new Error("Choose or drop receipt files before importing them.");
  }
}

async function chooseReceiptFiles(): Promise<string[]> {
  const result: unknown = await ipcRenderer.invoke(IPC.receiptsChoose);
  if (!Array.isArray(result) || result.some((item) => typeof item !== "string")) {
    throw new Error("The receipt picker returned an invalid selection.");
  }
  return result.map(authorizeImportPath);
}

async function getReceiptPreview(invoiceId: string, receiptId: string): Promise<ReceiptPreview> {
  const requestSequence = ++previewRequestSequence;
  if (activePreviewUrl) {
    URL.revokeObjectURL(activePreviewUrl);
    activePreviewUrl = null;
  }

  const payload = (await ipcRenderer.invoke(
    IPC.receiptPreview,
    invoiceId,
    receiptId
  )) as ReceiptPreviewPayload;
  if (requestSequence !== previewRequestSequence) {
    throw new Error("A newer receipt preview was requested.");
  }
  if (!(payload.bytes instanceof Uint8Array)) {
    throw new Error("The receipt preview returned invalid binary data.");
  }

  const bytes = new Uint8Array(payload.bytes.byteLength);
  bytes.set(payload.bytes);
  const previewUrl = URL.createObjectURL(new Blob([bytes.buffer], { type: payload.mimeType }));
  activePreviewUrl = previewUrl;
  return {
    filename: payload.filename,
    mimeType: payload.mimeType,
    dataUrl: previewUrl,
    managedPath: payload.managedPath,
  };
}

const api: DesktopApi = {
  getSettings: () => ipcRenderer.invoke(IPC.settingsGet),
  chooseBaseFolder: () => ipcRenderer.invoke(IPC.settingsChooseBase),
  updateDefaultRate: (rateMinor) => ipcRenderer.invoke(IPC.settingsUpdateRate, rateMinor),
  saveOpenAiKey: (apiKey) => ipcRenderer.invoke(IPC.settingsSaveKey, apiKey),
  deleteOpenAiKey: () => ipcRenderer.invoke(IPC.settingsDeleteKey),
  testOpenAiKey: (apiKey) => ipcRenderer.invoke(IPC.settingsTestKey, apiKey),
  listInvoices: () => ipcRenderer.invoke(IPC.invoicesList),
  createInvoice: (period: InvoicePeriod) => ipcRenderer.invoke(IPC.invoicesCreate, period),
  loadInvoice: (invoiceId: string) => ipcRenderer.invoke(IPC.invoicesLoad, invoiceId),
  removeInvoice: (invoiceId: string, options: RemoveInvoiceOptions) =>
    ipcRenderer.invoke(IPC.invoicesRemove, invoiceId, options),
  checkInvoice: (invoiceId: string) => ipcRenderer.invoke(IPC.invoicesCheck, invoiceId),
  setReviewAcknowledgement: (
    invoiceId: string,
    fingerprint: string,
    acknowledged: boolean,
    expectedRevision: number
  ) =>
    ipcRenderer.invoke(
      IPC.invoicesSetReviewAcknowledgement,
      invoiceId,
      fingerprint,
      acknowledged,
      expectedRevision
    ),
  saveRows: (invoiceId: string, rows: InvoiceRow[], expectedRevision: number) =>
    ipcRenderer.invoke(IPC.invoicesSaveRows, invoiceId, rows, expectedRevision),
  chooseReceiptFiles,
  pathForFile: (file: File) => authorizeImportPath(webUtils.getPathForFile(file)),
  importFiles: async (invoiceId: string, paths: string[], options?: ImportFilesOptions) => {
    assertAuthorizedImportPaths(paths);
    return ipcRenderer.invoke(IPC.receiptsImport, invoiceId, paths, options);
  },
  retryReceipts: (invoiceId: string, receiptIds: string[]) =>
    ipcRenderer.invoke(IPC.receiptsRetry, invoiceId, receiptIds),
  deleteRows: (invoiceId: string, rowIds: string[]) =>
    ipcRenderer.invoke(IPC.rowsDelete, invoiceId, rowIds),
  undoLastDelete: (invoiceId: string) => ipcRenderer.invoke(IPC.rowsUndoDelete, invoiceId),
  getReceiptPreview,
  getReceiptDebug: (invoiceId: string, receiptId: string) =>
    ipcRenderer.invoke(IPC.receiptDebug, invoiceId, receiptId),
  copyTsv: (
    invoiceId: string,
    rowIds: string[] | null,
    includeHeaders: boolean,
    includeTotals: boolean
  ) => ipcRenderer.invoke(IPC.invoiceCopyTsv, invoiceId, rowIds, includeHeaders, includeTotals),
  revealInvoice: (invoiceId: string) => ipcRenderer.invoke(IPC.invoiceReveal, invoiceId),
  buildInvoiceOutput: (invoiceId: string) => ipcRenderer.invoke(IPC.invoiceBuildOutput, invoiceId),
  revealOutput: (invoiceId: string) => ipcRenderer.invoke(IPC.invoiceRevealOutput, invoiceId),
  exportPackage: (invoiceId: string, options: ExportPackageOptions) =>
    ipcRenderer.invoke(IPC.invoiceExport, invoiceId, options),
  onImportProgress: (callback: (progress: ImportProgress) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: ImportProgress) =>
      callback(progress);
    ipcRenderer.on(IPC.importProgress, listener);
    return () => ipcRenderer.removeListener(IPC.importProgress, listener);
  },
};

contextBridge.exposeInMainWorld("receiptApp", api);
