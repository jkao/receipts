import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ImportProgress } from "../shared/types";
import {
  ImportManager,
  RECEIPT_RENAME_JOURNAL_FILENAME,
  RECEIPT_SCAN_CONCURRENCY,
} from "./import-manager";
import { InvoiceChecker } from "./invoice-checker";
import { InvoiceStore } from "./invoice-store";
import type { OpenAiReceiptResult } from "./openai";
import { TrashManager } from "./trash-manager";

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
    expect(first.invoice.receipts[0].relativePath).toBe(
      path.join("receipts", "2026-01-12-key-foods-001.jpg")
    );
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

  it("increments same-date merchant names across file types", async () => {
    const invoice = await store.createInvoice({
      startDate: "2026-01-01",
      endDate: "2026-01-31",
    });
    const firstSource = path.join(baseFolder, "camera-one.JPG");
    const secondSource = path.join(baseFolder, "camera-two.PDF");
    await fs.writeFile(firstSource, "first Whole Foods receipt");
    await fs.writeFile(secondSource, "second Whole Foods receipt");
    const extraction = successfulExtraction();
    extraction.extraction.merchant = " Whôle Foods #12 ";
    const manager = new ImportManager(
      store,
      { getOpenAiKey: async () => "test-key" },
      () => undefined,
      () => ({ extract: async () => structuredClone(extraction) })
    );

    const first = await manager.importFiles(invoice.id, [firstSource]);
    const second = await manager.importFiles(invoice.id, [secondSource]);

    expect(first.invoice.receipts[0].relativePath).toBe(
      path.join("receipts", "2026-01-12-whole-foods-12-001.jpg")
    );
    expect(second.invoice.receipts.map((receipt) => receipt.relativePath)).toEqual([
      path.join("receipts", "2026-01-12-whole-foods-12-001.jpg"),
      path.join("receipts", "2026-01-12-whole-foods-12-002.pdf"),
    ]);
    const receiptFolder = path.join(await store.getInvoiceFolder(invoice.id), "receipts");
    expect((await fs.readdir(receiptFolder)).sort()).toEqual([
      "2026-01-12-whole-foods-12-001.jpg",
      "2026-01-12-whole-foods-12-002.pdf",
    ]);
  });

  it("keeps the provisional filename when extraction lacks a merchant", async () => {
    const invoice = await store.createInvoice({
      startDate: "2026-01-01",
      endDate: "2026-01-31",
    });
    const source = path.join(baseFolder, "merchant-missing.WEBP");
    await fs.writeFile(source, "receipt without a detected merchant");
    const extraction = successfulExtraction();
    extraction.extraction.merchant = null;
    extraction.validationWarnings = ["Merchant was not found."];
    const manager = new ImportManager(
      store,
      { getOpenAiKey: async () => "test-key" },
      () => undefined,
      () => ({ extract: async () => extraction })
    );

    const result = await manager.importFiles(invoice.id, [source]);

    expect(path.basename(result.invoice.receipts[0].relativePath)).toMatch(
      /^r_[a-f0-9]{12}__merchant-missing\.webp$/
    );
    expect(result.invoice.receipts[0].status).toBe("needs-review");
  });

  it("rolls a managed filename back when the extraction metadata commit fails", async () => {
    const invoice = await store.createInvoice({
      startDate: "2026-01-01",
      endDate: "2026-01-31",
    });
    const source = path.join(baseFolder, "rename-rollback.jpg");
    await fs.writeFile(source, "rename rollback receipt");
    const originalMutateInvoice = store.mutateInvoice.bind(store);
    let mutationCount = 0;
    vi.spyOn(store, "mutateInvoice").mockImplementation(
      (targetInvoiceId, mutator, expectedRevision) => {
        mutationCount += 1;
        if (mutationCount === 3) {
          return Promise.reject(new Error("simulated extraction metadata failure"));
        }
        return originalMutateInvoice(targetInvoiceId, mutator, expectedRevision);
      }
    );
    const manager = new ImportManager(
      store,
      { getOpenAiKey: async () => "test-key" },
      () => undefined,
      () => ({ extract: async () => successfulExtraction() })
    );

    const result = await manager.importFiles(invoice.id, [source]);
    const provisionalName = path.basename(result.invoice.receipts[0].relativePath);
    const receiptFolder = path.join(await store.getInvoiceFolder(invoice.id), "receipts");

    expect(result.errors).toEqual([
      { filename: "rename-rollback.jpg", message: "simulated extraction metadata failure" },
    ]);
    expect(result.invoice.receipts[0].status).toBe("error");
    expect(provisionalName).toMatch(/^r_[a-f0-9]{12}__rename-rollback\.jpg$/);
    expect(await fs.readdir(receiptFolder)).toEqual([provisionalName]);
  });

  it("recovers an interrupted sortable copy before retrying the receipt", async () => {
    const invoice = await store.createInvoice({
      startDate: "2026-01-01",
      endDate: "2026-01-31",
    });
    const source = path.join(baseFolder, "interrupted-name.jpg");
    await fs.writeFile(source, "interrupted sortable receipt copy");
    let apiKey: string | null = null;
    const manager = new ImportManager(
      store,
      { getOpenAiKey: async () => apiKey },
      () => undefined,
      () => ({ extract: async () => successfulExtraction() })
    );
    const imported = await manager.importFiles(invoice.id, [source]);
    const receipt = imported.invoice.receipts[0];
    const invoiceFolder = await store.getInvoiceFolder(invoice.id);
    const previousPath = path.join(invoiceFolder, receipt.relativePath);
    const nextRelativePath = path.join("receipts", "2026-01-12-key-foods-001.jpg");
    const nextPath = path.join(invoiceFolder, nextRelativePath);
    await fs.copyFile(previousPath, nextPath);
    await fs.writeFile(
      path.join(invoiceFolder, RECEIPT_RENAME_JOURNAL_FILENAME),
      `${JSON.stringify({
        schemaVersion: 1,
        invoiceId: invoice.id,
        receiptId: receipt.id,
        previousRelativePath: receipt.relativePath,
        nextRelativePath,
        sha256: receipt.sha256,
      })}\n`,
      "utf8"
    );

    apiKey = "test-key";
    const retried = await manager.retryReceipts(invoice.id, [receipt.id]);

    expect(retried.receipts[0]).toMatchObject({ relativePath: nextRelativePath, status: "ready" });
    expect(await fs.readdir(path.join(invoiceFolder, "receipts"))).toEqual([
      "2026-01-12-key-foods-001.jpg",
    ]);
    await expect(
      fs.access(path.join(invoiceFolder, RECEIPT_RENAME_JOURNAL_FILENAME))
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("prepares a batch before scanning and deduplicates paths and content in one lookup", async () => {
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
    let batchDurableBeforeFirstScan = false;
    const concurrentScansStarted = deferred<void>();
    const getOpenAiKey = vi.fn(async () => "test-key");
    const createClient = vi.fn(() => ({
      extract: async (_buffer: Buffer, filename: string) => {
        activeScans += 1;
        maximumActiveScans = Math.max(maximumActiveScans, activeScans);
        scanned.push(filename);
        if (scanned.length === 1) {
          const prepared = await store.loadInvoice(invoice.id);
          batchDurableBeforeFirstScan =
            prepared.receipts.length === 2 &&
            prepared.rows.length === 2 &&
            prepared.receipts.every((receipt) => ["queued", "scanning"].includes(receipt.status));
        }
        if (activeScans === RECEIPT_SCAN_CONCURRENCY) concurrentScansStarted.resolve();
        await concurrentScansStarted.promise;
        activeScans -= 1;
        return successfulExtraction();
      },
    }));
    const findHashes = vi.spyOn(store, "findHashes");
    const findHash = vi.spyOn(store, "findHash");
    const manager = new ImportManager(store, { getOpenAiKey }, () => undefined, createClient);

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
    expect(scanned).toEqual([
      expect.stringMatching(/^r_[a-f0-9]{12}__first\.jpg$/),
      expect.stringMatching(/^r_[a-f0-9]{12}__second\.png$/),
    ]);
    const storedFilenames = result.invoice.receipts.map((receipt) =>
      path.basename(receipt.relativePath)
    );
    expect(storedFilenames).toEqual([
      expect.stringMatching(/^2026-01-12-key-foods-\d{3}\.jpg$/),
      expect.stringMatching(/^2026-01-12-key-foods-\d{3}\.png$/),
    ]);
    expect(storedFilenames.map((filename) => filename.match(/-(\d{3})\./)?.[1]).sort()).toEqual([
      "001",
      "002",
    ]);
    expect(batchDurableBeforeFirstScan).toBe(true);
    expect(maximumActiveScans).toBe(RECEIPT_SCAN_CONCURRENCY);
    expect(findHashes).toHaveBeenCalledTimes(1);
    expect(findHash).not.toHaveBeenCalled();
    expect(getOpenAiKey).toHaveBeenCalledTimes(1);
    expect(createClient).toHaveBeenCalledTimes(1);
    expect(result.invoice.receipts.map((receipt) => receipt.originalFilename)).toEqual([
      "first.jpg",
      "second.png",
    ]);
    expect(result.invoice.receipts.every((receipt) => receipt.source.method === "drag-drop")).toBe(
      true
    );
  });

  it("shares one provider limit across invoice batches and retries", async () => {
    let nextId = 0;
    store = new InvoiceStore(() => baseFolder, {
      now: () => new Date("2026-02-02T12:00:00.000Z"),
      idFactory: () => `inv_${++nextId}`,
    });
    const firstInvoice = await store.createInvoice({
      startDate: "2026-01-01",
      endDate: "2026-01-31",
    });
    const secondInvoice = await store.createInvoice({
      startDate: "2026-02-01",
      endDate: "2026-02-28",
    });
    const retryInvoice = await store.createInvoice({
      startDate: "2026-03-01",
      endDate: "2026-03-31",
    });
    const firstSources = [
      path.join(baseFolder, "global-first-a.jpg"),
      path.join(baseFolder, "global-first-b.jpg"),
    ];
    const secondSources = [
      path.join(baseFolder, "global-second-a.jpg"),
      path.join(baseFolder, "global-second-b.jpg"),
    ];
    const retrySource = path.join(baseFolder, "global-retry.jpg");
    await Promise.all(
      [...firstSources, ...secondSources, retrySource].map((filename, index) =>
        fs.writeFile(filename, `unique global receipt ${index}`)
      )
    );

    const queued = await new ImportManager(
      store,
      { getOpenAiKey: async () => null },
      () => undefined
    ).importFiles(retryInvoice.id, [retrySource]);
    const extractionStarted = Array.from({ length: 5 }, () => deferred<void>());
    const releaseExtraction = Array.from({ length: 5 }, () => deferred<void>());
    let startedCount = 0;
    let activeExtractions = 0;
    let maximumActiveExtractions = 0;
    const manager = new ImportManager(
      store,
      { getOpenAiKey: async () => "test-key" },
      () => undefined,
      () => ({
        extract: async () => {
          const index = startedCount;
          startedCount += 1;
          activeExtractions += 1;
          maximumActiveExtractions = Math.max(maximumActiveExtractions, activeExtractions);
          extractionStarted[index].resolve();
          await releaseExtraction[index].promise;
          activeExtractions -= 1;
          return successfulExtraction();
        },
      })
    );

    const first = manager.importFiles(firstInvoice.id, firstSources);
    const second = manager.importFiles(secondInvoice.id, secondSources);
    const retry = manager.retryReceipts(retryInvoice.id, [queued.invoice.receipts[0].id]);

    await Promise.all([extractionStarted[0].promise, extractionStarted[1].promise]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(startedCount).toBe(RECEIPT_SCAN_CONCURRENCY);
    expect(activeExtractions).toBe(RECEIPT_SCAN_CONCURRENCY);

    for (let completed = 0; completed < 3; completed += 1) {
      releaseExtraction[completed].resolve();
      await extractionStarted[completed + RECEIPT_SCAN_CONCURRENCY].promise;
      expect(activeExtractions).toBeLessThanOrEqual(RECEIPT_SCAN_CONCURRENCY);
    }
    releaseExtraction[3].resolve();
    releaseExtraction[4].resolve();

    const [firstResult, secondResult, retryResult] = await Promise.all([first, second, retry]);
    expect(maximumActiveExtractions).toBe(RECEIPT_SCAN_CONCURRENCY);
    expect(firstResult.invoice.receipts.every((receipt) => receipt.status === "ready")).toBe(true);
    expect(secondResult.invoice.receipts.every((receipt) => receipt.status === "ready")).toBe(true);
    expect(retryResult.receipts.every((receipt) => receipt.status === "ready")).toBe(true);
  });

  it("returns a durable queued snapshot before a background scan completes", async () => {
    const invoice = await store.createInvoice({
      startDate: "2026-01-01",
      endDate: "2026-01-31",
    });
    const source = path.join(baseFolder, "background.jpg");
    await fs.writeFile(source, "background receipt bytes");
    const releaseScan = deferred<void>();
    const scanStarted = deferred<void>();
    const events: Array<{ jobId?: string; status: string }> = [];
    const manager = new ImportManager(
      store,
      { getOpenAiKey: async () => "test-key" },
      (progress) => events.push({ jobId: progress.jobId, status: progress.status }),
      () => ({
        extract: async () => {
          scanStarted.resolve();
          await releaseScan.promise;
          return successfulExtraction();
        },
      })
    );

    const started = await manager.startImport(invoice.id, [source], { method: "drag-drop" });

    expect(started.jobId).toMatch(/^import_/);
    expect(started.importedCount).toBe(1);
    expect(started.invoice.receipts).toMatchObject([
      { originalFilename: "background.jpg", status: "queued" },
    ]);
    expect(
      await fs.readFile(
        path.join(
          await store.getInvoiceFolder(invoice.id),
          started.invoice.receipts[0].relativePath
        ),
        "utf8"
      )
    ).toBe("background receipt bytes");

    await scanStarted.promise;
    releaseScan.resolve();
    await vi.waitFor(() => {
      expect(events).toContainEqual({ jobId: started.jobId, status: "complete" });
    });
    expect(
      events.filter((event) => event.jobId === started.jobId && event.status === "complete")
    ).toHaveLength(1);
    await expect(store.loadInvoice(invoice.id)).resolves.toMatchObject({
      receipts: [{ status: "ready" }],
    });
    expect(
      events.filter((event) => event.jobId === started.jobId).map((event) => event.status)
    ).toEqual(["copying", "scanning", "ready", "complete"]);
  });

  it("terminates renderer progress when background preparation cannot finish", async () => {
    const invoice = await store.createInvoice({
      startDate: "2026-01-01",
      endDate: "2026-01-31",
    });
    const source = path.join(baseFolder, "prepare-failure.jpg");
    await fs.writeFile(source, "prepare failure bytes");
    vi.spyOn(store, "findHashes").mockRejectedValueOnce(new Error("history unavailable"));
    const events: ImportProgress[] = [];
    const manager = new ImportManager(store, { getOpenAiKey: async () => "test-key" }, (progress) =>
      events.push(progress)
    );

    await expect(manager.startImport(invoice.id, [source])).rejects.toThrow("history unavailable");

    const jobId = events[0]?.jobId;
    expect(jobId).toMatch(/^import_/);
    expect(events.filter((event) => event.jobId === jobId).map((event) => event.status)).toEqual([
      "copying",
    ]);
    expect(events.at(-1)).toMatchObject({
      status: "failed",
      message: "Import could not start: history unavailable",
    });
    expect(events.at(-1)?.jobId).toBeUndefined();
  });

  it("aborts the active provider request and leaves unfinished receipts queued", async () => {
    const invoice = await store.createInvoice({
      startDate: "2026-01-01",
      endDate: "2026-01-31",
    });
    const source = path.join(baseFolder, "cancel-background.pdf");
    await fs.writeFile(source, "%PDF-background");
    const scanStarted = deferred<void>();
    const events: Array<{ jobId?: string; status: string }> = [];
    let providerSignal: AbortSignal | undefined;
    const manager = new ImportManager(
      store,
      { getOpenAiKey: async () => "test-key" },
      (progress) => events.push({ jobId: progress.jobId, status: progress.status }),
      () => ({
        extract: async (_buffer, _filename, _mimeType, signal) => {
          providerSignal = signal;
          scanStarted.resolve();
          return new Promise<OpenAiReceiptResult>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        },
      })
    );
    const started = await manager.startImport(invoice.id, [source]);
    await scanStarted.promise;

    expect(manager.cancelImport(started.jobId)).toEqual({
      jobId: started.jobId,
      cancelled: true,
    });
    expect(providerSignal?.aborted).toBe(true);
    await vi.waitFor(() => {
      expect(events).toContainEqual({ jobId: started.jobId, status: "cancelled" });
    });
    expect(
      events.filter((event) => event.jobId === started.jobId && event.status === "cancelled")
    ).toHaveLength(1);

    const current = await store.loadInvoice(invoice.id);
    expect(current.receipts).toMatchObject([{ status: "queued" }]);
    expect(current.receipts[0].error).toBeUndefined();
    expect(events.some((event) => event.jobId === started.jobId && event.status === "error")).toBe(
      false
    );
    expect(manager.cancelImport(started.jobId)).toEqual({
      jobId: started.jobId,
      cancelled: false,
    });
  });

  it("removes debug JSON when cancellation wins after its rename but before invoice commit", async () => {
    const invoice = await store.createInvoice({
      startDate: "2026-01-01",
      endDate: "2026-01-31",
    });
    const source = path.join(baseFolder, "cancel-after-debug.jpg");
    await fs.writeFile(source, "cancel after debug bytes");
    const debugRenamed = deferred<void>();
    const releaseDebugWrite = deferred<void>();
    const events: Array<{ jobId?: string; status: string }> = [];
    const originalRename = fs.rename.bind(fs);
    const rename = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      await originalRename(from, to);
      if (String(to).includes(`${path.sep}debug${path.sep}`) && String(to).endsWith(".json")) {
        debugRenamed.resolve();
        await releaseDebugWrite.promise;
      }
    });
    const manager = new ImportManager(
      store,
      { getOpenAiKey: async () => "test-key" },
      (progress) => events.push({ jobId: progress.jobId, status: progress.status }),
      () => ({ extract: async () => successfulExtraction() })
    );

    let started: Awaited<ReturnType<ImportManager["startImport"]>> | undefined;
    try {
      started = await manager.startImport(invoice.id, [source]);
      await debugRenamed.promise;
      const folder = await store.getInvoiceFolder(invoice.id);
      const debugPath = path.join(folder, started.invoice.receipts[0].debugPath);
      await expect(fs.access(debugPath)).resolves.toBeUndefined();

      expect(manager.cancelImport(started.jobId)).toEqual({
        jobId: started.jobId,
        cancelled: true,
      });
      releaseDebugWrite.resolve();
      await vi.waitFor(() => {
        expect(events).toContainEqual({ jobId: started?.jobId, status: "cancelled" });
      });

      await expect(fs.access(debugPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(store.loadInvoice(invoice.id)).resolves.toMatchObject({
        receipts: [{ status: "queued" }],
      });
    } finally {
      releaseDebugWrite.resolve();
      rename.mockRestore();
    }
  });

  it("cancels a background scan waiting for a shared provider permit", async () => {
    let nextId = 0;
    store = new InvoiceStore(() => baseFolder, {
      now: () => new Date("2026-02-02T12:00:00.000Z"),
      idFactory: () => `inv_${++nextId}`,
    });
    const activeInvoice = await store.createInvoice({
      startDate: "2026-01-01",
      endDate: "2026-01-31",
    });
    const waitingInvoice = await store.createInvoice({
      startDate: "2026-02-01",
      endDate: "2026-02-28",
    });
    const activeSources = [
      path.join(baseFolder, "permit-active-a.jpg"),
      path.join(baseFolder, "permit-active-b.jpg"),
    ];
    const waitingSource = path.join(baseFolder, "permit-waiting.jpg");
    await Promise.all(
      [...activeSources, waitingSource].map((filename, index) =>
        fs.writeFile(filename, `unique permit receipt ${index}`)
      )
    );
    const activeStarted = deferred<void>();
    const releaseActive = deferred<void>();
    const events: Array<{ jobId?: string; status: string }> = [];
    let activeCount = 0;
    let waitingExtracted = false;
    const manager = new ImportManager(
      store,
      { getOpenAiKey: async () => "test-key" },
      (progress) => events.push({ jobId: progress.jobId, status: progress.status }),
      () => ({
        extract: async (_buffer, filename) => {
          if (filename.includes("permit-waiting")) {
            waitingExtracted = true;
          } else {
            activeCount += 1;
            if (activeCount === RECEIPT_SCAN_CONCURRENCY) activeStarted.resolve();
            await releaseActive.promise;
          }
          return successfulExtraction();
        },
      })
    );

    const activeJob = await manager.startImport(activeInvoice.id, activeSources);
    await activeStarted.promise;
    const waitingJob = await manager.startImport(waitingInvoice.id, [waitingSource]);
    const internals = manager as unknown as {
      activeJobs: Map<string, { state: "queued" | "running" }>;
    };
    await vi.waitFor(() => {
      expect(internals.activeJobs.get(waitingJob.jobId)?.state).toBe("running");
    });

    expect(manager.cancelImport(waitingJob.jobId)).toEqual({
      jobId: waitingJob.jobId,
      cancelled: true,
    });
    await vi.waitFor(() => {
      expect(events).toContainEqual({ jobId: waitingJob.jobId, status: "cancelled" });
    });
    expect(waitingExtracted).toBe(false);
    await expect(store.loadInvoice(waitingInvoice.id)).resolves.toMatchObject({
      receipts: [{ status: "queued" }],
    });

    releaseActive.resolve();
    await vi.waitFor(() => {
      expect(events).toContainEqual({ jobId: activeJob.jobId, status: "complete" });
    });
  });

  it("fails an unexpected background scheduler error and requeues scanning receipts", async () => {
    const invoice = await store.createInvoice({
      startDate: "2026-01-01",
      endDate: "2026-01-31",
    });
    const source = path.join(baseFolder, "unexpected-scheduler-error.jpg");
    await fs.writeFile(source, "unexpected scheduler bytes");
    const events: ImportProgress[] = [];
    const manager = new ImportManager(
      store,
      { getOpenAiKey: async () => "test-key" },
      (progress) => events.push(progress),
      () => ({ extract: async () => successfulExtraction() })
    );
    const internals = manager as unknown as {
      scanPreparedBatch(batch: {
        invoiceId: string;
        scans: Array<{ receipt: { id: string } }>;
      }): Promise<"complete" | "cancelled">;
    };
    vi.spyOn(internals, "scanPreparedBatch").mockImplementation(async (batch) => {
      await store.mutateInvoice(batch.invoiceId, (current) => {
        const receipt = current.receipts.find(
          (candidate) => candidate.id === batch.scans[0].receipt.id
        );
        if (receipt) receipt.status = "scanning";
      });
      throw new Error("simulated scheduler failure");
    });

    const started = await manager.startImport(invoice.id, [source]);
    await vi.waitFor(() => {
      expect(events).toContainEqual(
        expect.objectContaining({ jobId: started.jobId, status: "failed" })
      );
    });

    expect(
      events.filter((event) => event.jobId === started.jobId && event.status === "failed")
    ).toHaveLength(1);
    expect(events).not.toContainEqual(
      expect.objectContaining({ jobId: started.jobId, status: "complete" })
    );
    expect(events.at(-1)?.message).toContain("Receipt import stopped: simulated scheduler failure");
    await expect(store.loadInvoice(invoice.id)).resolves.toMatchObject({
      receipts: [{ status: "queued" }],
    });
  });

  it("fails and reconciles the batch when persisting a receipt error initially fails", async () => {
    const invoice = await store.createInvoice({
      startDate: "2026-01-01",
      endDate: "2026-01-31",
    });
    const source = path.join(baseFolder, "error-state-write-failure.jpg");
    await fs.writeFile(source, "error state write failure bytes");
    const events: ImportProgress[] = [];
    const originalMutateInvoice = store.mutateInvoice.bind(store);
    let mutationCount = 0;
    vi.spyOn(store, "mutateInvoice").mockImplementation(
      (targetInvoiceId, mutator, expectedRevision) => {
        mutationCount += 1;
        if (mutationCount === 3) {
          return Promise.reject(new Error("could not persist receipt error"));
        }
        return originalMutateInvoice(targetInvoiceId, mutator, expectedRevision);
      }
    );
    const manager = new ImportManager(
      store,
      { getOpenAiKey: async () => "test-key" },
      (progress) => events.push(progress),
      () => ({
        extract: async () => {
          throw new Error("provider unavailable");
        },
      })
    );

    const started = await manager.startImport(invoice.id, [source]);
    await vi.waitFor(() => {
      expect(events).toContainEqual(
        expect.objectContaining({ jobId: started.jobId, status: "failed" })
      );
    });

    expect(events).not.toContainEqual(
      expect.objectContaining({ jobId: started.jobId, status: "complete" })
    );
    expect(events.at(-1)?.message).toContain("Could not persist receipt");
    await expect(store.loadInvoice(invoice.id)).resolves.toMatchObject({
      receipts: [{ status: "queued" }],
    });
  });

  it("reports failed instead of cancelled when the queued-state write needs reconciliation", async () => {
    const invoice = await store.createInvoice({
      startDate: "2026-01-01",
      endDate: "2026-01-31",
    });
    const source = path.join(baseFolder, "cancel-state-write-failure.jpg");
    await fs.writeFile(source, "cancel state write failure bytes");
    const scanStarted = deferred<void>();
    const events: ImportProgress[] = [];
    const originalMutateInvoice = store.mutateInvoice.bind(store);
    let mutationCount = 0;
    vi.spyOn(store, "mutateInvoice").mockImplementation(
      (targetInvoiceId, mutator, expectedRevision) => {
        mutationCount += 1;
        if (mutationCount === 3) {
          return Promise.reject(new Error("could not persist queued state"));
        }
        return originalMutateInvoice(targetInvoiceId, mutator, expectedRevision);
      }
    );
    const manager = new ImportManager(
      store,
      { getOpenAiKey: async () => "test-key" },
      (progress) => events.push(progress),
      () => ({
        extract: async (_buffer, _filename, _mimeType, signal) => {
          scanStarted.resolve();
          return new Promise<OpenAiReceiptResult>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        },
      })
    );

    const started = await manager.startImport(invoice.id, [source]);
    await scanStarted.promise;
    expect(manager.cancelImport(started.jobId).cancelled).toBe(true);
    await vi.waitFor(() => {
      expect(events).toContainEqual(
        expect.objectContaining({ jobId: started.jobId, status: "failed" })
      );
    });

    expect(events).not.toContainEqual(
      expect.objectContaining({ jobId: started.jobId, status: "cancelled" })
    );
    await expect(store.loadInvoice(invoice.id)).resolves.toMatchObject({
      receipts: [{ status: "queued" }],
    });
  });

  it("lets a final extraction commit win a cancellation race", async () => {
    const invoice = await store.createInvoice({
      startDate: "2026-01-01",
      endDate: "2026-01-31",
    });
    const source = path.join(baseFolder, "commit-race.jpg");
    await fs.writeFile(source, "commit race bytes");
    const commitStarted = deferred<void>();
    const releaseCommit = deferred<void>();
    const events: Array<{ jobId?: string; status: string }> = [];
    const originalMutateInvoice = store.mutateInvoice.bind(store);
    let mutationCount = 0;
    vi.spyOn(store, "mutateInvoice").mockImplementation(
      (targetInvoiceId, mutator, expectedRevision) => {
        mutationCount += 1;
        if (mutationCount !== 3) {
          return originalMutateInvoice(targetInvoiceId, mutator, expectedRevision);
        }
        return originalMutateInvoice(
          targetInvoiceId,
          async (draft) => {
            const returned = await mutator(draft);
            commitStarted.resolve();
            await releaseCommit.promise;
            return returned;
          },
          expectedRevision
        );
      }
    );
    const manager = new ImportManager(
      store,
      { getOpenAiKey: async () => "test-key" },
      (progress) => events.push({ jobId: progress.jobId, status: progress.status }),
      () => ({ extract: async () => successfulExtraction() })
    );
    const started = await manager.startImport(invoice.id, [source]);
    await commitStarted.promise;

    expect(manager.cancelImport(started.jobId)).toEqual({
      jobId: started.jobId,
      cancelled: true,
    });
    releaseCommit.resolve();
    await vi.waitFor(() => {
      expect(events).toContainEqual({ jobId: started.jobId, status: "complete" });
    });

    expect(
      events.filter((event) => event.jobId === started.jobId && event.status === "complete")
    ).toHaveLength(1);
    expect(events).not.toContainEqual({ jobId: started.jobId, status: "cancelled" });
    await expect(store.loadInvoice(invoice.id)).resolves.toMatchObject({
      receipts: [{ status: "ready" }],
      rows: [
        {
          date: "2026-01-12",
          groceriesMinor: 1073,
          comment: "Key Foods",
        },
      ],
    });
  });

  it("serializes background scan jobs for the same invoice", async () => {
    const invoice = await store.createInvoice({
      startDate: "2026-01-01",
      endDate: "2026-01-31",
    });
    const first = path.join(baseFolder, "serialized-first.jpg");
    const second = path.join(baseFolder, "serialized-second.png");
    await fs.writeFile(first, "serialized first bytes");
    await fs.writeFile(second, "serialized second bytes");
    const releases = [deferred<void>(), deferred<void>()];
    const starts = [deferred<void>(), deferred<void>()];
    const events: Array<{ jobId?: string; status: string }> = [];
    let activeScans = 0;
    let maximumActiveScans = 0;
    let scanIndex = 0;
    const manager = new ImportManager(
      store,
      { getOpenAiKey: async () => "test-key" },
      (progress) => events.push({ jobId: progress.jobId, status: progress.status }),
      () => ({
        extract: async () => {
          const current = scanIndex++;
          activeScans += 1;
          maximumActiveScans = Math.max(maximumActiveScans, activeScans);
          starts[current].resolve();
          await releases[current].promise;
          activeScans -= 1;
          return successfulExtraction();
        },
      })
    );

    const firstJob = await manager.startImport(invoice.id, [first]);
    await starts[0].promise;
    const secondJob = await manager.startImport(invoice.id, [second]);
    expect(secondJob.invoice.receipts).toHaveLength(2);
    expect(scanIndex).toBe(1);

    releases[0].resolve();
    await starts[1].promise;
    expect(maximumActiveScans).toBe(1);
    releases[1].resolve();
    await vi.waitFor(() => {
      expect(
        events.filter((event) => event.status === "complete").map((event) => event.jobId)
      ).toEqual([firstJob.jobId, secondJob.jobId]);
    });
    expect(
      (await store.loadInvoice(invoice.id)).receipts.every((receipt) => receipt.status === "ready")
    ).toBe(true);
  });

  it("queues a no-key batch with one settings read and one invoice mutation", async () => {
    const invoice = await store.createInvoice({
      startDate: "2026-03-01",
      endDate: "2026-03-31",
    });
    const source = path.join(baseFolder, "manual.pdf");
    const secondSource = path.join(baseFolder, "manual-two.png");
    await fs.writeFile(source, "%PDF-test");
    await fs.writeFile(secondSource, "image-test");
    const getOpenAiKey = vi.fn(async () => null);
    const mutateInvoice = vi.spyOn(store, "mutateInvoice");
    const manager = new ImportManager(store, { getOpenAiKey }, () => undefined);

    const result = await manager.importFiles(invoice.id, [source, secondSource]);
    expect(result.importedCount).toBe(2);
    expect(result.invoice.receipts.every((receipt) => receipt.status === "needs-key")).toBe(true);
    expect(result.invoice.rows[0].groceriesMinor).toBeNull();
    expect(getOpenAiKey).toHaveBeenCalledTimes(1);
    expect(mutateInvoice).toHaveBeenCalledTimes(1);
  });

  it("rolls back every copied file when the batch metadata mutation fails", async () => {
    const invoice = await store.createInvoice({
      startDate: "2026-03-01",
      endDate: "2026-03-31",
    });
    const first = path.join(baseFolder, "rollback-first.jpg");
    const second = path.join(baseFolder, "rollback-second.png");
    await fs.writeFile(first, "first rollback bytes");
    await fs.writeFile(second, "second rollback bytes");
    vi.spyOn(store, "mutateInvoice").mockRejectedValueOnce(new Error("simulated metadata failure"));
    const manager = new ImportManager(
      store,
      { getOpenAiKey: async () => "test-key" },
      () => undefined,
      () => ({ extract: async () => successfulExtraction() })
    );

    const result = await manager.importFiles(invoice.id, [first, second]);
    const receiptFolder = path.join(await store.getInvoiceFolder(invoice.id), "receipts");

    expect(result.importedCount).toBe(0);
    expect(result.invoice.receipts).toEqual([]);
    expect(result.errors).toEqual([
      { filename: "rollback-first.jpg", message: "simulated metadata failure" },
      { filename: "rollback-second.png", message: "simulated metadata failure" },
    ]);
    expect(await fs.readdir(receiptFolder)).toEqual([]);
  });

  it("requires confirmation for cross-invoice hashes and still permits an explicit import", async () => {
    let nextId = 0;
    store = new InvoiceStore(() => baseFolder, {
      now: () => new Date("2026-02-02T12:00:00.000Z"),
      idFactory: () => `inv_${++nextId}`,
    });
    const firstInvoice = await store.createInvoice({
      startDate: "2026-01-01",
      endDate: "2026-01-31",
    });
    const secondInvoice = await store.createInvoice({
      startDate: "2026-02-01",
      endDate: "2026-02-28",
    });
    const source = path.join(baseFolder, "cross-invoice.jpg");
    await fs.writeFile(source, "same receipt content");
    const manager = new ImportManager(store, { getOpenAiKey: async () => null }, () => undefined);
    await manager.importFiles(firstInvoice.id, [source]);

    const blocked = await manager.importFiles(secondInvoice.id, [source]);
    expect(blocked).toMatchObject({
      importedCount: 0,
      duplicates: [
        {
          path: source,
          filename: "cross-invoice.jpg",
          matchInvoiceName: firstInvoice.name,
          sameInvoice: false,
        },
      ],
    });

    const allowed = await manager.importFiles(secondInvoice.id, [source], {
      allowCrossInvoiceDuplicates: true,
    });
    expect(allowed.importedCount).toBe(1);
    expect(allowed.invoice.receipts).toHaveLength(1);
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

  it("automatically combines one scanned receipt with one same-date work row", async () => {
    const invoice = await store.createInvoice({
      startDate: "2026-01-01",
      endDate: "2026-01-31",
    });
    await store.saveRows(
      invoice.id,
      [
        {
          id: "row-work",
          date: "2026-01-12",
          groceriesMinor: null,
          hours: "2.75",
          rateMinor: 5_500,
          comment: "",
          receiptId: null,
        },
      ],
      invoice.revision
    );
    const source = path.join(baseFolder, "single-same-day.jpg");
    await fs.writeFile(source, "single same-day receipt");
    const manager = new ImportManager(
      store,
      { getOpenAiKey: async () => "test-key" },
      () => undefined,
      () => ({ extract: async () => successfulExtraction() })
    );

    const imported = await manager.importFiles(invoice.id, [source]);

    expect(imported.invoice.rows).toEqual([
      expect.objectContaining({
        date: "2026-01-12",
        groceriesMinor: 1_073,
        hours: "2.75",
        rateMinor: 5_500,
        comment: "Key Foods",
        receiptId: imported.invoice.receipts[0].id,
      }),
    ]);
  });

  it("keeps N receipt rows plus one work row when same-date receipts exceed one", async () => {
    const invoice = await store.createInvoice({
      startDate: "2026-01-01",
      endDate: "2026-01-31",
    });
    await store.saveRows(
      invoice.id,
      [
        {
          id: "row-work",
          date: "2026-01-12",
          groceriesMinor: null,
          hours: "4",
          rateMinor: 6_000,
          comment: "",
          receiptId: null,
        },
      ],
      invoice.revision
    );
    const first = path.join(baseFolder, "same-day-first.jpg");
    const second = path.join(baseFolder, "same-day-second.png");
    await fs.writeFile(first, "same-day first receipt");
    await fs.writeFile(second, "same-day second receipt");
    const manager = new ImportManager(
      store,
      { getOpenAiKey: async () => "test-key" },
      () => undefined,
      () => ({ extract: async () => successfulExtraction() })
    );

    const imported = await manager.importFiles(invoice.id, [first, second]);
    const receiptRows = imported.invoice.rows.filter((candidate) => candidate.receiptId !== null);
    const workRows = imported.invoice.rows.filter((candidate) => candidate.receiptId === null);

    expect(imported.invoice.rows).toHaveLength(3);
    expect(receiptRows).toHaveLength(2);
    expect(receiptRows).toEqual([
      expect.objectContaining({ date: "2026-01-12", groceriesMinor: 1_073, hours: "" }),
      expect.objectContaining({ date: "2026-01-12", groceriesMinor: 1_073, hours: "" }),
    ]);
    expect(workRows).toEqual([
      expect.objectContaining({
        date: "2026-01-12",
        groceriesMinor: null,
        hours: "4",
        rateMinor: 6_000,
        comment: "",
      }),
    ]);
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

function deferred<Value>() {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
