import { contextBridge, ipcRenderer, webUtils } from "electron";
import { isIpcWireResult, ReceiptInvoiceError } from "../shared/app-error";
import { IPC } from "../shared/ipc";
import type { IpcArgs, IpcRequestChannel, IpcResult } from "../shared/ipc-contract";
import type { DesktopApi, ImportProgress, ReceiptPreview } from "../shared/types";

const authorizedImportPaths = new Set<string>();
let activePreviewUrl: string | null = null;
let previewRequestSequence = 0;

async function invoke<Channel extends IpcRequestChannel>(
  channel: Channel,
  ...args: IpcArgs<Channel>
): Promise<IpcResult<Channel>> {
  const result: unknown = await ipcRenderer.invoke(channel, ...args);
  // Accept a raw value for compatibility with older packaged main processes;
  // current handlers always return the structured envelope.
  if (!isIpcWireResult(result)) return result as IpcResult<Channel>;
  if (!result.ok) throw new ReceiptInvoiceError(result.error.code, result.error.message);
  return result.value as IpcResult<Channel>;
}

function revokeActivePreviewUrl(): void {
  if (!activePreviewUrl) return;
  URL.revokeObjectURL(activePreviewUrl);
  activePreviewUrl = null;
}

function releaseReceiptPreview(): void {
  // Invalidate an in-flight request as well as releasing an already-created
  // URL. A late IPC response must not recreate a Blob after its drawer closed.
  previewRequestSequence += 1;
  revokeActivePreviewUrl();
}

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
  const result: unknown = await invoke(IPC.receiptsChoose);
  if (!Array.isArray(result) || result.some((item) => typeof item !== "string")) {
    throw new Error("The receipt picker returned an invalid selection.");
  }
  return result.map(authorizeImportPath);
}

async function getReceiptPreview(invoiceId: string, receiptId: string): Promise<ReceiptPreview> {
  const requestSequence = ++previewRequestSequence;
  revokeActivePreviewUrl();

  const payload = await invoke(IPC.receiptPreview, invoiceId, receiptId);
  if (requestSequence !== previewRequestSequence) {
    throw new Error("A newer receipt preview was requested.");
  }
  if (!(payload.bytes instanceof Uint8Array)) {
    throw new Error("The receipt preview returned invalid binary data.");
  }

  const sourceBuffer = payload.bytes.buffer;
  const blobBuffer =
    sourceBuffer instanceof ArrayBuffer &&
    payload.bytes.byteOffset === 0 &&
    payload.bytes.byteLength === sourceBuffer.byteLength
      ? sourceBuffer
      : Uint8Array.from(payload.bytes).buffer;
  const previewUrl = URL.createObjectURL(new Blob([blobBuffer], { type: payload.mimeType }));
  activePreviewUrl = previewUrl;
  return {
    filename: payload.filename,
    mimeType: payload.mimeType,
    dataUrl: previewUrl,
    managedPath: payload.managedPath,
  };
}

const api: DesktopApi = {
  getSettings: () => invoke(IPC.settingsGet),
  chooseBaseFolder: () => invoke(IPC.settingsChooseBase),
  updateDefaultRate: (rateMinor) => invoke(IPC.settingsUpdateRate, rateMinor),
  saveOpenAiKey: (apiKey) => invoke(IPC.settingsSaveKey, apiKey),
  deleteOpenAiKey: () => invoke(IPC.settingsDeleteKey),
  testOpenAiKey: (apiKey) => invoke(IPC.settingsTestKey, apiKey),
  listInvoices: () => invoke(IPC.invoicesList),
  createInvoice: (period) => invoke(IPC.invoicesCreate, period),
  loadInvoice: (invoiceId) => invoke(IPC.invoicesLoad, invoiceId),
  removeInvoice: (invoiceId, options) => invoke(IPC.invoicesRemove, invoiceId, options),
  checkInvoice: (invoiceId) => invoke(IPC.invoicesCheck, invoiceId),
  setReviewAcknowledgement: (invoiceId, fingerprint, acknowledged, expectedRevision) =>
    invoke(
      IPC.invoicesSetReviewAcknowledgement,
      invoiceId,
      fingerprint,
      acknowledged,
      expectedRevision
    ),
  saveRows: (invoiceId, rows, expectedRevision) =>
    invoke(IPC.invoicesSaveRows, invoiceId, rows, expectedRevision),
  chooseReceiptFiles,
  pathForFile: (file: File) => authorizeImportPath(webUtils.getPathForFile(file)),
  importFiles: async (invoiceId, paths, options) => {
    assertAuthorizedImportPaths(paths);
    return invoke(IPC.receiptsImport, invoiceId, paths, options);
  },
  startImport: async (invoiceId, paths, options) => {
    assertAuthorizedImportPaths(paths);
    return invoke(IPC.receiptsImportStart, invoiceId, paths, options);
  },
  cancelImport: (jobId) => invoke(IPC.receiptsImportCancel, jobId),
  retryReceipts: (invoiceId, receiptIds) => invoke(IPC.receiptsRetry, invoiceId, receiptIds),
  deleteRows: (invoiceId, rowIds) => invoke(IPC.rowsDelete, invoiceId, rowIds),
  undoLastDelete: (invoiceId) => invoke(IPC.rowsUndoDelete, invoiceId),
  getReceiptPreview,
  releaseReceiptPreview,
  getReceiptDebug: (invoiceId, receiptId) => invoke(IPC.receiptDebug, invoiceId, receiptId),
  copyTsv: (invoiceId, rowIds, includeHeaders, includeTotals) =>
    invoke(IPC.invoiceCopyTsv, invoiceId, rowIds, includeHeaders, includeTotals),
  revealInvoice: (invoiceId) => invoke(IPC.invoiceReveal, invoiceId),
  buildInvoiceOutput: (invoiceId) => invoke(IPC.invoiceBuildOutput, invoiceId),
  revealOutput: (invoiceId) => invoke(IPC.invoiceRevealOutput, invoiceId),
  exportPackage: (invoiceId, options) => invoke(IPC.invoiceExport, invoiceId, options),
  onImportProgress: (callback: (progress: ImportProgress) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: ImportProgress) =>
      callback(progress);
    ipcRenderer.on(IPC.importProgress, listener);
    return () => ipcRenderer.removeListener(IPC.importProgress, listener);
  },
};

contextBridge.exposeInMainWorld("receiptApp", api);
