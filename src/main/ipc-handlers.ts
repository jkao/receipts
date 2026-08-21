import { type BrowserWindow, dialog, ipcMain } from "electron";
import { IPC } from "../shared/ipc";
import type {
  ExportPackageOptions,
  ImportFilesOptions,
  InvoicePeriod,
  InvoiceRow,
  RemoveInvoiceOptions,
} from "../shared/types";
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

export function registerIpcHandlers(deps: Dependencies): void {
  for (const channel of Object.values(IPC)) {
    if (channel !== IPC.importProgress) {
      ipcMain.removeHandler(channel);
    }
  }

  ipcMain.handle(IPC.settingsGet, () => deps.settings.getView());
  ipcMain.handle(IPC.settingsChooseBase, async () => {
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
  ipcMain.handle(IPC.settingsUpdateRate, (_event, rateMinor: number) =>
    deps.settings.setDefaultRate(rateMinor)
  );
  ipcMain.handle(IPC.settingsSaveKey, (_event, apiKey: string) =>
    deps.settings.saveOpenAiKey(apiKey)
  );
  ipcMain.handle(IPC.settingsDeleteKey, () => deps.settings.deleteOpenAiKey());
  ipcMain.handle(IPC.settingsTestKey, async (_event, temporaryKey?: string) => {
    const apiKey = temporaryKey?.trim() || (await deps.settings.getOpenAiKey());
    if (!apiKey) {
      return { ok: false, message: "Enter an OpenAI API key first." };
    }
    return new OpenAiReceiptClient(apiKey).testKey();
  });

  ipcMain.handle(IPC.invoicesList, () => deps.invoices.listInvoices());
  ipcMain.handle(IPC.invoicesCreate, async (_event, period: InvoicePeriod) => {
    const settings = await deps.settings.read();
    return deps.invoices.createInvoice(period, settings.defaultRateMinor);
  });
  ipcMain.handle(IPC.invoicesLoad, (_event, invoiceId: string) =>
    deps.invoices.loadInvoice(invoiceId)
  );
  ipcMain.handle(IPC.invoicesRemove, (_event, invoiceId: string, options: RemoveInvoiceOptions) =>
    deps.invoices.removeInvoice(invoiceId, options)
  );
  ipcMain.handle(IPC.invoicesCheck, (_event, invoiceId: string) =>
    deps.checker.checkInvoice(invoiceId)
  );
  ipcMain.handle(
    IPC.invoicesSetReviewAcknowledgement,
    (
      _event,
      invoiceId: string,
      fingerprint: string,
      acknowledged: boolean,
      expectedRevision: number
    ) =>
      deps.checker.setReviewAcknowledgement(invoiceId, fingerprint, acknowledged, expectedRevision)
  );
  ipcMain.handle(
    IPC.invoicesSaveRows,
    (_event, invoiceId: string, rows: InvoiceRow[], expectedRevision: number) =>
      deps.invoices.saveRows(invoiceId, rows, expectedRevision)
  );

  ipcMain.handle(IPC.receiptsChoose, async () => {
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
  ipcMain.handle(
    IPC.receiptsImport,
    (_event, invoiceId: string, paths: string[], options?: ImportFilesOptions) =>
      deps.importer.importFiles(invoiceId, paths, options)
  );
  ipcMain.handle(IPC.receiptsRetry, (_event, invoiceId: string, receiptIds: string[]) =>
    deps.importer.retryReceipts(invoiceId, receiptIds)
  );
  ipcMain.handle(IPC.rowsDelete, (_event, invoiceId: string, rowIds: string[]) =>
    deps.trash.deleteRows(invoiceId, rowIds)
  );
  ipcMain.handle(IPC.rowsUndoDelete, (_event, invoiceId: string) =>
    deps.trash.undoLastDelete(invoiceId)
  );
  ipcMain.handle(IPC.receiptPreview, (_event, invoiceId: string, receiptId: string) =>
    deps.exporter.getReceiptPreview(invoiceId, receiptId)
  );
  ipcMain.handle(IPC.receiptDebug, (_event, invoiceId: string, receiptId: string) =>
    deps.exporter.getReceiptDebug(invoiceId, receiptId)
  );
  ipcMain.handle(
    IPC.invoiceCopyTsv,
    (
      _event,
      invoiceId: string,
      rowIds: string[] | null,
      includeHeaders: boolean,
      includeTotals: boolean
    ) => deps.exporter.copyTsv(invoiceId, rowIds, includeHeaders, includeTotals)
  );
  ipcMain.handle(IPC.invoiceReveal, (_event, invoiceId: string) =>
    deps.exporter.revealInvoice(invoiceId)
  );
  ipcMain.handle(IPC.invoiceBuildOutput, (_event, invoiceId: string) =>
    deps.output.buildInvoiceOutput(invoiceId)
  );
  ipcMain.handle(IPC.invoiceRevealOutput, (_event, invoiceId: string) =>
    deps.output.revealOutput(invoiceId)
  );
  ipcMain.handle(IPC.invoiceExport, (_event, invoiceId: string, options: ExportPackageOptions) =>
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
