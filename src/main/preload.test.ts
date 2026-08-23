import { describe, expect, it, vi } from "vitest";
import { IPC } from "../shared/ipc";
import type { DesktopApi } from "../shared/types";

const electron = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  getPathForFile: vi.fn(),
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
}));

vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: electron.exposeInMainWorld },
  ipcRenderer: {
    invoke: electron.invoke,
    on: electron.on,
    removeListener: electron.removeListener,
  },
  webUtils: { getPathForFile: electron.getPathForFile },
}));

import "./preload";

describe("receipt preload bridge", () => {
  it("passes a drag/drop path array and import options through unchanged", async () => {
    const api = electron.exposeInMainWorld.mock.calls[0]?.[1] as DesktopApi;
    const paths = ["/receipts/one.jpg", "/receipts/two.pdf"];
    electron.getPathForFile.mockReturnValueOnce(paths[0]).mockReturnValueOnce(paths[1]);
    const authorizedPaths = [
      api.pathForFile({ name: "one.jpg" } as File),
      api.pathForFile({ name: "two.pdf" } as File),
    ];
    const expected = { importedCount: 2 };
    electron.invoke.mockResolvedValue(expected);

    await expect(
      api.importFiles("invoice-1", authorizedPaths, { method: "drag-drop" })
    ).resolves.toBe(expected);
    expect(electron.invoke).toHaveBeenCalledWith(IPC.receiptsImport, "invoice-1", paths, {
      method: "drag-drop",
    });
  });

  it("exposes authorized background import start and cancellation calls", async () => {
    const api = electron.exposeInMainWorld.mock.calls[0]?.[1] as DesktopApi;
    const path = "/receipts/background.jpg";
    electron.getPathForFile.mockReturnValue(path);
    const authorizedPath = api.pathForFile({ name: "background.jpg" } as File);
    const started = { jobId: "import-1", importedCount: 1 };
    const cancelled = { jobId: "import-1", cancelled: true };
    electron.invoke.mockReset().mockResolvedValueOnce(started).mockResolvedValueOnce(cancelled);

    await expect(
      api.startImport("invoice-1", [authorizedPath], { method: "drag-drop" })
    ).resolves.toBe(started);
    expect(electron.invoke).toHaveBeenNthCalledWith(
      1,
      IPC.receiptsImportStart,
      "invoice-1",
      [path],
      { method: "drag-drop" }
    );
    await expect(api.cancelImport("import-1")).resolves.toBe(cancelled);
    expect(electron.invoke).toHaveBeenNthCalledWith(2, IPC.receiptsImportCancel, "import-1");
  });

  it("forwards job-correlated terminal import progress and removes its listener", () => {
    const api = electron.exposeInMainWorld.mock.calls[0]?.[1] as DesktopApi;
    const callback = vi.fn();
    electron.on.mockClear();
    electron.removeListener.mockClear();

    const unsubscribe = api.onImportProgress(callback);
    const listener = electron.on.mock.calls[0]?.[1];
    const progress = {
      jobId: "import-1",
      invoiceId: "invoice-1",
      current: 2,
      total: 2,
      filename: "Receipt import",
      status: "complete" as const,
    };
    listener({}, progress);

    expect(electron.on).toHaveBeenCalledWith(IPC.importProgress, listener);
    expect(callback).toHaveBeenCalledWith(progress);
    unsubscribe();
    expect(electron.removeListener).toHaveBeenCalledWith(IPC.importProgress, listener);
  });

  it("rejects renderer-supplied paths that were not chosen or dropped", async () => {
    const api = electron.exposeInMainWorld.mock.calls[0]?.[1] as DesktopApi;
    electron.invoke.mockClear();

    await expect(
      api.importFiles("invoice-1", ["/Users/example/private.pdf"], {
        method: "drag-drop",
      })
    ).rejects.toThrow("Choose or drop receipt files");
    await expect(
      api.startImport("invoice-1", ["/Users/example/private.pdf"], {
        method: "drag-drop",
      })
    ).rejects.toThrow("Choose or drop receipt files");
    expect(electron.invoke).not.toHaveBeenCalled();
  });

  it("authorizes every path returned by the native file picker", async () => {
    const api = electron.exposeInMainWorld.mock.calls[0]?.[1] as DesktopApi;
    const paths = ["/receipts/picked-one.jpg", "/receipts/picked-two.pdf"];
    electron.invoke.mockResolvedValueOnce(paths).mockResolvedValueOnce({ importedCount: 2 });

    await expect(api.chooseReceiptFiles()).resolves.toEqual(paths);
    await api.importFiles("invoice-1", paths, { method: "file-picker" });

    expect(electron.invoke).toHaveBeenNthCalledWith(1, IPC.receiptsChoose);
    expect(electron.invoke).toHaveBeenNthCalledWith(2, IPC.receiptsImport, "invoice-1", paths, {
      method: "file-picker",
    });
  });

  it("uses Electron webUtils to resolve each dropped File", () => {
    const api = electron.exposeInMainWorld.mock.calls[0]?.[1] as DesktopApi;
    const file = { name: "receipt.jpg" } as File;
    electron.getPathForFile.mockReturnValue("/receipts/receipt.jpg");

    expect(api.pathForFile(file)).toBe("/receipts/receipt.jpg");
    expect(electron.getPathForFile).toHaveBeenCalledWith(file);
  });

  it("turns binary preview IPC into a Blob URL and revokes the prior preview", async () => {
    const api = electron.exposeInMainWorld.mock.calls[0]?.[1] as DesktopApi;
    const createObjectUrl = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValueOnce("blob:preview-one")
      .mockReturnValueOnce("blob:preview-two");
    const revokeObjectUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    electron.invoke
      .mockResolvedValueOnce({
        filename: "one.png",
        mimeType: "image/png",
        bytes: new Uint8Array([1, 2, 3]),
        managedPath: "/managed/one.png",
      })
      .mockResolvedValueOnce({
        filename: "two.pdf",
        mimeType: "application/pdf",
        bytes: new Uint8Array([4, 5, 6]),
        managedPath: "/managed/two.pdf",
      });

    await expect(api.getReceiptPreview("invoice-1", "receipt-1")).resolves.toEqual({
      filename: "one.png",
      mimeType: "image/png",
      dataUrl: "blob:preview-one",
      managedPath: "/managed/one.png",
    });
    await expect(api.getReceiptPreview("invoice-1", "receipt-2")).resolves.toEqual({
      filename: "two.pdf",
      mimeType: "application/pdf",
      dataUrl: "blob:preview-two",
      managedPath: "/managed/two.pdf",
    });

    expect(createObjectUrl).toHaveBeenCalledTimes(2);
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:preview-one");
    api.releaseReceiptPreview();
    expect(revokeObjectUrl).toHaveBeenNthCalledWith(2, "blob:preview-two");
    createObjectUrl.mockRestore();
    revokeObjectUrl.mockRestore();
  });

  it("invalidates a pending preview when the renderer releases it", async () => {
    const api = electron.exposeInMainWorld.mock.calls[0]?.[1] as DesktopApi;
    let resolvePreview!: (value: {
      filename: string;
      mimeType: string;
      bytes: Uint8Array;
      managedPath: string;
    }) => void;
    const pendingPreview = new Promise<Parameters<typeof resolvePreview>[0]>((resolve) => {
      resolvePreview = resolve;
    });
    const createObjectUrl = vi.spyOn(URL, "createObjectURL");
    const revokeObjectUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    electron.invoke.mockReset().mockReturnValueOnce(pendingPreview);

    const request = api.getReceiptPreview("invoice-1", "receipt-late");
    api.releaseReceiptPreview();
    resolvePreview({
      filename: "late.png",
      mimeType: "image/png",
      bytes: new Uint8Array([1, 2, 3]),
      managedPath: "/managed/late.png",
    });

    await expect(request).rejects.toThrow("A newer receipt preview was requested");
    expect(createObjectUrl).not.toHaveBeenCalled();
    expect(revokeObjectUrl).not.toHaveBeenCalled();
    createObjectUrl.mockRestore();
    revokeObjectUrl.mockRestore();
  });

  it("exposes the advisory invoice check IPC call", async () => {
    const api = electron.exposeInMainWorld.mock.calls[0]?.[1] as DesktopApi;
    const result = {
      invoiceId: "invoice-1",
      revision: 4,
      checkedAt: "2026-08-21T12:00:00.000Z",
      issues: [],
    };
    electron.invoke.mockResolvedValue(result);

    await expect(api.checkInvoice("invoice-1")).resolves.toBe(result);
    expect(electron.invoke).toHaveBeenCalledWith(IPC.invoicesCheck, "invoice-1");
  });

  it("reconstructs structured main-process failures with a stable error code", async () => {
    const api = electron.exposeInMainWorld.mock.calls[0]?.[1] as DesktopApi;
    electron.invoke.mockResolvedValue({
      ok: false,
      error: {
        code: "REVISION_CONFLICT",
        message: "Invoice changed on disk.",
      },
    });

    const request = api.loadInvoice("invoice-1");
    await expect(request).rejects.toMatchObject({
      name: "ReceiptInvoiceError",
      code: "REVISION_CONFLICT",
    });
    await expect(request).rejects.toThrow("Invoice changed on disk.");
  });

  it("exposes revision-checked soft and hard invoice removal", async () => {
    const api = electron.exposeInMainWorld.mock.calls[0]?.[1] as DesktopApi;
    const result = {
      invoiceId: "invoice-1",
      invoiceName: "invoice-2026-01-01-2026-01-31",
      mode: "hard" as const,
      deletedAt: "2026-08-21T12:00:00.000Z",
    };
    const options = { expectedRevision: 4, hardDelete: true };
    electron.invoke.mockResolvedValue(result);

    await expect(api.removeInvoice("invoice-1", options)).resolves.toBe(result);
    expect(electron.invoke).toHaveBeenCalledWith(IPC.invoicesRemove, "invoice-1", options);
  });

  it("exposes persisted review acknowledgement updates", async () => {
    const api = electron.exposeInMainWorld.mock.calls[0]?.[1] as DesktopApi;
    const result = { invoice: { revision: 5 }, check: { revision: 5 } };
    const fingerprint = "b".repeat(64);
    electron.invoke.mockResolvedValue(result);

    await expect(api.setReviewAcknowledgement("invoice-1", fingerprint, false, 4)).resolves.toBe(
      result
    );
    expect(electron.invoke).toHaveBeenCalledWith(
      IPC.invoicesSetReviewAcknowledgement,
      "invoice-1",
      fingerprint,
      false,
      4
    );
  });

  it("exposes invoice output build and reveal calls", async () => {
    const api = electron.exposeInMainWorld.mock.calls[0]?.[1] as DesktopApi;
    const result = { outputPath: "/invoices/one/output", receiptCount: 3 };
    electron.invoke.mockReset();
    electron.invoke.mockResolvedValueOnce(result).mockResolvedValueOnce(undefined);

    await expect(api.buildInvoiceOutput("invoice-1")).resolves.toBe(result);
    expect(electron.invoke).toHaveBeenNthCalledWith(1, IPC.invoiceBuildOutput, "invoice-1");

    await expect(api.revealOutput("invoice-1")).resolves.toBeUndefined();
    expect(electron.invoke).toHaveBeenNthCalledWith(2, IPC.invoiceRevealOutput, "invoice-1");
  });
});
