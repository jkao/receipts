import { type BrowserWindow, dialog, ipcMain } from "electron";
import { appErrorPayload, type IpcWireResult } from "../shared/app-error";
import { IPC } from "../shared/ipc";
import type { IpcArgs, IpcRequestChannel, IpcResult } from "../shared/ipc-contract";
import type { InvoiceExporter } from "./exporter";
import type { ImportManager } from "./import-manager";
import type { InvoiceChecker } from "./invoice-checker";
import type { InvoiceOutputBuilder } from "./invoice-output";
import type { InvoiceStore } from "./invoice-store";
import { OpenAiReceiptClient } from "./openai";
import type { SettingsStore } from "./settings";
import type { TrashManager } from "./trash-manager";

interface Dependencies {
  settings: SettingsStore;
  invoices: InvoiceStore;
  checker: InvoiceChecker;
  importer: ImportManager;
  trash: TrashManager;
  exporter: InvoiceExporter;
  output: InvoiceOutputBuilder;
  getWindow(): BrowserWindow | null;
}

type RequestHandler<Channel extends IpcRequestChannel> = (
  ...args: IpcArgs<Channel>
) => IpcResult<Channel> | Promise<IpcResult<Channel>>;

/** Keep Electron's untyped registration API behind the shared channel contract. */
function handle<Channel extends IpcRequestChannel>(
  channel: Channel,
  requestHandler: RequestHandler<Channel>
): void {
  ipcMain.handle(channel, async (_event, ...args: unknown[]) => {
    try {
      const value = await requestHandler(...(args as IpcArgs<Channel>));
      return { ok: true, value } satisfies IpcWireResult<IpcResult<Channel>>;
    } catch (error) {
      return { ok: false, error: appErrorPayload(error) } satisfies IpcWireResult<never>;
    }
  });
}

export function registerIpcHandlers(deps: Dependencies): void {
  for (const channel of Object.values(IPC)) {
    if (channel !== IPC.importProgress) {
      ipcMain.removeHandler(channel);
    }
  }

  handle(IPC.settingsGet, () => deps.settings.getView());
  handle(IPC.settingsChooseBase, async () => {
    const result = await dialog.showOpenDialog(requiredWindow(deps), {
      title: "Choose invoice base folder",
      buttonLabel: "Use this folder",
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return deps.settings.getView();
    }
    return deps.settings.setBaseFolder(result.filePaths[0]);
  });
  handle(IPC.settingsUpdateRate, (rateMinor) => deps.settings.setDefaultRate(rateMinor));
  handle(IPC.settingsSaveKey, (apiKey) => deps.settings.saveOpenAiKey(apiKey));
  handle(IPC.settingsDeleteKey, () => deps.settings.deleteOpenAiKey());
  handle(IPC.settingsTestKey, async (temporaryKey) => {
    const apiKey = temporaryKey?.trim() || (await deps.settings.getOpenAiKey());
    if (!apiKey) {
      return { ok: false, message: "Enter an OpenAI API key first." };
    }
    return new OpenAiReceiptClient(apiKey).testKey();
  });

  handle(IPC.invoicesList, () => deps.invoices.listInvoices());
  handle(IPC.invoicesCreate, async (period) => {
    const settings = await deps.settings.read();
    return deps.invoices.createInvoice(period, settings.defaultRateMinor);
  });
  handle(IPC.invoicesLoad, (invoiceId) => deps.invoices.loadInvoice(invoiceId));
  handle(IPC.invoicesRemove, (invoiceId, options) =>
    deps.invoices.removeInvoice(invoiceId, options)
  );
  handle(IPC.invoicesCheck, (invoiceId) => deps.checker.checkInvoice(invoiceId));
  handle(
    IPC.invoicesSetReviewAcknowledgement,
    (invoiceId, fingerprint, acknowledged, expectedRevision) =>
      deps.checker.setReviewAcknowledgement(invoiceId, fingerprint, acknowledged, expectedRevision)
  );
  handle(IPC.invoicesSaveRows, (invoiceId, rows, expectedRevision) =>
    deps.invoices.saveRows(invoiceId, rows, expectedRevision)
  );

  handle(IPC.receiptsChoose, async () => {
    const result = await dialog.showOpenDialog(requiredWindow(deps), {
      title: "Choose receipt images or PDFs",
      buttonLabel: "Add receipts",
      properties: ["openFile", "multiSelections"],
      filters: [
        {
          name: "Receipts",
          extensions: ["jpg", "jpeg", "png", "webp", "heic", "heif", "pdf"],
        },
      ],
    });
    return result.canceled ? [] : result.filePaths;
  });
  handle(IPC.receiptsImport, (invoiceId, paths, options) =>
    deps.importer.importFiles(invoiceId, paths, options)
  );
  handle(IPC.receiptsImportStart, (invoiceId, paths, options) =>
    deps.importer.startImport(invoiceId, paths, options)
  );
  handle(IPC.receiptsImportCancel, (jobId) => deps.importer.cancelImport(jobId));
  handle(IPC.receiptsRetry, (invoiceId, receiptIds) =>
    deps.importer.retryReceipts(invoiceId, receiptIds)
  );
  handle(IPC.rowsDelete, (invoiceId, rowIds) => deps.trash.deleteRows(invoiceId, rowIds));
  handle(IPC.rowsUndoDelete, (invoiceId) => deps.trash.undoLastDelete(invoiceId));
  handle(IPC.receiptPreview, (invoiceId, receiptId) =>
    deps.exporter.getReceiptPreview(invoiceId, receiptId)
  );
  handle(IPC.receiptDebug, (invoiceId, receiptId) =>
    deps.exporter.getReceiptDebug(invoiceId, receiptId)
  );
  handle(IPC.invoiceCopyTsv, (invoiceId, rowIds, includeHeaders, includeTotals) =>
    deps.exporter.copyTsv(invoiceId, rowIds, includeHeaders, includeTotals)
  );
  handle(IPC.invoiceReveal, (invoiceId) => deps.exporter.revealInvoice(invoiceId));
  handle(IPC.invoiceBuildOutput, (invoiceId) => deps.output.buildInvoiceOutput(invoiceId));
  handle(IPC.invoiceRevealOutput, (invoiceId) => deps.output.revealOutput(invoiceId));
  handle(IPC.invoiceExport, (invoiceId, options) =>
    deps.exporter.exportPackage(invoiceId, options)
  );
}

function requiredWindow(deps: Dependencies): BrowserWindow {
  const window = deps.getWindow();
  if (!window) {
    throw new Error("The app window is unavailable.");
  }
  return window;
}
