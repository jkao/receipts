import { beforeEach, describe, expect, it, vi } from "vitest";
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

    const handler = electron.handlers.get(IPC.receiptsChoose);
    expect(handler).toBeDefined();
    await expect(handler?.({})).resolves.toEqual(paths);
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

    const handler = electron.handlers.get(IPC.receiptsChoose);
    await expect(handler?.({})).resolves.toEqual([]);
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

    const handler = electron.handlers.get(IPC.invoicesCheck);
    await expect(handler?.({}, "invoice-1")).resolves.toBe(result);
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

    await expect(
      electron.handlers.get(IPC.invoicesRemove)?.({}, "invoice-1", options)
    ).resolves.toBe(result);
    expect(removeInvoice).toHaveBeenCalledWith("invoice-1", options);
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
      electron.handlers.get(IPC.invoicesSetReviewAcknowledgement)?.(
        {},
        "invoice-1",
        fingerprint,
        true,
        3
      )
    ).resolves.toBe(result);
    expect(setReviewAcknowledgement).toHaveBeenCalledWith("invoice-1", fingerprint, true, 3);
  });

  it("delegates invoice output build and reveal through IPC", async () => {
    const result = { outputPath: "/invoices/one/output", receiptCount: 2 };
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

    await expect(electron.handlers.get(IPC.invoiceBuildOutput)?.({}, "invoice-1")).resolves.toBe(
      result
    );
    expect(buildInvoiceOutput).toHaveBeenCalledWith("invoice-1");

    await expect(
      electron.handlers.get(IPC.invoiceRevealOutput)?.({}, "invoice-1")
    ).resolves.toBeUndefined();
    expect(revealOutput).toHaveBeenCalledWith("invoice-1");
  });
});
