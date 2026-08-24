import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IpcWireResult } from "../shared/app-error";
import { IPC } from "../shared/ipc";

const electron = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  return {
    handlers,
    showOpenDialog: vi.fn(),
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
    removeHandler: vi.fn(),
  };
});

vi.mock("electron", () => ({
  BrowserWindow: class BrowserWindow {},
  clipboard: {},
  dialog: { showOpenDialog: electron.showOpenDialog },
  ipcMain: {
    handle: electron.handle,
    removeHandler: electron.removeHandler,
  },
  shell: {},
}));

import { registerIpcHandlers } from "./ipc-handlers";

async function invoke<Value>(channel: string, ...args: unknown[]): Promise<Value> {
  const handler = electron.handlers.get(channel);
  if (!handler) throw new Error(`Missing IPC handler for ${channel}.`);
  const result = (await handler({}, ...args)) as IpcWireResult<Value>;
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

describe("receipt picker IPC", () => {
  beforeEach(() => {
    electron.handlers.clear();
    vi.clearAllMocks();
  });

  it("enables macOS multi-selection and returns every selected path", async () => {
    const window = {};
    const paths = ["/receipts/one.jpg", "/receipts/two.pdf", "/receipts/three.png"];
    electron.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: paths });
    registerIpcHandlers({
      settings: {} as never,
      invoices: {} as never,
      checker: {} as never,
      importer: {} as never,
      trash: {} as never,
      exporter: {} as never,
      output: {} as never,
      getWindow: () => window as never,
    });

    await expect(invoke(IPC.receiptsChoose)).resolves.toEqual(paths);
    expect(electron.showOpenDialog).toHaveBeenCalledWith(
      window,
      expect.objectContaining({
        properties: ["openFile", "multiSelections"],
      })
    );
  });

  it("returns an empty batch when the picker is canceled", async () => {
    electron.showOpenDialog.mockResolvedValue({
      canceled: true,
      filePaths: ["/receipts/ignored.jpg"],
    });
    registerIpcHandlers({
      settings: {} as never,
      invoices: {} as never,
      checker: {} as never,
      importer: {} as never,
      trash: {} as never,
      exporter: {} as never,
      output: {} as never,
      getWindow: () => ({}) as never,
    });

    await expect(invoke(IPC.receiptsChoose)).resolves.toEqual([]);
  });

  it("delegates background import start and cancellation through structured IPC", async () => {
    const started = { jobId: "import-1", importedCount: 1 };
    const cancelled = { jobId: "import-1", cancelled: true };
    const startImport = vi.fn().mockResolvedValue(started);
    const cancelImport = vi.fn().mockReturnValue(cancelled);
    registerIpcHandlers({
      settings: {} as never,
      invoices: {} as never,
      checker: {} as never,
      importer: { startImport, cancelImport } as never,
      trash: {} as never,
      exporter: {} as never,
      output: {} as never,
      getWindow: () => ({}) as never,
    });
    const paths = ["/receipts/background.jpg"];
    const options = { method: "drag-drop" as const };

    await expect(
      electron.handlers.get(IPC.receiptsImportStart)?.({}, "invoice-1", paths, options)
    ).resolves.toEqual({ ok: true, value: started });
    expect(startImport).toHaveBeenCalledWith("invoice-1", paths, options);
    await expect(
      electron.handlers.get(IPC.receiptsImportCancel)?.({}, "import-1")
    ).resolves.toEqual({ ok: true, value: cancelled });
    expect(cancelImport).toHaveBeenCalledWith("import-1");
  });

  it("delegates advisory invoice checks through IPC", async () => {
    const result = {
      invoiceId: "invoice-1",
      revision: 3,
      checkedAt: "2026-08-21T12:00:00.000Z",
      issues: [],
    };
    const checkInvoice = vi.fn().mockResolvedValue(result);
    registerIpcHandlers({
      settings: {} as never,
      invoices: {} as never,
      checker: { checkInvoice } as never,
      importer: {} as never,
      trash: {} as never,
      exporter: {} as never,
      output: {} as never,
      getWindow: () => ({}) as never,
    });

    await expect(invoke(IPC.invoicesCheck, "invoice-1")).resolves.toBe(result);
    expect(checkInvoice).toHaveBeenCalledWith("invoice-1");
  });

  it("delegates invoice removal options unchanged for store-side validation", async () => {
    const result = {
      invoiceId: "invoice-1",
      invoiceName: "invoice-2026-01-01-2026-01-31",
      mode: "soft",
      deletedAt: "2026-08-21T12:00:00.000Z",
    };
    const removeInvoice = vi.fn().mockResolvedValue(result);
    registerIpcHandlers({
      settings: {} as never,
      invoices: { removeInvoice } as never,
      checker: {} as never,
      importer: {} as never,
      trash: {} as never,
      exporter: {} as never,
      output: {} as never,
      getWindow: () => ({}) as never,
    });
    const options = { expectedRevision: 7, hardDelete: true };

    await expect(invoke(IPC.invoicesRemove, "invoice-1", options)).resolves.toBe(result);
    expect(removeInvoice).toHaveBeenCalledWith("invoice-1", options);
  });

  it("delegates revision-checked invoice period updates", async () => {
    const result = {
      id: "invoice-1",
      period: { startDate: "2026-02-01", endDate: "2026-02-28" },
      revision: 5,
    };
    const updateInvoicePeriod = vi.fn().mockResolvedValue(result);
    registerIpcHandlers({
      settings: {} as never,
      invoices: { updateInvoicePeriod } as never,
      checker: {} as never,
      importer: {} as never,
      trash: {} as never,
      exporter: {} as never,
      output: {} as never,
      getWindow: () => ({}) as never,
    });
    const period = { startDate: "2026-02-01", endDate: "2026-02-28" };

    await expect(invoke(IPC.invoicesUpdatePeriod, "invoice-1", period, 4)).resolves.toBe(result);
    expect(updateInvoicePeriod).toHaveBeenCalledWith("invoice-1", period, 4);
  });

  it("delegates persisted review acknowledgement updates with a revision", async () => {
    const result = { invoice: { revision: 4 }, check: { revision: 4 } };
    const setReviewAcknowledgement = vi.fn().mockResolvedValue(result);
    registerIpcHandlers({
      settings: {} as never,
      invoices: {} as never,
      checker: { setReviewAcknowledgement } as never,
      importer: {} as never,
      trash: {} as never,
      exporter: {} as never,
      output: {} as never,
      getWindow: () => ({}) as never,
    });
    const fingerprint = "a".repeat(64);

    await expect(
      invoke(IPC.invoicesSetReviewAcknowledgement, "invoice-1", fingerprint, true, 3)
    ).resolves.toBe(result);
    expect(setReviewAcknowledgement).toHaveBeenCalledWith("invoice-1", fingerprint, true, 3);
  });

  it("delegates invoice output build and reveal through IPC", async () => {
    const result = {
      outputPath: "/invoices/one/output",
      archivePath: "/invoices/one/output/invoice-2026-01-01-2026-01-31.zip",
      receiptCount: 2,
    };
    const buildInvoiceOutput = vi.fn().mockResolvedValue(result);
    const revealOutput = vi.fn().mockResolvedValue(undefined);
    registerIpcHandlers({
      settings: {} as never,
      invoices: {} as never,
      checker: {} as never,
      importer: {} as never,
      trash: {} as never,
      exporter: {} as never,
      output: { buildInvoiceOutput, revealOutput } as never,
      getWindow: () => ({}) as never,
    });

    await expect(invoke(IPC.invoiceBuildOutput, "invoice-1")).resolves.toBe(result);
    expect(buildInvoiceOutput).toHaveBeenCalledWith("invoice-1");

    await expect(invoke(IPC.invoiceRevealOutput, "invoice-1")).resolves.toBeUndefined();
    expect(revealOutput).toHaveBeenCalledWith("invoice-1");
  });

  it("returns stable error codes without relying on Electron's Error serialization", async () => {
    const conflict = Object.assign(new Error("Invoice changed on disk."), {
      name: "RevisionConflictError",
    });
    registerIpcHandlers({
      settings: {} as never,
      invoices: { loadInvoice: vi.fn().mockRejectedValue(conflict) } as never,
      checker: {} as never,
      importer: {} as never,
      trash: {} as never,
      exporter: {} as never,
      output: {} as never,
      getWindow: () => ({}) as never,
    });

    await expect(electron.handlers.get(IPC.invoicesLoad)?.({}, "invoice-1")).resolves.toEqual({
      ok: false,
      error: { code: "REVISION_CONFLICT", message: "Invoice changed on disk." },
    });
  });
});
