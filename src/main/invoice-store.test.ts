import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { InvoiceDocument, InvoicePeriod, InvoiceRow, ReceiptRecord } from "../shared/types";
import { invoiceDocumentFingerprint, validateInvoiceDocument } from "./invoice-codec";
import {
  BaseFolderNotConfiguredError,
  INVOICE_PERIOD_UPDATE_FILENAME,
  INVOICE_VIEW_REPAIR_CONCURRENCY,
  INVOICE_VIEW_STATE_FILENAME,
  InvoiceDeletedError,
  InvoiceNotFoundError,
  InvoiceStore,
  InvoiceValidationError,
  RevisionConflictError,
} from "./invoice-store";

const PERIOD: InvoicePeriod = {
  startDate: "2026-01-01",
  endDate: "2026-01-31",
};

function row(overrides: Partial<InvoiceRow> = {}): InvoiceRow {
  return {
    id: "row-1",
    date: "2026-01-12",
    groceriesMinor: 1073,
    hours: "4.50",
    rateMinor: 4500,
    comment: "Key Foods",
    receiptId: null,
    ...overrides,
  };
}

function receipt(overrides: Partial<ReceiptRecord> = {}): ReceiptRecord {
  return {
    id: "receipt-1",
    relativePath: "receipts/receipt-1.jpg",
    debugPath: "debug/receipt-1.json",
    originalFilename: "receipt.jpg",
    mimeType: "image/jpeg",
    sha256: "a".repeat(64),
    source: { kind: "manual", method: "drag-drop" },
    status: "ready",
    importedAt: "2026-02-01T00:00:00.000Z",
    ...overrides,
  };
}

function cleanViewState(invoice: InvoiceDocument) {
  return {
    schemaVersion: 1,
    revision: invoice.revision,
    invoiceSha256: invoiceDocumentFingerprint(invoice),
    state: "clean",
  } as const;
}

