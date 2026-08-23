import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { INVOICE_SCHEMA_VERSION, type InvoiceDocument, type ReceiptRecord } from "../shared/types";

const electron = vi.hoisted(() => ({
  openPath: vi.fn(),
}));

vi.mock("electron", () => ({
  BrowserWindow: class BrowserWindow {},
  shell: { openPath: electron.openPath },
}));

import { buildInvoiceHtml, InvoiceOutputBuilder, OUTPUT_FILE_CONCURRENCY } from "./invoice-output";
import { InvoiceStore } from "./invoice-store";

describe("invoice output HTML", () => {
  it("escapes all invoice data and renders rows plus exact totals", () => {
    const invoice: InvoiceDocument = {
      schemaVersion: INVOICE_SCHEMA_VERSION,
      id: "inv_html",
      name: '<img src=x onerror="alert(1)">',
      period: { startDate: "2026-01-01", endDate: "2026-01-31" },
      defaultRateMinor: 4500,
      currency: "USD",
      revision: 7,
      rows: [
        {
          id: "row-1",
          date: "2026-01-02",
          groceriesMinor: 1073,
          hours: "1.5",
          rateMinor: 4500,
          comment: '<script>alert("receipt")</script> & groceries',
          receiptId: null,
        },
      ],
      receipts: [],
      reviewAcknowledgements: [
        {
          fingerprint: "f".repeat(64),
          acknowledgedAt: "2031-12-13T14:15:16.000Z",
        },
      ],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    };

    const html = buildInvoiceHtml(invoice);

    expect(html).toContain("Content-Security-Policy\" content=\"default-src 'none'");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).not.toContain('<img src=x onerror="alert(1)">');
    expect(html).toContain(
      "&lt;script&gt;alert(&quot;receipt&quot;)&lt;/script&gt; &amp; groceries"
    );
    expect(html).not.toContain('<script>alert("receipt")</script>');
    expect(html).toContain("01/02/2026");
    expect(html).toContain("$10.73");
    expect(html).toContain("$67.50");
    expect(html).toContain("$78.23");
    expect(html).toContain("thead { display: table-header-group; }");
    expect(html).toContain("page-break-inside: avoid");
    expect(html).not.toContain("f".repeat(64));
    expect(html).not.toContain("2031-12-13T14:15:16.000Z");
  });

  it("hides the default rate on a receipt-only row without hours", () => {
    const invoice: InvoiceDocument = {
      schemaVersion: INVOICE_SCHEMA_VERSION,
      id: "inv_receipt_only",
      name: "invoice-2026-01-01-2026-01-31",
      period: { startDate: "2026-01-01", endDate: "2026-01-31" },
      defaultRateMinor: 4500,
      currency: "USD",
      revision: 1,
      rows: [
        {
          id: "row-1",
          date: "2026-01-02",
          groceriesMinor: 1073,
          hours: "",
          rateMinor: 4500,
          comment: "Receipt only",
          receiptId: null,
        },
      ],
      receipts: [],
      reviewAcknowledgements: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    };

    const html = buildInvoiceHtml(invoice);

    expect(html).toContain("Receipt only");
    expect(html).not.toContain("$45.00");
  });
});

