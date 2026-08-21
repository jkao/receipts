import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InvoiceStore } from "./invoice-store";
import { InvoiceChecker } from "./invoice-checker";
import { ImportManager } from "./import-manager";
import { TrashManager } from "./trash-manager";
import type { OpenAiReceiptResult } from "./openai";

describe("ImportManager", () => {
  let baseFolder: string;
  let store: InvoiceStore;

  beforeEach(async () => {
    baseFolder = await fs.mkdtemp(path.join(os.tmpdir(), "receipt-import-test-"));
    store = new InvoiceStore(() => baseFolder, {
      now: () => new Date("2026-02-02T12:00:00.000Z"),
      idFactory: () => "inv_test",
    });
  });

  afterEach(async () => {
    await fs.rm(baseFolder, { recursive: true, force: true });
  });

  it("copies, scans, and deduplicates the same source", async () => {
    const invoice = await store.createInvoice({
      startDate: "2026-01-01",
      endDate: "2026-01-31",
    });
    const source = path.join(baseFolder, "outside-receipt.jpg");
    await fs.writeFile(source, "not-a-real-image-but-the-client-is-mocked");
    const events: string[] = [];
    const manager = new ImportManager(
      store,
      { getOpenAiKey: async () => "test-key" },
      (progress) => events.push(progress.status),
      () => ({
        extract: async () => successfulExtraction(),
      })
    );

    const first = await manager.importFiles(invoice.id, [source], {
      method: "drag-drop",
    });
    expect(first.importedCount).toBe(1);
    expect(first.errors).toEqual([]);
    expect(first.invoice.receipts).toHaveLength(1);
    expect(first.invoice.receipts[0].status).toBe("ready");
    expect(first.invoice.receipts[0].source.method).toBe("drag-drop");
    expect(first.invoice.rows[0]).toMatchObject({
      date: "2026-01-12",
      groceriesMinor: 1073,
      comment: "Key Foods",
    });
    expect(events).toContain("scanning");
    expect(events).toContain("ready");

    const folder = await store.getInvoiceFolder(invoice.id);
    await expect(
      fs.access(path.join(folder, first.invoice.receipts[0].relativePath))
    ).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(folder, first.invoice.receipts[0].debugPath))
    ).resolves.toBeUndefined();

    const second = await manager.importFiles(invoice.id, [source]);
    expect(second.importedCount).toBe(0);
    expect(second.duplicates).toHaveLength(1);
    expect(second.duplicates[0].sameInvoice).toBe(true);
    expect(second.invoice.rows).toHaveLength(1);
  });

  it("imports a batch sequentially and deduplicates repeated paths and content", async () => {
    const invoice = await store.createInvoice({
      startDate: "2026-01-01",
      endDate: "2026-01-31",
    });
    const first = path.join(baseFolder, "first.jpg");
    const second = path.join(baseFolder, "second.png");
    const sameAsFirst = path.join(baseFolder, "first-copy.pdf");
    await fs.writeFile(first, "first receipt bytes");
    await fs.writeFile(second, "second receipt bytes");
    await fs.writeFile(sameAsFirst, "first receipt bytes");

    const scanned: string[] = [];
    let activeScans = 0;
    let maximumActiveScans = 0;
    const manager = new ImportManager(
      store,
      { getOpenAiKey: async () => "test-key" },
      () => undefined,
      () => ({
        extract: async (_buffer, filename) => {
          activeScans += 1;
          maximumActiveScans = Math.max(maximumActiveScans, activeScans);
          scanned.push(filename);
          await Promise.resolve();
          activeScans -= 1;
          return successfulExtraction();
        },
      })
    );

    const result = await manager.importFiles(invoice.id, [first, second, first, sameAsFirst], {
      method: "drag-drop",
    });

    expect(result.importedCount).toBe(2);
    expect(result.errors).toEqual([]);
    expect(result.duplicates).toEqual([
      expect.objectContaining({
        path: sameAsFirst,
        filename: "first-copy.pdf",
        sameInvoice: true,
      }),
    ]);
    expect(scanned).toEqual(
      result.invoice.receipts.map((receipt) => path.basename(receipt.relativePath))
    );
    expect(maximumActiveScans).toBe(1);
    expect(result.invoice.receipts.map((receipt) => receipt.originalFilename)).toEqual([
      "first.jpg",
      "second.png",
    ]);
    expect(result.invoice.receipts.every((receipt) => receipt.source.method === "drag-drop")).toBe(
      true
    );
  });

  it("keeps the copied receipt editable when no API key is saved", async () => {
    const invoice = await store.createInvoice({
      startDate: "2026-03-01",
      endDate: "2026-03-31",
    });
    const source = path.join(baseFolder, "manual.pdf");
    await fs.writeFile(source, "%PDF-test");
    const manager = new ImportManager(store, { getOpenAiKey: async () => null }, () => undefined);

    const result = await manager.importFiles(invoice.id, [source]);
    expect(result.importedCount).toBe(1);
    expect(result.invoice.receipts[0].status).toBe("needs-key");
    expect(result.invoice.rows[0].groceriesMinor).toBeNull();
  });

  it("marks a receipt as errored when its managed file cannot be prepared", async () => {
    const invoice = await store.createInvoice({
      startDate: "2026-03-01",
      endDate: "2026-03-31",
    });
    const source = path.join(baseFolder, "missing-before-retry.pdf");
    await fs.writeFile(source, "%PDF-test");
    const withoutKey = new ImportManager(
      store,
      { getOpenAiKey: async () => null },
      () => undefined
    );
    const imported = await withoutKey.importFiles(invoice.id, [source]);
    const receipt = imported.invoice.receipts[0];
    const managedPath = path.join(await store.getInvoiceFolder(invoice.id), receipt.relativePath);
    await fs.rm(managedPath);

    const events: string[] = [];
    const withKey = new ImportManager(
      store,
      { getOpenAiKey: async () => "test-key" },
      (progress) => events.push(progress.status),
      () => ({ extract: async () => successfulExtraction() })
    );
    const retried = await withKey.retryReceipts(invoice.id, [receipt.id]);

    expect(retried.receipts[0]).toMatchObject({
      id: receipt.id,
      status: "error",
      error: expect.stringMatching(/ENOENT/),
    });
    expect(events).toEqual(["scanning", "error"]);
  });

  it("leaves deterministic date consistency findings to Invoice Check", async () => {
    const invoice = await store.createInvoice({
      startDate: "2026-01-01",
      endDate: "2026-01-31",
    });
    const source = path.join(baseFolder, "february-receipt.jpg");
    await fs.writeFile(source, "image");
    const extraction = successfulExtraction();
    extraction.extraction.date = "2026-02-01";
    const manager = new ImportManager(
      store,
      { getOpenAiKey: async () => "test-key" },
      () => undefined,
      () => ({ extract: async () => extraction })
    );

    const result = await manager.importFiles(invoice.id, [source]);
    expect(result.errors).toEqual([]);
    expect(result.invoice.receipts[0].status).toBe("ready");

    const debugPath = path.join(
      await store.getInvoiceFolder(invoice.id),
      result.invoice.receipts[0].debugPath
    );
    const debug = JSON.parse(await fs.readFile(debugPath, "utf8"));
    expect(debug.validationWarnings).toEqual([]);
    expect((await new InvoiceChecker(store).checkInvoice(invoice.id)).issues).toContainEqual(
      expect.objectContaining({
        code: "date-outside-period",
        rowIds: [result.invoice.rows[0].id],
        acknowledgeable: true,
      })
    );
  });

  it("keeps provider extraction warnings as receipt review findings", async () => {
    const invoice = await store.createInvoice({
      startDate: "2026-01-01",
      endDate: "2026-01-31",
    });
    const source = path.join(baseFolder, "warning-receipt.jpg");
    await fs.writeFile(source, "image");
    const extraction = successfulExtraction();
    extraction.validationWarnings = ["Verify the itemized sum against the total."];
    const manager = new ImportManager(
      store,
      { getOpenAiKey: async () => "test-key" },
      () => undefined,
      () => ({ extract: async () => extraction })
    );

    const result = await manager.importFiles(invoice.id, [source]);
    expect(result.invoice.receipts[0].status).toBe("needs-review");
    const debugPath = path.join(
      await store.getInvoiceFolder(invoice.id),
      result.invoice.receipts[0].debugPath
    );
    expect(JSON.parse(await fs.readFile(debugPath, "utf8")).validationWarnings).toEqual([
      "Verify the itemized sum against the total.",
    ]);
    expect((await new InvoiceChecker(store).checkInvoice(invoice.id)).issues).toContainEqual(
      expect.objectContaining({
        code: "receipt-scan-warning",
        acknowledgeable: true,
        message: "Verify the itemized sum against the total.",
      })
    );
  });

  it("rejects oversized receipts before hashing, copying, or scanning", async () => {
    const invoice = await store.createInvoice({
      startDate: "2026-05-01",
      endDate: "2026-05-31",
    });
    const source = path.join(baseFolder, "oversized.pdf");
    await fs.writeFile(source, "");
    await fs.truncate(source, 20 * 1024 * 1024 + 1);
    let scanned = false;
    const manager = new ImportManager(
      store,
      { getOpenAiKey: async () => "test-key" },
      () => undefined,
      () => ({
        extract: async () => {
          scanned = true;
          return successfulExtraction();
        },
      })
    );

    const result = await manager.importFiles(invoice.id, [source]);
    expect(result.importedCount).toBe(0);
    expect(result.invoice.receipts).toEqual([]);
    expect(result.errors[0]?.message).toMatch(/20 MB/);
    expect(scanned).toBe(false);
  });

  it("moves managed files to trash and restores the last deletion", async () => {
    const invoice = await store.createInvoice({
      startDate: "2026-04-01",
      endDate: "2026-04-30",
    });
    const source = path.join(baseFolder, "trash-test.png");
    await fs.writeFile(source, "image");
    const manager = new ImportManager(store, { getOpenAiKey: async () => null }, () => undefined);
    const imported = await manager.importFiles(invoice.id, [source]);
    const rowId = imported.invoice.rows[0].id;
    const receiptPath = path.join(
      await store.getInvoiceFolder(invoice.id),
      imported.invoice.receipts[0].relativePath
    );
    const trash = new TrashManager(store);

    const deleted = await trash.deleteRows(invoice.id, [rowId]);
    expect(deleted.rows).toHaveLength(0);
    expect(deleted.receipts).toHaveLength(0);
    await expect(fs.access(receiptPath)).rejects.toMatchObject({
      code: "ENOENT",
    });

    const restored = await trash.undoLastDelete(invoice.id);
    expect(restored.rows).toHaveLength(1);
    expect(restored.receipts).toHaveLength(1);
    await expect(fs.access(receiptPath)).resolves.toBeUndefined();
  });

  it("recovers an interrupted delete whose manifest was saved before metadata changed", async () => {
    const invoice = await store.createInvoice({
      startDate: "2026-04-01",
      endDate: "2026-04-30",
    });
    const source = path.join(baseFolder, "interrupted-delete.png");
    await fs.writeFile(source, "image");
    const manager = new ImportManager(store, { getOpenAiKey: async () => null }, () => undefined);
    const imported = await manager.importFiles(invoice.id, [source]);
    const current = imported.invoice;
    const receipt = current.receipts[0];
    const folder = await store.getInvoiceFolder(invoice.id);
    const entryFolder = path.join(folder, ".trash", "delete-interrupted");
    const trashedReceipt = path.join(entryFolder, receipt.relativePath);
    await fs.mkdir(path.dirname(trashedReceipt), { recursive: true });
    await fs.writeFile(
      path.join(entryFolder, "manifest.json"),
      `${JSON.stringify({
        invoiceId: invoice.id,
        deletedAt: "2026-08-21T12:00:00.000Z",
        rows: [{ index: 0, value: current.rows[0] }],
        receipts: [{ index: 0, value: receipt }],
        movedRelativePaths: [receipt.relativePath],
      })}\n`,
      "utf8"
    );
    const liveReceipt = path.join(folder, receipt.relativePath);
    await fs.rename(liveReceipt, trashedReceipt);

    const recovered = await new TrashManager(store).undoLastDelete(invoice.id);

    expect(recovered.revision).toBe(current.revision);
    expect(recovered.rows).toEqual(current.rows);
    expect(recovered.receipts).toEqual(current.receipts);
    await expect(fs.readFile(liveReceipt, "utf8")).resolves.toBe("image");
    await expect(fs.access(entryFolder)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never moves restored files back when trash cleanup fails after metadata commits", async () => {
    const invoice = await store.createInvoice({
      startDate: "2026-04-01",
      endDate: "2026-04-30",
    });
    const source = path.join(baseFolder, "cleanup-failure.png");
    await fs.writeFile(source, "image");
    const manager = new ImportManager(store, { getOpenAiKey: async () => null }, () => undefined);
    const imported = await manager.importFiles(invoice.id, [source]);
    const receipt = imported.invoice.receipts[0];
    const folder = await store.getInvoiceFolder(invoice.id);
    const liveReceipt = path.join(folder, receipt.relativePath);
    const trash = new TrashManager(store);
    await trash.deleteRows(invoice.id, [imported.invoice.rows[0].id]);

    const remove = vi.spyOn(fs, "rm").mockRejectedValueOnce(new Error("simulated cleanup failure"));
    let restored: Awaited<ReturnType<TrashManager["undoLastDelete"]>> | undefined;
    try {
      restored = await trash.undoLastDelete(invoice.id);
    } finally {
      remove.mockRestore();
    }

    expect(restored?.rows).toHaveLength(1);
    expect(restored?.receipts).toHaveLength(1);
    await expect(fs.readFile(liveReceipt, "utf8")).resolves.toBe("image");
    expect((await store.loadInvoice(invoice.id)).receipts[0].id).toBe(receipt.id);

    // The retained manifest is recognized as already restored and cleaned on
    // the next undo attempt rather than blocking or moving the live file.
    await expect(trash.undoLastDelete(invoice.id)).resolves.toMatchObject({
      receipts: [expect.objectContaining({ id: receipt.id })],
    });
    await expect(fs.readFile(liveReceipt, "utf8")).resolves.toBe("image");
  });

  it("refuses to traverse a symlinked trash root", async () => {
    const invoice = await store.createInvoice({
      startDate: "2026-04-01",
      endDate: "2026-04-30",
    });
    const folder = await store.getInvoiceFolder(invoice.id);
    const outside = path.join(baseFolder, "outside-trash");
    await fs.mkdir(outside);
    await fs.rm(path.join(folder, ".trash"), { recursive: true });
    await fs.symlink(outside, path.join(folder, ".trash"), "dir");

    await expect(new TrashManager(store).undoLastDelete(invoice.id)).rejects.toThrow(
      /ordinary directory/
    );
  });

  it("does not overwrite a re-imported managed file when undoing a deletion", async () => {
    const invoice = await store.createInvoice({
      startDate: "2026-06-01",
      endDate: "2026-06-30",
    });
    const source = path.join(baseFolder, "same-receipt.png");
    await fs.writeFile(source, "first version");
    const manager = new ImportManager(store, { getOpenAiKey: async () => null }, () => undefined);
    const trash = new TrashManager(store);

    const first = await manager.importFiles(invoice.id, [source]);
    await trash.deleteRows(invoice.id, [first.invoice.rows[0].id]);
    const second = await manager.importFiles(invoice.id, [source]);
    const managedPath = path.join(
      await store.getInvoiceFolder(invoice.id),
      second.invoice.receipts[0].relativePath
    );
    await fs.writeFile(managedPath, "new managed owner");

    await expect(trash.undoLastDelete(invoice.id)).rejects.toThrow(/managed path is in use/);
    expect(await fs.readFile(managedPath, "utf8")).toBe("new managed owner");
    const current = await store.loadInvoice(invoice.id);
    expect(current.rows).toHaveLength(1);
    expect(current.receipts).toHaveLength(1);
    expect(current.receipts[0].id).toBe(second.invoice.receipts[0].id);
  });
});

function successfulExtraction(): OpenAiReceiptResult {
  return {
    model: "gpt-5.6-luna",
    extraction: {
      merchant: "Key Foods",
      date: "2026-01-12",
      currency: "USD",
      subtotal: "10.00",
      tax: "0.73",
      tip: null,
      adjustments: [],
      total: "10.73",
      items: [
        {
          description: "Groceries",
          quantity: "1",
          unitPrice: "10.00",
          lineTotal: "10.00",
        },
      ],
    },
    validationWarnings: [],
    usage: {
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
    },
  };
}
