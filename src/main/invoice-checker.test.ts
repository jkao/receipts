import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InvoiceRow, ReceiptDebug, ReceiptRecord, ReceiptStatus } from "../shared/types";
import { InvoiceChecker, ReviewFindingUnavailableError } from "./invoice-checker";
import { InvoiceStore, RevisionConflictError } from "./invoice-store";

describe("InvoiceChecker", () => {
  let baseFolder: string;
  let store: InvoiceStore;
  let nextInvoiceId: number;

  beforeEach(async () => {
    baseFolder = await fs.mkdtemp(path.join(os.tmpdir(), "invoice-check-test-"));
    nextInvoiceId = 1;
    store = new InvoiceStore(() => baseFolder, {
      now: () => new Date("2026-08-21T11:00:00.000Z"),
      idFactory: () => `inv_${nextInvoiceId++}`,
    });
  });

  afterEach(async () => {
    await fs.rm(baseFolder, { recursive: true, force: true });
  });

  it("groups exact receipt hashes once, excludes self, and keeps IDs invoice-local", async () => {
    const current = await store.createInvoice({
      startDate: "2026-01-01",
      endDate: "2026-01-31",
    });
    const other = await store.createInvoice({
      startDate: "2026-02-01",
      endDate: "2026-02-28",
    });
    const hash = "a".repeat(64);
    await store.mutateInvoice(current.id, (invoice) => {
      invoice.receipts.push(
        receipt("current-1", hash),
        receipt("current-orphan", hash),
        receipt("unique-self", "d".repeat(64))
      );
      invoice.rows.push(
        row({
          id: "current-row",
          date: "2026-01-10",
          groceriesMinor: 1200,
          comment: "First merchant",
          receiptId: "current-1",
        })
      );
    });
    await store.mutateInvoice(other.id, (invoice) => {
      invoice.receipts.push(receipt("foreign-receipt", hash));
    });
    const findHashes = vi.spyOn(store, "findHashes");
    const checker = new InvoiceChecker(store, {
      now: () => new Date("2026-08-21T12:00:00.000Z"),
    });

    const result = await checker.checkInvoice(current.id);
    const duplicateIssues = result.issues.filter(
      (issue) => issue.code === "exact-receipt-duplicate"
    );

    expect(findHashes).toHaveBeenCalledTimes(1);
    expect([...findHashes.mock.calls[0][0]]).toEqual([hash, "d".repeat(64)]);
    expect(duplicateIssues).toMatchObject([
      {
        code: "exact-receipt-duplicate",
        message:
          `Identical receipt file content appears more than once in this invoice. ` +
          `Identical receipt file content also appears in ${other.name}.`,
        rowIds: ["current-row"],
        receiptIds: ["current-1", "current-orphan"],
      },
    ]);
    expect(duplicateIssues[0]).toMatchObject({
      acknowledgeable: true,
      acknowledgedAt: null,
      fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(result).toMatchObject({
      invoiceId: current.id,
      checkedAt: "2026-08-21T12:00:00.000Z",
    });
  });

  it("reports each unordered likely-transaction pair once, including zero totals", async () => {
    const invoice = await store.createInvoice({
      startDate: "2026-03-01",
      endDate: "2026-03-31",
    });
    const saved = await store.saveRows(
      invoice.id,
      [
        row({ id: "a", date: "2026-03-10", groceriesMinor: 0, comment: "Café Market" }),
        row({ id: "b", date: "2026-03-10", groceriesMinor: 0, comment: "cafe-market!!" }),
        row({ id: "c", date: null, groceriesMinor: 0, comment: "Cafe Market" }),
        row({ id: "d", date: "2026-03-10", groceriesMinor: 1, comment: "Cafe Market" }),
      ],
      invoice.revision
    );
    const checker = new InvoiceChecker(store);

    const result = await checker.checkInvoice(invoice.id);

    expect(result.revision).toBe(saved.revision);
    expect(
      result.issues.filter((issue) => issue.code === "likely-transaction-duplicate")
    ).toMatchObject([
      {
        code: "likely-transaction-duplicate",
        message:
          "These rows may describe the same transaction: merchant/comment, date, and total match.",
        rowIds: ["a", "b"],
        receiptIds: [],
      },
    ]);
  });

  it("reopens an acknowledged exact duplicate when the external match set changes", async () => {
    const current = await store.createInvoice({
      startDate: "2026-01-01",
      endDate: "2026-01-31",
    });
    const other = await store.createInvoice({
      startDate: "2026-02-01",
      endDate: "2026-02-28",
    });
    const hash = "7".repeat(64);
    const saved = await store.mutateInvoice(current.id, (draft) => {
      draft.receipts.push(receipt("current", hash));
      draft.rows.push(
        row({
          id: "current-row",
          date: "2026-01-02",
          groceriesMinor: 100,
          comment: "Market",
          receiptId: "current",
        })
      );
    });
    await store.mutateInvoice(other.id, (draft) => {
      draft.receipts.push(receipt("other", hash));
    });
    const checker = new InvoiceChecker(store);
    const first = (await checker.checkInvoice(current.id)).issues.find(
      (issue) => issue.code === "exact-receipt-duplicate"
    );
    const acknowledged = await checker.setReviewAcknowledgement(
      current.id,
      first!.fingerprint,
      true,
      saved.revision
    );

    const third = await store.createInvoice({
      startDate: "2026-03-01",
      endDate: "2026-03-31",
    });
    await store.mutateInvoice(third.id, (draft) => {
      draft.receipts.push(receipt("third", hash));
    });
    const changed = (await checker.checkInvoice(current.id)).issues.find(
      (issue) => issue.code === "exact-receipt-duplicate"
    );
    expect(changed?.fingerprint).not.toBe(first?.fingerprint);
    expect(changed?.acknowledgedAt).toBeNull();
    expect(acknowledged.check.issues).toContainEqual(
      expect.objectContaining({
        fingerprint: first!.fingerprint,
        acknowledgedAt: expect.any(String),
      })
    );
  });

  it("uses deterministic scan state and missing fields instead of probability", async () => {
    const invoice = await store.createInvoice({
      startDate: "2026-04-01",
      endDate: "2026-04-30",
    });
    await store.mutateInvoice(invoice.id, (draft) => {
      draft.receipts.push(
        receipt("review-receipt", "b".repeat(64), "needs-review"),
        receipt("ready-receipt", "c".repeat(64), "ready")
      );
      draft.rows.push(
        row({ id: "review-row", receiptId: "review-receipt", comment: "---" }),
        row({
          id: "ready-row",
          receiptId: "ready-receipt",
          date: "2026-04-02",
          groceriesMinor: 0,
          comment: "Complete Merchant",
        })
      );
    });
    const folder = await store.getInvoiceFolder(invoice.id);
    await fs.writeFile(
      path.join(folder, "debug", "review-receipt.json"),
      JSON.stringify(
        receiptDebug("review-receipt", "2026-08-21T10:30:00.000Z", [
          "The receipt total does not match its itemized sum.",
        ])
      )
    );
    const checker = new InvoiceChecker(store);

    const result = await checker.checkInvoice(invoice.id);

    expect(
      result.issues.filter((issue) =>
        ["receipt-scan-warning", "receipt-fields-incomplete"].includes(issue.code)
      )
    ).toMatchObject([
      {
        code: "receipt-scan-warning",
        message: "The receipt total does not match its itemized sum.",
        rowIds: ["review-row"],
        receiptIds: ["review-receipt"],
        acknowledgeable: true,
      },
      {
        code: "receipt-fields-incomplete",
        message: "Scan-linked row is missing date, total, and merchant/comment.",
        rowIds: ["review-row"],
        receiptIds: ["review-receipt"],
      },
    ]);
  });

  it("reports status and missing linkage for an orphan receipt allowed by the store", async () => {
    const invoice = await store.createInvoice({
      startDate: "2026-04-01",
      endDate: "2026-04-30",
    });
    await store.mutateInvoice(invoice.id, (draft) => {
      draft.receipts.push(receipt("orphan-receipt", "d".repeat(64), "error"));
    });

    const result = await new InvoiceChecker(store).checkInvoice(invoice.id);

    expect(
      result.issues.filter((issue) =>
        ["receipt-scan-not-ready", "receipt-fields-incomplete"].includes(issue.code)
      )
    ).toMatchObject([
      {
        code: "receipt-scan-not-ready",
        message: "Receipt scan is not ready (status: error).",
        rowIds: [],
        receiptIds: ["orphan-receipt"],
        acknowledgeable: false,
      },
      {
        code: "receipt-fields-incomplete",
        message: "Receipt is not linked to an invoice row.",
        rowIds: [],
        receiptIds: ["orphan-receipt"],
      },
    ]);
  });

  it("treats period bounds as inclusive and leaves a saved out-of-range row untouched", async () => {
    const invoice = await store.createInvoice({
      startDate: "2026-05-01",
      endDate: "2026-05-31",
    });
    const saved = await store.saveRows(
      invoice.id,
      [
        row({ id: "start", date: "2026-05-01" }),
        row({ id: "end", date: "2026-05-31" }),
        row({ id: "null", date: null }),
        row({ id: "outside", date: "2026-06-01" }),
      ],
      invoice.revision
    );
    const checker = new InvoiceChecker(store, {
      now: () => new Date("2026-08-21T12:00:00.000Z"),
    });

    const result = await checker.checkInvoice(invoice.id);

    expect(result.revision).toBe(saved.revision);
    expect(result.issues.filter((issue) => issue.code === "date-outside-period")).toMatchObject([
      {
        code: "date-outside-period",
        message: "Row date 2026-06-01 is outside invoice period 2026-05-01 to 2026-05-31.",
        rowIds: ["outside"],
        receiptIds: [],
      },
    ]);
    expect(await store.loadInvoice(invoice.id)).toEqual(saved);
  });

  it("persists acknowledgements, keeps unchanged findings checked, and reopens changed evidence", async () => {
    const created = await store.createInvoice({
      startDate: "2026-06-01",
      endDate: "2026-06-30",
    });
    const duplicateRows = [
      row({
        id: "left",
        date: "2026-06-02",
        groceriesMinor: 1200,
        hours: "1",
        comment: "Market",
      }),
      row({
        id: "right",
        date: "2026-06-02",
        groceriesMinor: 1200,
        comment: "market",
      }),
    ];
    const saved = await store.saveRows(created.id, duplicateRows, created.revision);
    const folder = await store.getInvoiceFolder(created.id);
    const tabularBeforeReview = await Promise.all(
      ["invoice.tsv", "invoice.csv"].map((filename) =>
        fs.readFile(path.join(folder, filename), "utf8")
      )
    );
    const checker = new InvoiceChecker(store, {
      now: () => new Date("2026-08-21T12:00:00.000Z"),
    });
    const original = (await checker.checkInvoice(created.id)).issues.find(
      (issue) => issue.code === "likely-transaction-duplicate"
    );
    expect(original).toBeDefined();

    const acknowledged = await checker.setReviewAcknowledgement(
      created.id,
      original!.fingerprint,
      true,
      saved.revision
    );
    expect(acknowledged.invoice.revision).toBe(saved.revision + 1);
    expect(acknowledged.check.revision).toBe(acknowledged.invoice.revision);
    expect(acknowledged.invoice.reviewAcknowledgements).toEqual([
      {
        fingerprint: original!.fingerprint,
        acknowledgedAt: "2026-08-21T12:00:00.000Z",
      },
    ]);
    expect(
      acknowledged.check.issues.find((issue) => issue.fingerprint === original!.fingerprint)
        ?.acknowledgedAt
    ).toBe("2026-08-21T12:00:00.000Z");
    await expect(
      Promise.all(
        ["invoice.tsv", "invoice.csv"].map((filename) =>
          fs.readFile(path.join(folder, filename), "utf8")
        )
      )
    ).resolves.toEqual(tabularBeforeReview);
    expect(
      (await checker.checkInvoice(created.id)).issues.find(
        (issue) => issue.fingerprint === original!.fingerprint
      )?.acknowledgedAt
    ).toBe("2026-08-21T12:00:00.000Z");

    const cosmeticallyEdited = await store.saveRows(
      created.id,
      acknowledged.invoice.rows.map((item) => ({
        ...item,
        comment: item.id === "left" ? "Márket!!!" : " market ",
      })),
      acknowledged.invoice.revision
    );
    const sameFinding = (await checker.checkInvoice(created.id)).issues.find(
      (issue) => issue.code === "likely-transaction-duplicate"
    );
    expect(sameFinding?.fingerprint).toBe(original?.fingerprint);
    expect(sameFinding?.acknowledgedAt).toBe("2026-08-21T12:00:00.000Z");

    const changed = await store.saveRows(
      created.id,
      cosmeticallyEdited.rows.map((item) => ({
        ...item,
        comment: item.id === "left" ? "New Market" : "new-market",
      })),
      cosmeticallyEdited.revision
    );
    const changedIssue = (await checker.checkInvoice(created.id)).issues.find(
      (issue) => issue.code === "likely-transaction-duplicate"
    );
    expect(changedIssue).toBeDefined();
    expect(changedIssue?.fingerprint).not.toBe(original?.fingerprint);
    expect(changedIssue?.acknowledgedAt).toBeNull();

    const reacknowledged = await checker.setReviewAcknowledgement(
      created.id,
      changedIssue!.fingerprint,
      true,
      changed.revision
    );
    expect(reacknowledged.invoice.reviewAcknowledgements).toHaveLength(1);
    expect(reacknowledged.invoice.reviewAcknowledgements[0].fingerprint).toBe(
      changedIssue!.fingerprint
    );
    const unchecked = await checker.setReviewAcknowledgement(
      created.id,
      changedIssue!.fingerprint,
      false,
      reacknowledged.invoice.revision
    );
    expect(unchecked.invoice.reviewAcknowledgements).toEqual([]);
    expect(
      unchecked.check.issues.find((issue) => issue.fingerprint === changedIssue!.fingerprint)
        ?.acknowledgedAt
    ).toBeNull();
  });

  it("uses scan timestamp and warnings as causal evidence so a retry reopens review", async () => {
    const created = await store.createInvoice({
      startDate: "2026-07-01",
      endDate: "2026-07-31",
    });
    const saved = await store.mutateInvoice(created.id, (draft) => {
      draft.receipts.push(receipt("review-receipt", "e".repeat(64), "needs-review"));
      draft.rows.push(
        row({
          id: "review-row",
          date: "2026-07-02",
          groceriesMinor: 500,
          comment: "Market",
          receiptId: "review-receipt",
        })
      );
    });
    const folder = await store.getInvoiceFolder(created.id);
    const debugPath = path.join(folder, "debug", "review-receipt.json");
    const writeDebug = (scannedAt: string, warnings: string[]) =>
      fs.writeFile(debugPath, JSON.stringify(receiptDebug("review-receipt", scannedAt, warnings)));
    await writeDebug("2026-08-21T09:00:00.000Z", [
      "Verify the detected total.",
      "Verify the detected date.",
    ]);
    const checker = new InvoiceChecker(store);
    const first = (await checker.checkInvoice(created.id)).issues.find(
      (issue) => issue.code === "receipt-scan-warning"
    );
    const acknowledged = await checker.setReviewAcknowledgement(
      created.id,
      first!.fingerprint,
      true,
      saved.revision
    );

    await writeDebug("2026-08-21T09:00:00.000Z", [
      "Verify the detected date.",
      "  Verify the detected total.  ",
    ]);
    await store.mutateInvoice(created.id, () => undefined);
    const reordered = (await checker.checkInvoice(created.id)).issues.find(
      (issue) => issue.message === "Verify the detected total."
    );
    expect(reordered?.fingerprint).toBe(first?.fingerprint);
    expect(reordered?.acknowledgedAt).toEqual(expect.any(String));

    await writeDebug("2026-08-21T10:00:00.000Z", [
      "Verify the detected total.",
      "Verify the detected date.",
    ]);
    await store.mutateInvoice(created.id, () => undefined);
    const retried = (await checker.checkInvoice(created.id)).issues.find(
      (issue) => issue.message === "Verify the detected total."
    );
    expect(retried?.fingerprint).not.toBe(first?.fingerprint);
    expect(retried?.acknowledgedAt).toBeNull();
    expect(acknowledged.check.issues).toContainEqual(
      expect.objectContaining({
        fingerprint: first!.fingerprint,
        acknowledgedAt: expect.any(String),
      })
    );
  });

  it("rejects acknowledgement of operational scan states and stale revisions", async () => {
    const created = await store.createInvoice({
      startDate: "2026-08-01",
      endDate: "2026-08-31",
    });
    const saved = await store.mutateInvoice(created.id, (draft) => {
      draft.receipts.push(receipt("failed", "f".repeat(64), "error"));
      draft.rows.push(row({ id: "failed-row", receiptId: "failed" }));
    });
    const checker = new InvoiceChecker(store);
    const operational = (await checker.checkInvoice(created.id)).issues.find(
      (issue) => issue.code === "receipt-scan-not-ready"
    );
    expect(operational?.acknowledgeable).toBe(false);
    await expect(
      checker.setReviewAcknowledgement(created.id, operational!.fingerprint, true, saved.revision)
    ).rejects.toBeInstanceOf(ReviewFindingUnavailableError);

    const incomplete = (await checker.checkInvoice(created.id)).issues.find(
      (issue) => issue.code === "receipt-fields-incomplete"
    );
    await expect(
      checker.setReviewAcknowledgement(
        created.id,
        incomplete!.fingerprint,
        true,
        saved.revision - 1
      )
    ).rejects.toBeInstanceOf(RevisionConflictError);
    expect(await store.loadInvoice(created.id)).toMatchObject({
      revision: saved.revision,
      reviewAcknowledgements: [],
    });
  });

  it("refuses to read scan-warning evidence through a symbolic link", async () => {
    const created = await store.createInvoice({
      startDate: "2026-08-01",
      endDate: "2026-08-31",
    });
    await store.mutateInvoice(created.id, (draft) => {
      draft.receipts.push(receipt("linked-debug", "8".repeat(64), "needs-review"));
      draft.rows.push(
        row({
          id: "linked-row",
          date: "2026-08-02",
          groceriesMinor: 500,
          comment: "Market",
          receiptId: "linked-debug",
        })
      );
    });
    const folder = await store.getInvoiceFolder(created.id);
    const outsideDebug = path.join(baseFolder, "outside-debug.json");
    await fs.writeFile(
      outsideDebug,
      JSON.stringify(
        receiptDebug("linked-debug", "2026-08-21T10:00:00.000Z", ["This must not be followed."])
      )
    );
    await fs.symlink(outsideDebug, path.join(folder, "debug", "linked-debug.json"));

    await expect(new InvoiceChecker(store).checkInvoice(created.id)).rejects.toThrow(
      /symbolic link/i
    );
  });

  it("aligns incomplete-field fingerprints with the missing-field predicate", async () => {
    const created = await store.createInvoice({
      startDate: "2026-08-01",
      endDate: "2026-08-31",
    });
    const saved = await store.mutateInvoice(created.id, (draft) => {
      draft.receipts.push(receipt("incomplete", "9".repeat(64)));
      draft.rows.push(row({ id: "incomplete-row", receiptId: "incomplete", comment: " " }));
    });
    const checker = new InvoiceChecker(store, {
      now: () => new Date("2026-08-21T12:00:00.000Z"),
    });
    const first = (await checker.checkInvoice(created.id)).issues.find(
      (issue) => issue.code === "receipt-fields-incomplete"
    );
    const acknowledged = await checker.setReviewAcknowledgement(
      created.id,
      first!.fingerprint,
      true,
      saved.revision
    );

    const whitespaceOnly = await store.saveRows(
      created.id,
      acknowledged.invoice.rows.map((item) => ({
        ...item,
        hours: "1",
        comment: "\t\n",
      })),
      acknowledged.invoice.revision
    );
    const sameFinding = (await checker.checkInvoice(created.id)).issues.find(
      (issue) => issue.code === "receipt-fields-incomplete"
    );
    expect(sameFinding?.fingerprint).toBe(first?.fingerprint);
    expect(sameFinding?.acknowledgedAt).toBe("2026-08-21T12:00:00.000Z");

    await store.saveRows(
      created.id,
      whitespaceOnly.rows.map((item) => ({ ...item, comment: "Market" })),
      whitespaceOnly.revision
    );
    const changedFinding = (await checker.checkInvoice(created.id)).issues.find(
      (issue) => issue.code === "receipt-fields-incomplete"
    );
    expect(changedFinding?.fingerprint).not.toBe(first?.fingerprint);
    expect(changedFinding?.acknowledgedAt).toBeNull();
  });
});

function row(overrides: Partial<InvoiceRow> & Pick<InvoiceRow, "id">): InvoiceRow {
  const { id, ...rest } = overrides;
  return {
    id,
    date: null,
    groceriesMinor: null,
    hours: "",
    rateMinor: 4500,
    comment: "",
    receiptId: null,
    ...rest,
  };
}

function receipt(id: string, sha256: string, status: ReceiptStatus = "ready"): ReceiptRecord {
  return {
    id,
    relativePath: `receipts/${id}.jpg`,
    debugPath: `debug/${id}.json`,
    originalFilename: `${id}.jpg`,
    mimeType: "image/jpeg",
    sha256,
    source: { kind: "manual", method: "file-picker" },
    status,
    importedAt: "2026-08-21T10:00:00.000Z",
  };
}

function receiptDebug(
  receiptId: string,
  scannedAt: string,
  validationWarnings: string[]
): ReceiptDebug {
  return {
    receiptId,
    provider: "openai",
    model: "test-model",
    scannedAt,
    extraction: {
      merchant: "Market",
      date: "2026-08-20",
      currency: "USD",
      subtotal: "10.00",
      tax: null,
      tip: null,
      adjustments: [],
      total: "10.00",
      items: [],
    },
    validationWarnings,
    usage: {},
  };
}