describe("InvoiceOutputBuilder", () => {
  let baseFolder: string;
  let store: InvoiceStore;

  beforeEach(async () => {
    baseFolder = await fs.mkdtemp(path.join(os.tmpdir(), "invoice-output-test-"));
    store = new InvoiceStore(() => baseFolder, {
      now: () => new Date("2026-08-21T12:00:00.000Z"),
      idFactory: () => "inv_output",
    });
    electron.openPath.mockReset();
  });

  afterEach(async () => {
    await fs.rm(baseFolder, { recursive: true, force: true });
  });

  it("atomically replaces output and copies the first record for each verified hash", async () => {
    const invoice = await createInvoice(store);
    const invoiceFolder = await store.getInvoiceFolder(invoice.id);
    const sameBytes = Buffer.from("identical receipt bytes");
    const uniqueBytes = Buffer.from("unique receipt bytes");
    await addReceipts(store, invoice.id, invoiceFolder, [
      receiptInput("first", "first.png", sameBytes),
      receiptInput("duplicate", "second.png", sameBytes),
      receiptInput("unique", "third.pdf", uniqueBytes),
    ]);
    await seedPreviousOutput(invoiceFolder);
    const renderPdf = vi.fn(async () => pdfBuffer("new invoice"));
    const revealPath = vi.fn(async () => "");
    const builder = new InvoiceOutputBuilder(store, {
      renderPdf,
      revealPath,
      nonce: () => "successful-build",
    });

    const result = await builder.buildInvoiceOutput(invoice.id);

    expect(result).toEqual({
      outputPath: path.join(invoiceFolder, "output"),
      receiptCount: 2,
    });
    expect(await fs.readFile(path.join(result.outputPath, "invoice.pdf"))).toEqual(
      pdfBuffer("new invoice")
    );
    expect(await fs.readdir(path.join(result.outputPath, "receipts"))).toEqual([
      "first.png",
      "third.pdf",
    ]);
    expect(await fs.readFile(path.join(result.outputPath, "receipts", "first.png"))).toEqual(
      sameBytes
    );
    expect(await fs.readFile(path.join(result.outputPath, "receipts", "third.pdf"))).toEqual(
      uniqueBytes
    );
    expect(await fs.readdir(invoiceFolder)).not.toContain(".output.tmp-successful-build");
    expect(await fs.readdir(invoiceFolder)).not.toContain(".output.backup-successful-build");
    expect(renderPdf).toHaveBeenCalledOnce();

    await builder.revealOutput(invoice.id);
    expect(revealPath).toHaveBeenCalledWith(result.outputPath);
  });

  it("bounds concurrent receipt copies while staging client output", async () => {
    const invoice = await createInvoice(store);
    const invoiceFolder = await store.getInvoiceFolder(invoice.id);
    await addReceipts(
      store,
      invoice.id,
      invoiceFolder,
      Array.from({ length: OUTPUT_FILE_CONCURRENCY * 2 + 1 }, (_, index) =>
        receiptInput(`bounded-${index}`, `bounded-${index}.png`, Buffer.from(`bytes-${index}`))
      )
    );
    const actualCopyFile = fs.copyFile.bind(fs);
    let activeCopies = 0;
    let maximumActiveCopies = 0;
    const copyFileSpy = vi.spyOn(fs, "copyFile").mockImplementation(async (...args) => {
      activeCopies += 1;
      maximumActiveCopies = Math.max(maximumActiveCopies, activeCopies);
      await new Promise<void>((resolve) => setImmediate(resolve));
      try {
        await actualCopyFile(...args);
      } finally {
        activeCopies -= 1;
      }
    });

    try {
      await new InvoiceOutputBuilder(store, {
        renderPdf: async () => pdfBuffer("bounded output"),
        nonce: () => "bounded-output",
      }).buildInvoiceOutput(invoice.id);
    } finally {
      copyFileSpy.mockRestore();
    }

    expect(maximumActiveCopies).toBe(OUTPUT_FILE_CONCURRENCY);
  });

  it("loads the latest revision and preserves its persisted row order in PDF HTML", async () => {
    const invoice = await createInvoice(store);
    const firstSave = await store.saveRows(
      invoice.id,
      [
        outputRow("old-first", "2026-08-01", "Old first"),
        outputRow("old-second", "2026-08-02", "Old second"),
      ],
      invoice.revision
    );
    const renderPdf = vi.fn(async (_html: string) => pdfBuffer("ordered invoice"));
    const builder = new InvoiceOutputBuilder(store, {
      renderPdf,
      nonce: () => "latest-order",
    });
    const latest = await store.saveRows(
      invoice.id,
      [
        outputRow("chosen-first", "2026-08-20", "Chosen first"),
        outputRow("chosen-second", "2026-08-01", "Chosen second"),
        outputRow("chosen-third", null, "Chosen third"),
      ],
      firstSave.revision
    );

    await builder.buildInvoiceOutput(invoice.id);

    expect(renderPdf).toHaveBeenCalledOnce();
    const html = renderPdf.mock.calls[0]?.[0] ?? "";
    expect(html).toContain(`Revision ${latest.revision}`);
    expect(html.indexOf("Chosen first")).toBeLessThan(html.indexOf("Chosen second"));
    expect(html.indexOf("Chosen second")).toBeLessThan(html.indexOf("Chosen third"));
    expect(html).not.toContain("Old first");
    expect(html).not.toContain("Old second");
  });

  it("does not publish an older snapshot when a save commits during PDF rendering", async () => {
    const invoice = await createInvoice(store);
    const invoiceFolder = await store.getInvoiceFolder(invoice.id);
    await seedPreviousOutput(invoiceFolder);
    let releaseRender: () => void = () => undefined;
    const renderGate = new Promise<void>((resolve) => {
      releaseRender = resolve;
    });
    let markRenderStarted: () => void = () => undefined;
    const renderStarted = new Promise<void>((resolve) => {
      markRenderStarted = resolve;
    });
    const renderPdf = vi.fn(async () => {
      markRenderStarted();
      await renderGate;
      return pdfBuffer("stale invoice");
    });
    const builder = new InvoiceOutputBuilder(store, {
      renderPdf,
      nonce: () => "stale-revision",
    });

    const build = builder.buildInvoiceOutput(invoice.id);
    await renderStarted;
    const saved = await store.saveRows(
      invoice.id,
      [outputRow("newer-row", "2026-08-20", "Newer revision")],
      invoice.revision
    );
    releaseRender();

    await expect(build).rejects.toMatchObject({
      name: "RevisionConflictError",
      expectedRevision: invoice.revision,
      actualRevision: saved.revision,
    });
    await expectPreviousOutput(invoiceFolder);
    expect(await fs.readdir(invoiceFolder)).not.toContain(".output.tmp-stale-revision");
    expect(renderPdf).toHaveBeenCalledOnce();
  });

  it("fails on malformed hashes without replacing the previous output", async () => {
    const invoice = await createInvoice(store);
    const invoiceFolder = await store.getInvoiceFolder(invoice.id);
    const bytes = Buffer.from("bad");
    await addReceipts(store, invoice.id, invoiceFolder, [
      receiptInput("bad-hash", "bad.png", bytes, sha256(bytes)),
    ]);
    const invoicePath = path.join(invoiceFolder, "invoice.json");
    const persisted = JSON.parse(await fs.readFile(invoicePath, "utf8"));
    persisted.receipts[0].sha256 = "not-a-sha";
    await fs.writeFile(invoicePath, `${JSON.stringify(persisted, null, 2)}\n`);
    await seedPreviousOutput(invoiceFolder);
    const renderPdf = vi.fn(async () => pdfBuffer("should not render"));
    const builder = new InvoiceOutputBuilder(store, { renderPdf });

    await expect(builder.buildInvoiceOutput(invoice.name)).rejects.toThrow(
      /SHA-256 must be a 64-character hexadecimal value/
    );
    expect(renderPdf).not.toHaveBeenCalled();
    await expectPreviousOutput(invoiceFolder);
  });

  it("verifies later duplicate records and preserves output on a hash mismatch", async () => {
    const invoice = await createInvoice(store);
    const invoiceFolder = await store.getInvoiceFolder(invoice.id);
    const expectedBytes = Buffer.from("expected bytes");
    const claimedHash = sha256(expectedBytes);
    await addReceipts(store, invoice.id, invoiceFolder, [
      receiptInput("first", "first.png", expectedBytes, claimedHash),
      receiptInput(
        "tampered-duplicate",
        "duplicate.png",
        Buffer.from("different bytes"),
        claimedHash
      ),
    ]);
    await seedPreviousOutput(invoiceFolder);
    const builder = new InvoiceOutputBuilder(store, {
      renderPdf: async () => pdfBuffer("should not render"),
    });

    await expect(builder.buildInvoiceOutput(invoice.id)).rejects.toThrow(
      /does not match its saved SHA-256/
    );
    await expectPreviousOutput(invoiceFolder);
  });

  it("rejects symlinked receipt files and preserves output", async () => {
    const invoice = await createInvoice(store);
    const invoiceFolder = await store.getInvoiceFolder(invoice.id);
    const target = path.join(invoiceFolder, "target.png");
    const bytes = Buffer.from("symlink target");
    await fs.writeFile(target, bytes);
    const relativePath = "receipts/link.png";
    await fs.symlink(target, path.join(invoiceFolder, relativePath));
    await store.mutateInvoice(invoice.id, (draft) => {
      draft.receipts.push(receiptRecord("link", relativePath, sha256(bytes)));
    });
    await seedPreviousOutput(invoiceFolder);
    const builder = new InvoiceOutputBuilder(store, {
      renderPdf: async () => pdfBuffer("should not render"),
    });

    await expect(builder.buildInvoiceOutput(invoice.id)).rejects.toThrow(
      /symbolic link|ordinary file/
    );
    await expectPreviousOutput(invoiceFolder);
  });

  it("preserves previous output when PDF staging fails", async () => {
    const invoice = await createInvoice(store);
    const invoiceFolder = await store.getInvoiceFolder(invoice.id);
    await addReceipts(store, invoice.id, invoiceFolder, [
      receiptInput("valid", "valid.png", Buffer.from("valid receipt")),
    ]);
    await seedPreviousOutput(invoiceFolder);
    const builder = new InvoiceOutputBuilder(store, {
      renderPdf: async () => {
        throw new Error("Chromium print failed");
      },
      nonce: () => "failed-build",
    });

    await expect(builder.buildInvoiceOutput(invoice.id)).rejects.toThrow("Chromium print failed");
    await expectPreviousOutput(invoiceFolder);
    expect(await fs.readdir(invoiceFolder)).not.toContain(".output.tmp-failed-build");
  });

  it("requires an ordinary existing output directory before reveal", async () => {
    const invoice = await createInvoice(store);
    const invoiceFolder = await store.getInvoiceFolder(invoice.id);
    const revealPath = vi.fn(async () => undefined);
    const builder = new InvoiceOutputBuilder(store, { revealPath });

    await expect(builder.revealOutput(invoice.id)).rejects.toThrow(
      "Build the invoice output first."
    );
    await fs.symlink(baseFolder, path.join(invoiceFolder, "output"));
    await expect(builder.revealOutput(invoice.id)).rejects.toThrow(
      "Invoice output is not an ordinary directory."
    );
    expect(revealPath).not.toHaveBeenCalled();
  });

  it("rejects a dangling output symlink instead of following or replacing it", async () => {
    const invoice = await createInvoice(store);
    const invoiceFolder = await store.getInvoiceFolder(invoice.id);
    const outputPath = path.join(invoiceFolder, "output");
    const missingTarget = path.join(invoiceFolder, "missing-output-target");
    await fs.symlink(missingTarget, outputPath);
    const builder = new InvoiceOutputBuilder(store, {
      renderPdf: async () => pdfBuffer("new invoice"),
      nonce: () => "dangling-symlink",
    });

    await expect(builder.buildInvoiceOutput(invoice.id)).rejects.toThrow(
      "Invoice output is not an ordinary directory."
    );
    expect((await fs.lstat(outputPath)).isSymbolicLink()).toBe(true);
    expect(await fs.readdir(invoiceFolder)).not.toContain(".output.tmp-dangling-symlink");
  });
});