describe("InvoiceStore", () => {
  let baseFolder: string;
  let idCounter: number;
  let clockTick: number;
  let store: InvoiceStore;

  beforeEach(async () => {
    baseFolder = await fs.mkdtemp(path.join(os.tmpdir(), "receipt-invoice-store-"));
    idCounter = 0;
    clockTick = 0;
    store = new InvoiceStore(async () => baseFolder, {
      idFactory: () => `inv-${++idCounter}`,
      now: () => new Date(Date.UTC(2026, 1, 1, 0, 0, clockTick++)),
    });
  });

  afterEach(async () => {
    await fs.rm(baseFolder, { recursive: true, force: true });
  });

  it("creates an inclusive period folder and opens it on repeat creation", async () => {
    const created = await store.createInvoice(PERIOD, 5000);
    const folder = path.join(baseFolder, "invoice-2026-01-01-2026-01-31");

    expect(created).toMatchObject({
      id: "inv-1",
      name: "invoice-2026-01-01-2026-01-31",
      period: PERIOD,
      defaultRateMinor: 5000,
      revision: 0,
    });
    expect(created.reviewAcknowledgements).toEqual([]);
    await expect(fs.stat(path.join(folder, "receipts"))).resolves.toMatchObject({});
    await expect(fs.stat(path.join(folder, "debug"))).resolves.toMatchObject({});
    await expect(fs.stat(path.join(folder, ".trash"))).resolves.toMatchObject({});

    const json = JSON.parse(await fs.readFile(path.join(folder, "invoice.json"), "utf8"));
    expect(json.id).toBe(created.id);
    expect(json.reviewAcknowledgements).toEqual([]);
    expect(await fs.readFile(path.join(folder, "invoice.tsv"), "utf8")).toBe(
      "Date\tGroceries MP\tHours Worked\tRate\tLabour Total\tComment\n" +
        "Total\t0.00\t0.00\t\t0.00\t\n" +
        "Grand Total\t\t\t\t0.00\tPlease pay groceries and labour separately. Grand total is for reference only.\n"
    );
    expect(await fs.readFile(path.join(folder, "invoice.csv"), "utf8")).toContain(
      "Date,Groceries MP,Hours Worked,Rate,Labour Total,Comment"
    );

    const reopened = await store.createInvoice(PERIOD, 9999);
    expect(reopened.id).toBe(created.id);
    expect(reopened.defaultRateMinor).toBe(5000);
    expect(idCounter).toBe(1);
  });

  it("soft-deletes with a visible sentinel and consistently hides the invoice", async () => {
    const created = await store.createInvoice(PERIOD, 4500);
    const withReceipt = await store.mutateInvoice(created.id, (draft) => {
      draft.receipts.push(receipt());
    });
    const folder = await store.getInvoiceFolder(created.id);
    await expect(store.findHash("a".repeat(64))).resolves.toHaveLength(1);

    await expect(
      store.removeInvoice(created.id, { expectedRevision: withReceipt.revision })
    ).resolves.toEqual({
      invoiceId: created.id,
      invoiceName: created.name,
      mode: "soft",
      deletedAt: "2026-02-01T00:00:02.000Z",
    });

    const sentinel = JSON.parse(await fs.readFile(path.join(folder, "DELETED.json"), "utf8"));
    expect(sentinel).toEqual({
      schemaVersion: 1,
      invoiceId: created.id,
      invoiceName: created.name,
      lastRevision: withReceipt.revision,
      deletedAt: "2026-02-01T00:00:02.000Z",
    });
    expect((await fs.stat(path.join(folder, "DELETED.json"))).mode & 0o777).toBe(0o600);
    await expect(fs.access(path.join(folder, "invoice.json"))).resolves.toBeUndefined();
    await expect(store.listInvoices()).resolves.toEqual([]);
    await expect(store.findHash("a".repeat(64))).resolves.toEqual([]);
    await expect(store.loadInvoice(created.id)).rejects.toBeInstanceOf(InvoiceDeletedError);
    await expect(store.loadInvoice(created.name)).rejects.toThrow(/DELETED\.json.*recover/i);
    await expect(store.createInvoice(PERIOD, 9999)).rejects.toThrow(/DELETED\.json.*recover/i);

    await fs.rm(path.join(folder, "DELETED.json"));
    await expect(store.loadInvoice(created.id)).resolves.toMatchObject({ id: created.id });
  });

  it("revision-checks removal and rejects malformed hard-delete flags", async () => {
    const created = await store.createInvoice(PERIOD, 4500);
    const folder = await store.getInvoiceFolder(created.id);
    const saved = await store.saveRows(created.id, [row()], created.revision);

    await expect(
      store.removeInvoice(created.id, { expectedRevision: created.revision })
    ).rejects.toEqual(
      expect.objectContaining({
        name: "RevisionConflictError",
        expectedRevision: created.revision,
        actualRevision: saved.revision,
      })
    );
    await expect(fs.access(path.join(folder, "DELETED.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      store.removeInvoice(created.id, {
        expectedRevision: saved.revision,
        hardDelete: "false" as never,
      })
    ).rejects.toThrow(/Hard delete must be a boolean/);
    await expect(store.loadInvoice(created.id)).resolves.toMatchObject({
      revision: saved.revision,
    });
  });

  it("hard-deletes only after revision checking and removes the exact invoice folder", async () => {
    const created = await store.createInvoice(PERIOD, 4500);
    const folder = await store.getInvoiceFolder(created.id);
    const nestedFiles = [
      path.join(folder, "receipts", "nested", "receipt.jpg"),
      path.join(folder, "debug", "nested", "receipt.json"),
      path.join(folder, "output", "nested", "invoice.pdf"),
      path.join(folder, ".trash", "nested", "deleted-row.json"),
    ];
    for (const filename of nestedFiles) {
      await fs.mkdir(path.dirname(filename), { recursive: true });
      await fs.writeFile(filename, "local invoice data", "utf8");
    }
    const outsideFile = path.join(baseFolder, "outside-must-survive.txt");
    await fs.writeFile(outsideFile, "keep me", "utf8");
    await fs.symlink(outsideFile, path.join(folder, "receipts", "nested", "outside-link"));

    await expect(
      store.removeInvoice(created.id, {
        expectedRevision: created.revision,
        hardDelete: true,
      })
    ).resolves.toEqual({
      invoiceId: created.id,
      invoiceName: created.name,
      mode: "hard",
      deletedAt: "2026-02-01T00:00:01.000Z",
    });
    await expect(fs.access(folder)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(baseFolder)).resolves.toMatchObject({});
    await expect(fs.readFile(outsideFile, "utf8")).resolves.toBe("keep me");
    await expect(store.listInvoices()).resolves.toEqual([]);
  });

  it("keeps a soft-deletion sentinel when permanent file removal fails", async () => {
    const created = await store.createInvoice(PERIOD, 4500);
    const folder = await store.getInvoiceFolder(created.id);
    const remove = vi.spyOn(fs, "rm").mockRejectedValueOnce(new Error("simulated failure"));

    const result = await store.removeInvoice(created.id, {
      expectedRevision: created.revision,
      hardDelete: true,
    });
    remove.mockRestore();

    expect(result).toMatchObject({
      mode: "soft",
      warning: expect.stringContaining("DELETED.json"),
    });
    const sentinel = JSON.parse(await fs.readFile(path.join(folder, "DELETED.json"), "utf8"));
    expect(sentinel).toMatchObject({ hardDeleteIncomplete: true });
    await expect(store.loadInvoice(created.id)).rejects.toThrow(
      /incomplete permanent deletion.*files may already be missing/i
    );
    await expect(store.listInvoices()).resolves.toEqual([]);

    sentinel.hardDeleteIncomplete = "true";
    await fs.writeFile(
      path.join(folder, "DELETED.json"),
      `${JSON.stringify(sentinel, null, 2)}\n`,
      "utf8"
    );
    await expect(store.loadInvoice(created.name)).rejects.toThrow(
      /hard-delete state must be a boolean/i
    );
  });

  it("rejects symlinked invoice folders without deleting the target", async () => {
    const created = await store.createInvoice(PERIOD, 4500);
    const folder = await store.getInvoiceFolder(created.id);
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "receipt-invoice-outside-"));
    const outsideFolder = path.join(outsideRoot, created.name);
    await fs.rename(folder, outsideFolder);
    await fs.symlink(outsideFolder, folder, "dir");

    try {
      await expect(
        store.removeInvoice(created.name, {
          expectedRevision: created.revision,
          hardDelete: true,
        })
      ).rejects.toThrow(/ordinary invoice folder/);
      await expect(fs.access(path.join(outsideFolder, "invoice.json"))).resolves.toBeUndefined();
      await expect(fs.access(path.join(outsideFolder, "DELETED.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await fs.rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it("rejects queued work once an earlier soft deletion commits", async () => {
    const created = await store.createInvoice(PERIOD, 4500);
    const removing = store.removeInvoice(created.id, { expectedRevision: created.revision });
    const mutating = store.mutateInvoice(created.id, (draft) => {
      draft.rows.push(row());
    });
    const loading = store.loadInvoice(created.id);

    await expect(removing).resolves.toMatchObject({ mode: "soft" });
    await expect(mutating).rejects.toBeInstanceOf(InvoiceDeletedError);
    await expect(loading).rejects.toBeInstanceOf(InvoiceDeletedError);
  });

  it("migrates missing review acknowledgements and validates stored entries", async () => {
    const created = await store.createInvoice(PERIOD, 4500);
    const folder = await store.getInvoiceFolder(created.id);
    const invoicePath = path.join(folder, "invoice.json");
    const legacy = JSON.parse(await fs.readFile(invoicePath, "utf8"));
    delete legacy.reviewAcknowledgements;
    await fs.writeFile(invoicePath, `${JSON.stringify(legacy, null, 2)}\n`, "utf8");

    expect((await store.loadInvoice(created.id)).reviewAcknowledgements).toEqual([]);
    await expect(
      store.mutateInvoice(created.id, (draft) => {
        draft.reviewAcknowledgements = [
          {
            fingerprint: "not-a-sha",
            acknowledgedAt: "2026-02-01T00:00:00.000Z",
          },
        ];
      })
    ).rejects.toThrow(/lowercase SHA-256/);
    await expect(
      store.mutateInvoice(created.id, (draft) => {
        const fingerprint = "a".repeat(64);
        draft.reviewAcknowledgements = [
          {
            fingerprint,
            acknowledgedAt: "2026-02-01T00:00:00.000Z",
          },
          {
            fingerprint,
            acknowledgedAt: "2026-02-01T00:00:00.000Z",
          },
        ];
      })
    ).rejects.toThrow(/must be unique/);
  });

  it("discovers invoices only through immediate-child invoice.json files", async () => {
    const older = await store.createInvoice(PERIOD, 4500);
    const newer = await store.createInvoice(
      { startDate: "2026-02-01", endDate: "2026-02-28" },
      4500
    );
    await fs.mkdir(path.join(baseFolder, "not-an-invoice"));
    await fs.writeFile(path.join(baseFolder, "random.json"), "{}", "utf8");

    const summaries = await store.listInvoices();
    expect(summaries.map((summary) => summary.id)).toEqual([newer.id, older.id]);
    expect(summaries[0]).toMatchObject({ rowCount: 0, receiptCount: 0 });
  });

  it("rejects impossible or reversed period dates", async () => {
    await expect(
      store.createInvoice({ startDate: "2026-02-30", endDate: "2026-03-01" })
    ).rejects.toBeInstanceOf(InvoiceValidationError);
    await expect(
      store.createInvoice({ startDate: "2026-03-02", endDate: "2026-03-01" })
    ).rejects.toBeInstanceOf(InvoiceValidationError);
  });

  it("updates an invoice period by renaming its folder and preserving its contents", async () => {
    const created = await store.createInvoice(PERIOD, 4500);
    const populated = await store.mutateInvoice(created.id, (draft) => {
      draft.rows.push(row());
      draft.receipts.push(receipt());
    });
    const oldFolder = await store.getInvoiceFolder(created.id);
    const nextPeriod = { startDate: "2026-01-05", endDate: "2026-02-04" };

    const updated = await store.updateInvoicePeriod(created.id, nextPeriod, populated.revision);
    const nextFolder = path.join(baseFolder, "invoice-2026-01-05-2026-02-04");

    expect(updated).toMatchObject({
      id: created.id,
      name: "invoice-2026-01-05-2026-02-04",
      period: nextPeriod,
      revision: populated.revision + 1,
      rows: populated.rows,
      receipts: populated.receipts,
    });
    await expect(fs.access(oldFolder)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(path.join(nextFolder, "receipts"))).resolves.toMatchObject({});
    await expect(store.getInvoiceFolder(created.id)).resolves.toBe(nextFolder);
    await expect(store.loadInvoice(updated.name)).resolves.toEqual(updated);
    const backup = validateInvoiceDocument(
      JSON.parse(await fs.readFile(path.join(nextFolder, "invoice.json.bak"), "utf8"))
    );
    expect(backup).toMatchObject({
      id: created.id,
      name: updated.name,
      period: nextPeriod,
      revision: populated.revision,
    });

    const saved = await store.saveRows(
      updated.id,
      [row({ comment: "After move" })],
      updated.revision
    );
    expect(saved.rows[0].comment).toBe("After move");
    expect(await fs.readFile(path.join(nextFolder, "invoice.tsv"), "utf8")).toContain("After move");
  });

  it("revision-checks period updates and refuses to replace another invoice folder", async () => {
    const created = await store.createInvoice(PERIOD, 4500);
    const occupiedPeriod = { startDate: "2026-02-01", endDate: "2026-02-28" };
    await store.createInvoice(occupiedPeriod, 4500);

    await expect(
      store.updateInvoicePeriod(created.id, occupiedPeriod, created.revision)
    ).rejects.toThrow(/already exists/i);
    await expect(
      store.updateInvoicePeriod(
        created.id,
        { startDate: "2026-01-02", endDate: "2026-01-31" },
        created.revision + 1
      )
    ).rejects.toBeInstanceOf(RevisionConflictError);
    await expect(store.loadInvoice(created.id)).resolves.toMatchObject({
      name: created.name,
      period: PERIOD,
      revision: created.revision,
    });
  });

  it("treats saving an unchanged invoice period as a no-op", async () => {
    const created = await store.createInvoice(PERIOD, 4500);

    await expect(store.updateInvoicePeriod(created.id, PERIOD, created.revision)).resolves.toEqual(
      created
    );
    expect((await store.loadInvoice(created.id)).revision).toBe(created.revision);
  });

  it("recovers an interrupted period update after the folder move", async () => {
    const created = await store.createInvoice(PERIOD, 4500);
    const oldFolder = await store.getInvoiceFolder(created.id);
    const nextPeriod = { startDate: "2026-01-02", endDate: "2026-02-01" };
    const nextName = "invoice-2026-01-02-2026-02-01";
    const nextFolder = path.join(baseFolder, nextName);
    const marker = {
      schemaVersion: 1,
      invoiceId: created.id,
      previousName: created.name,
      previousPeriod: created.period,
      previousRevision: created.revision,
      previousUpdatedAt: created.updatedAt,
      nextName,
      nextPeriod,
      nextRevision: created.revision + 1,
      nextUpdatedAt: "2026-02-01T00:00:01.000Z",
    };
    await fs.writeFile(
      path.join(oldFolder, INVOICE_PERIOD_UPDATE_FILENAME),
      `${JSON.stringify(marker)}\n`,
      "utf8"
    );
    await fs.rename(oldFolder, nextFolder);

    const recovered = await store.loadInvoice(created.id);

    expect(recovered).toMatchObject({
      id: created.id,
      name: nextName,
      period: nextPeriod,
      revision: 1,
      updatedAt: marker.nextUpdatedAt,
    });
    await expect(
      fs.access(path.join(nextFolder, INVOICE_PERIOD_UPDATE_FILENAME))
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      validateInvoiceDocument(
        JSON.parse(await fs.readFile(path.join(nextFolder, "invoice.json.bak"), "utf8"))
      )
    ).toMatchObject({ name: nextName, period: nextPeriod, revision: 0 });
  });

  it("abandons a prepared period update that stopped before the folder move", async () => {
    const created = await store.createInvoice(PERIOD, 4500);
    const folder = await store.getInvoiceFolder(created.id);
    await fs.writeFile(
      path.join(folder, INVOICE_PERIOD_UPDATE_FILENAME),
      `${JSON.stringify({
        schemaVersion: 1,
        invoiceId: created.id,
        previousName: created.name,
        previousPeriod: created.period,
        previousRevision: created.revision,
        previousUpdatedAt: created.updatedAt,
        nextName: "invoice-2026-01-02-2026-02-01",
        nextPeriod: { startDate: "2026-01-02", endDate: "2026-02-01" },
        nextRevision: created.revision + 1,
        nextUpdatedAt: "2026-02-01T00:00:01.000Z",
      })}\n`,
      "utf8"
    );

    await expect(store.loadInvoice(created.id)).resolves.toEqual(created);
    await expect(
      fs.access(path.join(folder, INVOICE_PERIOD_UPDATE_FILENAME))
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("saves rows atomically, retains the prior JSON, and enforces revisions", async () => {
    const created = await store.createInvoice(PERIOD, 4500);
    const saved = await store.saveRows(created.id, [row()], created.revision);
    const folder = await store.getInvoiceFolder(created.id);

    expect(saved.revision).toBe(1);
    expect(saved.rows).toHaveLength(1);
    const backup = JSON.parse(await fs.readFile(path.join(folder, "invoice.json.bak"), "utf8"));
    expect(backup.revision).toBe(0);
    expect(backup.rows).toEqual([]);
    expect(await fs.readFile(path.join(folder, "invoice.tsv"), "utf8")).toContain(
      "01/12\t10.73\t4.50\t45.00\t202.50\tKey Foods"
    );

    for (const filename of ["invoice.json.tmp", "invoice.tsv.tmp", "invoice.csv.tmp"]) {
      await expect(fs.access(path.join(folder, filename))).rejects.toMatchObject({
        code: "ENOENT",
      });
    }

    await expect(store.saveRows(created.id, [row({ comment: "stale" })], 0)).rejects.toEqual(
      expect.objectContaining({
        name: "RevisionConflictError",
        expectedRevision: 0,
        actualRevision: 1,
      })
    );
    expect((await store.loadInvoice(created.id)).rows[0].comment).toBe("Key Foods");
  });

  it("uses unpredictable exclusive temporary files instead of following a planted temp symlink", async () => {
    const created = await store.createInvoice(PERIOD, 4500);
    const folder = await store.getInvoiceFolder(created.id);
    const outside = path.join(baseFolder, "outside-temp-target.txt");
    const plantedTemp = path.join(folder, "invoice.tsv.tmp");
    await fs.writeFile(outside, "do not overwrite", "utf8");
    await fs.symlink(outside, plantedTemp);

    await store.saveRows(created.id, [row()], created.revision);

    expect(await fs.readFile(outside, "utf8")).toBe("do not overwrite");
    expect((await fs.lstat(plantedTemp)).isSymbolicLink()).toBe(true);
  });

  it("does not commit authoritative JSON when a derived view cannot be replaced", async () => {
    const created = await store.createInvoice(PERIOD, 4500);
    const folder = await store.getInvoiceFolder(created.id);
    const blockedView = path.join(folder, "invoice.csv");
    await fs.rm(blockedView);
    await fs.mkdir(blockedView);

    await expect(store.saveRows(created.id, [row()], created.revision)).rejects.toThrow();

    const persisted = JSON.parse(await fs.readFile(path.join(folder, "invoice.json"), "utf8")) as {
      revision: number;
      rows: InvoiceRow[];
    };
    expect(persisted).toMatchObject({ revision: 0, rows: [] });
    expect(
      JSON.parse(await fs.readFile(path.join(folder, INVOICE_VIEW_STATE_FILENAME), "utf8"))
    ).toMatchObject({
      schemaVersion: 1,
      revision: 1,
      invoiceSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      state: "dirty",
    });
    expect((await fs.readdir(folder)).filter((name) => name.endsWith(".tmp"))).toEqual([]);

    await fs.rm(blockedView, { recursive: true });
    await store.listInvoices();
    await expect(store.loadInvoice(created.id)).resolves.toMatchObject({
      revision: 0,
      rows: [],
    });
    expect(await fs.readFile(path.join(folder, "invoice.tsv"), "utf8")).not.toContain("Key Foods");
    expect(
      JSON.parse(await fs.readFile(path.join(folder, INVOICE_VIEW_STATE_FILENAME), "utf8"))
    ).toEqual(cleanViewState(created));
  });

  it("does not advance past an uncertain dirty-marker durability barrier", async () => {
    const created = await store.createInvoice(PERIOD, 4500);
    const folder = await store.getInvoiceFolder(created.id);
    const internals = store as unknown as {
      writeViewState(
        folder: string,
        invoice: InvoiceDocument,
        state: "clean" | "dirty"
      ): Promise<boolean>;
    };
    const originalWriteViewState = internals.writeViewState.bind(store);
    const writeViewState = vi
      .spyOn(internals, "writeViewState")
      .mockImplementation(async (targetFolder, invoice, state) => {
        const directorySynced = await originalWriteViewState(targetFolder, invoice, state);
        return invoice.revision === 1 && state === "dirty" ? false : directorySynced;
      });

    try {
      await expect(store.saveRows(created.id, [row()], created.revision)).rejects.toThrow(
        "durable invoice view update marker"
      );
    } finally {
      writeViewState.mockRestore();
    }

    await expect(store.loadInvoice(created.id)).resolves.toEqual(created);
    await expect(store.listInvoices()).resolves.toMatchObject([{ id: created.id }]);
    expect(
      JSON.parse(await fs.readFile(path.join(folder, INVOICE_VIEW_STATE_FILENAME), "utf8"))
    ).toEqual(cleanViewState(created));
  });

  it("persists a chosen row order unchanged in JSON, TSV, and CSV", async () => {
    const created = await store.createInvoice(PERIOD, 4500);
    const chosenOrder = [
      row({
        id: "persisted-first",
        date: "2026-01-20",
        comment: "Persisted first",
      }),
      row({
        id: "persisted-second",
        date: "2026-01-01",
        comment: "Persisted second",
      }),
      row({
        id: "persisted-third",
        date: null,
        comment: "Persisted third",
      }),
    ];

    const saved = await store.saveRows(created.id, chosenOrder, created.revision);
    const folder = await store.getInvoiceFolder(created.id);
    const json = JSON.parse(await fs.readFile(path.join(folder, "invoice.json"), "utf8")) as {
      rows: InvoiceRow[];
    };
    const tsv = await fs.readFile(path.join(folder, "invoice.tsv"), "utf8");
    const csv = await fs.readFile(path.join(folder, "invoice.csv"), "utf8");

    expect(saved.rows.map((entry) => entry.id)).toEqual(chosenOrder.map((entry) => entry.id));
    expect(json.rows.map((entry) => entry.id)).toEqual(chosenOrder.map((entry) => entry.id));
    expect(await store.loadInvoice(created.id)).toMatchObject({
      rows: chosenOrder,
    });
    for (const exported of [tsv, csv]) {
      expect(exported.indexOf("Persisted first")).toBeLessThan(
        exported.indexOf("Persisted second")
      );
      expect(exported.indexOf("Persisted second")).toBeLessThan(
        exported.indexOf("Persisted third")
      );
    }
  });

  it("serializes mutations per invoice and keeps the queue usable after errors", async () => {
    const created = await store.createInvoice(PERIOD, 4500);
    const first = store.mutateInvoice(created.id, async (draft) => {
      await Promise.resolve();
      draft.rows.push(row({ id: "first" }));
    });
    const second = store.mutateInvoice(created.id, (draft) => {
      draft.rows.push(row({ id: "second" }));
    });

    const [afterFirst, afterSecond] = await Promise.all([first, second]);
    expect(afterFirst.revision).toBe(1);
    expect(afterSecond.revision).toBe(2);
    expect(afterSecond.rows.map((entry) => entry.id)).toEqual(["first", "second"]);

    await expect(
      store.mutateInvoice(created.id, () => {
        throw new Error("mutator failed");
      })
    ).rejects.toThrow("mutator failed");
    const recovered = await store.mutateInvoice(created.id, (draft) => {
      draft.rows[0].comment = "recovered";
    });
    expect(recovered.revision).toBe(3);
    expect(recovered.rows[0].comment).toBe("recovered");
  });

  it("admits same-invoice mutations in call order even when alias lookup finishes later", async () => {
    const created = await store.createInvoice(PERIOD, 4500);
    const internal = store as unknown as {
      findInvoice(invoiceId: string): Promise<unknown>;
    };
    const originalFindInvoice = internal.findInvoice.bind(store);
    let releaseFirstLookup: () => void = () => undefined;
    const firstLookupGate = new Promise<void>((resolve) => {
      releaseFirstLookup = resolve;
    });
    let markFirstLookupStarted: () => void = () => undefined;
    const firstLookupStarted = new Promise<void>((resolve) => {
      markFirstLookupStarted = resolve;
    });
    let lookupCount = 0;
    internal.findInvoice = async (invoiceId) => {
      lookupCount += 1;
      if (lookupCount === 1) {
        markFirstLookupStarted();
        await firstLookupGate;
      }
      return originalFindInvoice(invoiceId);
    };

    const first = store.mutateInvoice(created.id, (draft) => {
      draft.rows.push(row({ id: "first" }));
    });
    await firstLookupStarted;
    const second = store.mutateInvoice(created.id, (draft) => {
      draft.rows.push(row({ id: "second" }));
    });
    await Promise.resolve();
    releaseFirstLookup();

    const [afterFirst, afterSecond] = await Promise.all([first, second]);
    expect(afterFirst.revision).toBe(1);
    expect(afterSecond.revision).toBe(2);
    expect(afterSecond.rows.map((entry) => entry.id)).toEqual(["first", "second"]);
  });

  it("serializes ID and folder-name aliases through one physical invoice queue", async () => {
    const created = await store.createInvoice(PERIOD, 4500);
    let releaseFirst: () => void = () => undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markFirstStarted: () => void = () => undefined;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const byId = store.mutateInvoice(created.id, async (draft) => {
      markFirstStarted();
      await firstGate;
      draft.rows.push(row({ id: "saved-by-id" }));
    });
    await firstStarted;

    const byName = store.mutateInvoice(created.name, (draft) => {
      draft.rows.push(row({ id: "saved-by-name" }));
    });
    // Give an incorrectly keyed second queue enough time to enter its mutator
    // before releasing the first. Correct canonical queueing keeps it waiting.
    await new Promise((resolve) => setTimeout(resolve, 25));
    releaseFirst();

    const [afterId, afterName] = await Promise.all([byId, byName]);
    expect(afterId).toMatchObject({
      revision: 1,
      rows: [expect.objectContaining({ id: "saved-by-id" })],
    });
    expect(afterName.revision).toBe(2);
    expect(afterName.rows.map((entry) => entry.id)).toEqual(["saved-by-id", "saved-by-name"]);
    expect((await store.loadInvoice(created.id)).rows).toEqual(afterName.rows);
  });

  it("allows only one concurrent writer for the same expected revision", async () => {
    const created = await store.createInvoice(PERIOD, 4500);
    const results = await Promise.allSettled([
      store.saveRows(created.id, [row({ id: "a" })], 0),
      store.saveRows(created.id, [row({ id: "b" })], 0),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: expect.any(RevisionConflictError),
    });
  });

  it("keeps loadInvoice read-only and regenerates views only when explicitly requested", async () => {
    const created = await store.createInvoice(PERIOD, 4500);
    const saved = await store.saveRows(created.id, [row()], 0);
    const folder = await store.getInvoiceFolder(saved.id);
    await fs.writeFile(path.join(folder, "invoice.tsv"), "stale", "utf8");
    await fs.rm(path.join(folder, "invoice.csv"));

    const loaded = await store.loadInvoice(saved.id);
    expect(loaded.revision).toBe(1);
    expect(await fs.readFile(path.join(folder, "invoice.tsv"), "utf8")).toBe("stale");
    await expect(fs.access(path.join(folder, "invoice.csv"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    await store.regenerateViews(saved.id);
    expect(await fs.readFile(path.join(folder, "invoice.tsv"), "utf8")).toContain("Key Foods");
    expect(await fs.readFile(path.join(folder, "invoice.csv"), "utf8")).toContain("Key Foods");
  });

  it("repairs a crash-dirty view state from authoritative JSON during invoice listing", async () => {
    const created = await store.createInvoice(PERIOD, 4500);
    const saved = await store.saveRows(created.id, [row()], created.revision);
    const folder = await store.getInvoiceFolder(saved.id);
    await fs.writeFile(path.join(folder, "invoice.tsv"), "future uncommitted rows", "utf8");
    await fs.rm(path.join(folder, "invoice.csv"));
    await fs.writeFile(
      path.join(folder, INVOICE_VIEW_STATE_FILENAME),
      `${JSON.stringify({
        schemaVersion: 1,
        revision: saved.revision + 1,
        invoiceSha256: invoiceDocumentFingerprint({ ...saved, revision: saved.revision + 1 }),
        state: "dirty",
      })}\n`,
      "utf8"
    );

    await expect(store.listInvoices()).resolves.toMatchObject([{ id: saved.id }]);

    expect(await fs.readFile(path.join(folder, "invoice.tsv"), "utf8")).toContain("Key Foods");
    expect(await fs.readFile(path.join(folder, "invoice.csv"), "utf8")).toContain("Key Foods");
    expect(
      JSON.parse(await fs.readFile(path.join(folder, INVOICE_VIEW_STATE_FILENAME), "utf8"))
    ).toEqual(cleanViewState(saved));
    await expect(store.loadInvoice(saved.id)).resolves.toEqual(saved);
  });

  it("does not reject a committed mutation when the final clean marker cannot be written", async () => {
    const created = await store.createInvoice(PERIOD, 4500);
    const folder = await store.getInvoiceFolder(created.id);
    const internals = store as unknown as {
      writeViewState(
        folder: string,
        invoice: InvoiceDocument,
        state: "clean" | "dirty"
      ): Promise<boolean>;
    };
    const originalWriteViewState = internals.writeViewState.bind(store);
    const writeViewState = vi
      .spyOn(internals, "writeViewState")
      .mockImplementation(async (targetFolder, invoice, state) => {
        if (invoice.revision === 1 && state === "clean") {
          throw new Error("simulated marker failure");
        }
        return originalWriteViewState(targetFolder, invoice, state);
      });

    let saved: InvoiceDocument;
    try {
      saved = await store.saveRows(created.id, [row()], created.revision);
    } finally {
      writeViewState.mockRestore();
    }

    expect(saved.revision).toBe(1);
    await expect(store.loadInvoice(created.id)).resolves.toEqual(saved);
    expect(
      JSON.parse(await fs.readFile(path.join(folder, INVOICE_VIEW_STATE_FILENAME), "utf8"))
    ).toEqual({ ...cleanViewState(saved), state: "dirty" });

    await store.listInvoices();
    expect(
      JSON.parse(await fs.readFile(path.join(folder, INVOICE_VIEW_STATE_FILENAME), "utf8"))
    ).toEqual(cleanViewState(saved));
  });

  it("upgrades a legacy marker-less folder during listing and takes the no-op fast path thereafter", async () => {
    const created = await store.createInvoice(PERIOD, 4500);
    const saved = await store.saveRows(created.id, [row()], created.revision);
    const folder = await store.getInvoiceFolder(saved.id);
    await fs.rm(path.join(folder, INVOICE_VIEW_STATE_FILENAME));
    await fs.writeFile(path.join(folder, "invoice.tsv"), "legacy stale view", "utf8");

    await expect(store.listInvoices()).resolves.toMatchObject([{ id: saved.id }]);
    expect(await fs.readFile(path.join(folder, "invoice.tsv"), "utf8")).toContain("Key Foods");
    await expect(store.repairDerivedViews()).resolves.toEqual({
      checked: 1,
      repaired: 0,
      failures: [],
    });

    const internals = store as unknown as {
      writeViews(folder: string, invoice: InvoiceDocument): Promise<void>;
    };
    const writeViews = vi.spyOn(internals, "writeViews");
    const readFile = vi.spyOn(fs, "readFile");
    try {
      await store.loadInvoice(saved.id);
      expect(
        readFile.mock.calls.some(([filename]) => /invoice\.(?:tsv|csv)$/.test(String(filename)))
      ).toBe(false);
      expect(writeViews).not.toHaveBeenCalled();
      readFile.mockClear();
      await expect(store.listInvoices()).resolves.toHaveLength(1);

      expect(writeViews).not.toHaveBeenCalled();
      expect(
        readFile.mock.calls.some(([filename]) => /invoice\.(?:tsv|csv)$/.test(String(filename)))
      ).toBe(false);
      expect(
        readFile.mock.calls.filter(
          ([filename]) => path.basename(String(filename)) === "invoice.json"
        )
      ).toHaveLength(1);
    } finally {
      writeViews.mockRestore();
      readFile.mockRestore();
    }
  });

  it("bounds maintenance work across marker-less invoice folders", async () => {
    const invoices = [];
    for (let month = 1; month <= INVOICE_VIEW_REPAIR_CONCURRENCY * 2 + 1; month += 1) {
      const monthText = String(month).padStart(2, "0");
      const invoice = await store.createInvoice(
        { startDate: `2026-${monthText}-01`, endDate: `2026-${monthText}-28` },
        4500
      );
      invoices.push(invoice);
      await fs.rm(path.join(await store.getInvoiceFolder(invoice.id), INVOICE_VIEW_STATE_FILENAME));
    }

    const internals = store as unknown as {
      writeViews(folder: string, invoice: InvoiceDocument): Promise<void>;
    };
    const originalWriteViews = internals.writeViews.bind(store);
    let active = 0;
    let maximumActive = 0;
    const writeViews = vi.spyOn(internals, "writeViews").mockImplementation(async (...args) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolve) => setImmediate(resolve));
      try {
        await originalWriteViews(...args);
      } finally {
        active -= 1;
      }
    });

    try {
      await expect(store.repairDerivedViews()).resolves.toEqual({
        checked: invoices.length,
        repaired: invoices.length,
        failures: [],
      });
      expect(maximumActive).toBe(INVOICE_VIEW_REPAIR_CONCURRENCY);
    } finally {
      writeViews.mockRestore();
    }
  });

  it("keeps a damaged derived view from hiding an otherwise healthy invoice", async () => {
    const created = await store.createInvoice(PERIOD, 4500);
    const folder = await store.getInvoiceFolder(created.id);
    await fs.rm(path.join(folder, INVOICE_VIEW_STATE_FILENAME));
    await fs.rm(path.join(folder, "invoice.tsv"));
    await fs.mkdir(path.join(folder, "invoice.tsv"));

    await expect(store.listInvoices()).resolves.toMatchObject([{ id: created.id }]);
    await expect(store.repairDerivedViews()).resolves.toMatchObject({
      checked: 1,
      repaired: 0,
      failures: [{ invoiceId: created.id, invoiceName: created.name }],
    });
    await expect(store.loadInvoice(created.id)).resolves.toMatchObject({ id: created.id });
  });

  it("uses its validated alias cache for repeated ID and name operations", async () => {
    const created = await store.createInvoice(PERIOD, 4500);
    const discoverInvoices = vi.spyOn(
      store as unknown as { discoverInvoices: () => Promise<unknown[]> },
      "discoverInvoices"
    );

    await store.loadInvoice(created.id);
    await store.getInvoiceFolder(created.id);
    const saved = await store.mutateInvoice(created.id, (draft) => {
      draft.rows.push(row());
    });
    await store.loadInvoice(saved.name);

    expect(discoverInvoices).not.toHaveBeenCalled();
  });

  it("scopes cached aliases to the configured base folder", async () => {
    const firstBase = baseFolder;
    const secondBase = await fs.mkdtemp(path.join(os.tmpdir(), "receipt-invoice-store-second-"));
    let activeBase = firstBase;
    let scopedId = 0;
    const scopedStore = new InvoiceStore(() => activeBase, {
      idFactory: () => `scoped-${++scopedId}`,
      now: () => new Date("2026-02-01T00:00:00.000Z"),
    });

    try {
      const first = await scopedStore.createInvoice(PERIOD, 4500);
      activeBase = secondBase;
      await expect(scopedStore.loadInvoice(first.id)).rejects.toBeInstanceOf(InvoiceNotFoundError);
      const second = await scopedStore.createInvoice(PERIOD, 4500);
      expect(second.id).not.toBe(first.id);

      activeBase = firstBase;
      await expect(scopedStore.loadInvoice(first.id)).resolves.toMatchObject({ id: first.id });
      await expect(scopedStore.loadInvoice(second.id)).rejects.toBeInstanceOf(InvoiceNotFoundError);
    } finally {
      await fs.rm(secondBase, { recursive: true, force: true });
    }
  });

  it("invalidates a cached alias when invoice.json is replaced externally", async () => {
    const created = await store.createInvoice(PERIOD, 4500);
    const folder = await store.getInvoiceFolder(created.id);
    const invoicePath = path.join(folder, "invoice.json");
    const replaced = JSON.parse(await fs.readFile(invoicePath, "utf8")) as InvoiceDocument;
    replaced.id = "externally-replaced-id";
    replaced.rows = [row()];
    await fs.writeFile(invoicePath, `${JSON.stringify(replaced, null, 2)}\n`, "utf8");

    await expect(store.loadInvoice(created.id)).rejects.toBeInstanceOf(InvoiceNotFoundError);
    await expect(store.loadInvoice("externally-replaced-id")).resolves.toMatchObject({
      id: "externally-replaced-id",
    });

    await expect(store.listInvoices()).resolves.toMatchObject([{ id: "externally-replaced-id" }]);
    expect(await fs.readFile(path.join(folder, "invoice.tsv"), "utf8")).toContain("Key Foods");
    expect(
      JSON.parse(await fs.readFile(path.join(folder, INVOICE_VIEW_STATE_FILENAME), "utf8"))
    ).toEqual(cleanViewState(replaced));
  });

  it("finds receipt hashes across invoices and exposes the canonical folder", async () => {
    const created = await store.createInvoice(PERIOD, 4500);
    const saved = await store.mutateInvoice(created.id, (draft) => {
      draft.receipts.push(receipt());
    });

    expect(await store.findHash("A".repeat(64))).toEqual([
      {
        invoiceId: saved.id,
        invoiceName: saved.name,
        receiptId: "receipt-1",
        relativePath: "receipts/receipt-1.jpg",
      },
    ]);
    expect(await store.getInvoiceFolder(saved.id)).toBe(path.join(baseFolder, saved.name));
  });

  it("finds multiple receipt hashes with one bulk lookup", async () => {
    const first = await store.createInvoice(PERIOD, 4500);
    const second = await store.createInvoice(
      { startDate: "2026-02-01", endDate: "2026-02-28" },
      4500
    );
    await store.mutateInvoice(first.id, (draft) => {
      draft.receipts.push(receipt({ id: "first", sha256: "A".repeat(64) }));
    });
    await store.mutateInvoice(second.id, (draft) => {
      draft.receipts.push(
        receipt({
          id: "second",
          relativePath: "receipts/second.jpg",
          debugPath: "debug/second.json",
          sha256: "b".repeat(64),
        })
      );
    });

    const matches = await store.findHashes([` ${"a".repeat(64)} `, "B".repeat(64), "missing"]);

    expect([...matches.keys()]).toEqual(["a".repeat(64), "b".repeat(64), "missing"]);
    expect(matches.get("a".repeat(64))?.map((match) => match.receiptId)).toEqual(["first"]);
    expect(matches.get("b".repeat(64))?.map((match) => match.receiptId)).toEqual(["second"]);
    expect(matches.get("missing")).toEqual([]);
  });

  it("validates rows before replacing a good invoice", async () => {
    const created = await store.createInvoice(PERIOD, 4500);
    await expect(store.saveRows(created.id, [row({ hours: "1e3" })], 0)).rejects.toBeInstanceOf(
      InvoiceValidationError
    );
    expect((await store.loadInvoice(created.id)).revision).toBe(0);
  });

  it("rejects malformed persisted receipt hashes and timestamps", async () => {
    const created = await store.createInvoice(PERIOD, 4500);
    const saved = await store.mutateInvoice(created.id, (draft) => {
      draft.receipts.push(receipt());
    });
    const folder = await store.getInvoiceFolder(saved.id);
    const invoicePath = path.join(folder, "invoice.json");
    const valid = JSON.parse(await fs.readFile(invoicePath, "utf8"));

    const corruptions: Array<{
      update: (invoice: typeof valid) => void;
      message: RegExp;
    }> = [
      {
        update: (invoice) => {
          invoice.receipts[0].sha256 = "not-a-sha-256";
        },
        message: /SHA-256 must be a 64-character hexadecimal value/,
      },
      {
        update: (invoice) => {
          invoice.receipts[0].importedAt = "yesterday";
        },
        message: /imported at must use canonical ISO-8601 format/,
      },
      {
        update: (invoice) => {
          invoice.createdAt = "2026-02-01T00:00:00Z";
        },
        message: /created timestamp must use canonical ISO-8601 format/,
      },
      {
        update: (invoice) => {
          invoice.updatedAt = "not-a-timestamp";
        },
        message: /updated timestamp must use canonical ISO-8601 format/,
      },
    ];

    for (const { update, message } of corruptions) {
      const corrupted = structuredClone(valid);
      update(corrupted);
      await fs.writeFile(invoicePath, `${JSON.stringify(corrupted, null, 2)}\n`);
      await expect(store.loadInvoice(created.name)).rejects.toThrow(message);
    }

    valid.receipts[0].sha256 = "B".repeat(64);
    await fs.writeFile(invoicePath, `${JSON.stringify(valid, null, 2)}\n`);
    await expect(store.loadInvoice(created.name)).resolves.toMatchObject({
      receipts: [{ sha256: "b".repeat(64) }],
    });
  });

  it("rejects managed paths that escape their receipt or debug directories", async () => {
    const created = await store.createInvoice(PERIOD, 4500);

    await expect(
      store.mutateInvoice(created.id, (draft) => {
        draft.receipts.push(
          receipt({
            relativePath: "receipts/../../outside.jpg",
            debugPath: "debug/receipt-1.json",
          })
        );
      })
    ).rejects.toThrow(/stay inside receipts/);
    await expect(
      store.mutateInvoice(created.id, (draft) => {
        draft.receipts.push(
          receipt({
            relativePath: "receipts/receipt-1.jpg",
            debugPath: "invoice.json",
          })
        );
      })
    ).rejects.toThrow(/stay inside debug/);
    expect((await store.loadInvoice(created.id)).revision).toBe(0);
  });

  it("prevents dangling or multiply-owned receipt references", async () => {
    const created = await store.createInvoice(PERIOD, 4500);

    await expect(
      store.saveRows(created.id, [row({ receiptId: "missing-receipt" })], created.revision)
    ).rejects.toThrow(/missing receipts/);
    await expect(
      store.mutateInvoice(created.id, (draft) => {
        draft.receipts.push(receipt());
        draft.rows.push(
          row({ id: "first", receiptId: "receipt-1" }),
          row({ id: "second", receiptId: "receipt-1" })
        );
      })
    ).rejects.toThrow(/only one invoice row/);
  });

  it("refuses symlinked managed directories", async () => {
    const created = await store.createInvoice(PERIOD, 4500);
    const folder = await store.getInvoiceFolder(created.id);
    const target = path.join(baseFolder, "outside-receipts");
    await fs.mkdir(target);
    await fs.rm(path.join(folder, "receipts"), { recursive: true });
    await fs.symlink(target, path.join(folder, "receipts"), "dir");

    await expect(store.loadInvoice(created.id)).rejects.toThrow(/ordinary directory/);
  });

  it("refuses a symlinked authoritative invoice JSON file", async () => {
    const created = await store.createInvoice(PERIOD, 4500);
    const folder = await store.getInvoiceFolder(created.id);
    const outside = path.join(baseFolder, "outside-invoice.json");
    await fs.writeFile(outside, "{}", "utf8");
    await fs.rm(path.join(folder, "invoice.json"));
    await fs.symlink(outside, path.join(folder, "invoice.json"));

    await expect(store.loadInvoice(created.name)).rejects.toThrow(
      /Invoice JSON must be an ordinary file/
    );
  });

  it("supports an async base-folder getter and clearly reports missing setup", async () => {
    const missing = new InvoiceStore(async () => null);
    await expect(missing.listInvoices()).rejects.toBeInstanceOf(BaseFolderNotConfiguredError);
  });

  it("does not silently recreate an unavailable configured base folder", async () => {
    const configured = baseFolder;
    await fs.rm(configured, { recursive: true });

    await expect(store.listInvoices()).rejects.toThrow(/unavailable/);
    await expect(fs.access(configured)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
