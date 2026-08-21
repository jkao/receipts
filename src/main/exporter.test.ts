import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ImportManager } from "./import-manager";
import { InvoiceStore } from "./invoice-store";
import { MAX_RECEIPT_FILE_BYTES } from "./receipt-files";

const electronMocks = vi.hoisted(() => ({
  writeText: vi.fn(),
  showOpenDialog: vi.fn(),
  showSaveDialog: vi.fn(),
  openPath: vi.fn(),
}));

vi.mock("electron", () => ({
  BrowserWindow: class BrowserWindow {},
  clipboard: { writeText: electronMocks.writeText },
  dialog: {
    showOpenDialog: electronMocks.showOpenDialog,
    showSaveDialog: electronMocks.showSaveDialog,
  },
  shell: { openPath: electronMocks.openPath },
}));

import { InvoiceExporter } from "./exporter";

describe("InvoiceExporter receipt preview", () => {
  let baseFolder: string;
  let store: InvoiceStore;
  const temporaryExports: string[] = [];

  beforeEach(async () => {
    vi.clearAllMocks();
    baseFolder = await fs.mkdtemp(path.join(os.tmpdir(), "receipt-preview-test-"));
    store = new InvoiceStore(() => baseFolder, {
      now: () => new Date("2026-08-21T12:00:00.000Z"),
      idFactory: () => "inv_preview",
    });
  });

  afterEach(async () => {
    await fs.rm(baseFolder, { recursive: true, force: true });
    await Promise.all(
      temporaryExports.splice(0).map((folder) => fs.rm(folder, { recursive: true, force: true }))
    );
  });

  it("returns the absolute managed copy path rather than the import source", async () => {
    const invoice = await store.createInvoice({
      startDate: "2026-08-01",
      endDate: "2026-08-31",
    });
    const sourcePath = path.join(baseFolder, "dropbox-source.png");
    await fs.writeFile(sourcePath, "managed receipt bytes");
    const importer = new ImportManager(store, { getOpenAiKey: async () => null }, () => undefined);
    const imported = await importer.importFiles(invoice.id, [sourcePath], {
      method: "file-picker",
    });
    const receipt = imported.invoice.receipts[0];
    const expectedManagedPath = path.resolve(
      await store.getInvoiceFolder(invoice.id),
      receipt.relativePath
    );

    await fs.rm(sourcePath);
    const exporter = new InvoiceExporter(store, () => null);
    const preview = await exporter.getReceiptPreview(invoice.id, receipt.id);

    expect(preview).toMatchObject({
      filename: "dropbox-source.png",
      mimeType: "image/png",
      managedPath: expectedManagedPath,
    });
    expect(path.isAbsolute(preview.managedPath)).toBe(true);
    expect(preview.managedPath).not.toBe(sourcePath);
    expect(preview.bytes).toEqual(Buffer.from("managed receipt bytes"));
    expect(preview).not.toHaveProperty("dataUrl");
  });

  it("rejects an oversized managed preview before reading it into memory", async () => {
    const invoice = await store.createInvoice({
      startDate: "2026-08-01",
      endDate: "2026-08-31",
    });
    const sourcePath = path.join(baseFolder, "large-preview.pdf");
    await fs.writeFile(sourcePath, "%PDF");
    const imported = await new ImportManager(
      store,
      { getOpenAiKey: async () => null },
      () => undefined
    ).importFiles(invoice.id, [sourcePath]);
    const receipt = imported.invoice.receipts[0];
    const managedPath = path.join(await store.getInvoiceFolder(invoice.id), receipt.relativePath);
    await fs.truncate(managedPath, MAX_RECEIPT_FILE_BYTES + 1);

    await expect(
      new InvoiceExporter(store, () => null).getReceiptPreview(invoice.id, receipt.id)
    ).rejects.toThrow(/20 MB safe processing limit/);
  });

  it("copies spreadsheet-safe TSV from the latest invoice revision", async () => {
    const invoice = await store.createInvoice({
      startDate: "2026-08-01",
      endDate: "2026-08-31",
    });
    await store.saveRows(
      invoice.id,
      [
        {
          id: "row-safe-copy",
          date: "2026-08-02",
          groceriesMinor: 1234,
          hours: "",
          rateMinor: 4500,
          comment: '=HYPERLINK("bad")',
          receiptId: null,
        },
      ],
      invoice.revision
    );
    const exporter = new InvoiceExporter(store, () => null);

    await exporter.copyTsv(invoice.id, null, true, true);

    expect(electronMocks.writeText).toHaveBeenCalledTimes(1);
    expect(electronMocks.writeText.mock.calls[0][0]).toContain('\'=HYPERLINK("bad")');
  });

  it("builds a verified staged folder package outside the live invoice base", async () => {
    const invoice = await store.createInvoice({
      startDate: "2026-08-01",
      endDate: "2026-08-31",
    });
    const sourcePath = path.join(baseFolder, "package-source.pdf");
    await fs.writeFile(sourcePath, "%PDF-managed-receipt");
    const imported = await new ImportManager(
      store,
      { getOpenAiKey: async () => null },
      () => undefined
    ).importFiles(invoice.id, [sourcePath]);
    const exportParent = await fs.mkdtemp(path.join(os.tmpdir(), "receipt-export-destination-"));
    temporaryExports.push(exportParent);
    electronMocks.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: [exportParent],
    });
    const exporter = new InvoiceExporter(store, () => ({}) as never);

    const result = await exporter.exportPackage(invoice.id, {
      includeDebug: false,
      asZip: false,
    });

    expect(result).toMatchObject({ canceled: false });
    const outputPath = result.outputPath!;
    expect(await fs.readFile(path.join(outputPath, "invoice.tsv"), "utf8")).toContain(
      imported.invoice.rows[0].comment
    );
    expect(
      await fs.readFile(path.join(outputPath, imported.invoice.receipts[0].relativePath), "utf8")
    ).toBe("%PDF-managed-receipt");
    await expect(fs.access(path.join(outputPath, "invoice.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects folder and ZIP destinations inside the live invoice data", async () => {
    const invoice = await store.createInvoice({
      startDate: "2026-08-01",
      endDate: "2026-08-31",
    });
    const invoiceFolder = await store.getInvoiceFolder(invoice.id);
    electronMocks.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: [baseFolder],
    });
    electronMocks.showSaveDialog.mockResolvedValue({
      canceled: false,
      filePath: path.join(invoiceFolder, "unsafe.zip"),
    });
    const exporter = new InvoiceExporter(store, () => ({}) as never);

    await expect(
      exporter.exportPackage(invoice.id, { includeDebug: false, asZip: false })
    ).rejects.toThrow(/outside the live invoice base/);
    await expect(
      exporter.exportPackage(invoice.id, { includeDebug: false, asZip: true })
    ).rejects.toThrow(/outside the live invoice folder/);
    await expect(fs.access(path.join(invoiceFolder, "unsafe.zip"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