async function createInvoice(store: InvoiceStore): Promise<InvoiceDocument> {
  return store.createInvoice({
    startDate: "2026-08-01",
    endDate: "2026-08-31",
  });
}

interface ReceiptInput {
  id: string;
  filename: string;
  bytes: Buffer;
  sha256: string;
}

function receiptInput(
  id: string,
  filename: string,
  bytes: Buffer,
  claimedHash = sha256(bytes)
): ReceiptInput {
  return { id, filename, bytes, sha256: claimedHash };
}

async function addReceipts(
  store: InvoiceStore,
  invoiceId: string,
  invoiceFolder: string,
  inputs: ReceiptInput[]
): Promise<void> {
  for (const input of inputs) {
    await fs.writeFile(path.join(invoiceFolder, "receipts", input.filename), input.bytes);
  }
  await store.mutateInvoice(invoiceId, (invoice) => {
    invoice.receipts.push(
      ...inputs.map((input) =>
        receiptRecord(input.id, path.join("receipts", input.filename), input.sha256)
      )
    );
  });
}

function receiptRecord(id: string, relativePath: string, sha256Value: string): ReceiptRecord {
  return {
    id: `receipt-${id}`,
    relativePath,
    debugPath: `debug/receipt-${id}.json`,
    originalFilename: path.basename(relativePath),
    mimeType: "image/png",
    sha256: sha256Value,
    source: { kind: "manual", method: "file-picker" },
    status: "ready",
    importedAt: "2026-08-21T11:00:00.000Z",
  };
}

function outputRow(
  id: string,
  date: string | null,
  comment: string
): InvoiceDocument["rows"][number] {
  return {
    id,
    date,
    groceriesMinor: 100,
    hours: "",
    rateMinor: 4500,
    comment,
    receiptId: null,
  };
}

async function seedPreviousOutput(invoiceFolder: string): Promise<void> {
  const outputPath = path.join(invoiceFolder, "output");
  await fs.mkdir(path.join(outputPath, "receipts"), { recursive: true });
  await fs.writeFile(path.join(outputPath, "invoice.pdf"), "previous PDF");
  await fs.writeFile(path.join(outputPath, "receipts", "previous.txt"), "previous receipt");
}

async function expectPreviousOutput(invoiceFolder: string): Promise<void> {
  const outputPath = path.join(invoiceFolder, "output");
  expect(await fs.readFile(path.join(outputPath, "invoice.pdf"), "utf8")).toBe("previous PDF");
  expect(await fs.readdir(path.join(outputPath, "receipts"))).toEqual(["previous.txt"]);
}

function pdfBuffer(label: string): Buffer {
  return Buffer.from(`%PDF-1.4\n${label}\n%%EOF\n`);
}

function sha256(value: Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}
