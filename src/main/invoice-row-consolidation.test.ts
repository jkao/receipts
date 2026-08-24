import { describe, expect, it } from "vitest";

import { consolidateInvoiceRows } from "../shared/invoice-row-consolidation";
import type { InvoiceRow } from "../shared/types";
import { applyScannedReceiptToRows } from "./invoice-row-consolidation";

const DATE = "2026-01-12";
const DEFAULT_RATE_MINOR = 4_500;

function row(overrides: Partial<InvoiceRow> = {}): InvoiceRow {
  return {
    id: "row-manual",
    date: DATE,
    groceriesMinor: null,
    hours: "2.5",
    rateMinor: 5_000,
    comment: "",
    receiptId: null,
    ...overrides,
  };
}

function applyScan(rows: InvoiceRow[], receiptId: string, createRowId = () => "row-work") {
  applyScannedReceiptToRows(
    rows,
    receiptId,
    {
      date: DATE,
      groceriesMinor: 1_073,
      merchant: "  Key Foods  ",
    },
    { defaultRateMinor: DEFAULT_RATE_MINOR, createRowId }
  );
}

describe("applyScannedReceiptToRows", () => {
  it("exposes a pure consolidation helper for renderer-originated row changes", () => {
    const rows = [
      row(),
      row({
        id: "row-receipt",
        hours: "",
        rateMinor: DEFAULT_RATE_MINOR,
        comment: "Key Foods",
        receiptId: "receipt-1",
      }),
    ];

    const consolidated = consolidateInvoiceRows(rows, {
      defaultRateMinor: DEFAULT_RATE_MINOR,
      createRowId: () => "row-work",
    });

    expect(consolidated).toHaveLength(1);
    expect(consolidated[0]).toMatchObject({
      id: "row-receipt",
      hours: "2.5",
      rateMinor: 5_000,
      receiptId: "receipt-1",
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: "row-manual", hours: "2.5", receiptId: null });
    expect(consolidated[0]).not.toBe(rows[1]);
  });

  it("merges one receipt into one losslessly compatible work row on the same date", () => {
    const rows = [
      row(),
      row({
        id: "row-receipt",
        date: null,
        hours: "",
        rateMinor: DEFAULT_RATE_MINOR,
        comment: "receipt filename",
        receiptId: "receipt-1",
      }),
    ];

    applyScan(rows, "receipt-1");

    expect(rows).toEqual([
      {
        id: "row-receipt",
        date: DATE,
        groceriesMinor: 1_073,
        hours: "2.5",
        rateMinor: 5_000,
        comment: "Key Foods",
        receiptId: "receipt-1",
      },
    ]);
  });

  it("restores one work row when a second receipt lands on the same date", () => {
    let nextId = 0;
    const rows = [
      row({ hours: "3.25", rateMinor: 6_000 }),
      row({
        id: "row-receipt-1",
        date: null,
        hours: "",
        rateMinor: DEFAULT_RATE_MINOR,
        receiptId: "receipt-1",
      }),
      row({
        id: "row-receipt-2",
        date: null,
        hours: "",
        rateMinor: DEFAULT_RATE_MINOR,
        receiptId: "receipt-2",
      }),
    ];

    applyScan(rows, "receipt-1", () => `row-work-${++nextId}`);
    applyScan(rows, "receipt-2", () => `row-work-${++nextId}`);

    expect(rows).toHaveLength(3);
    expect(rows.filter((candidate) => candidate.receiptId === null)).toEqual([
      expect.objectContaining({
        id: "row-work-1",
        date: DATE,
        groceriesMinor: null,
        hours: "3.25",
        rateMinor: 6_000,
        comment: "",
      }),
    ]);
    expect(rows.filter((candidate) => candidate.receiptId !== null)).toEqual([
      expect.objectContaining({ receiptId: "receipt-1", hours: "", rateMinor: 4_500 }),
      expect.objectContaining({ receiptId: "receipt-2", hours: "", rateMinor: 4_500 }),
    ]);
  });

  it.each([
    {
      label: "manual groceries",
      manual: { groceriesMinor: 250 },
      receipt: {},
    },
    {
      label: "a manual comment",
      manual: { comment: "Delivery shift" },
      receipt: {},
    },
    {
      label: "work already entered on the receipt",
      manual: {},
      receipt: { hours: "1" },
    },
    {
      label: "a customized receipt-row rate",
      manual: {},
      receipt: { rateMinor: 7_500 },
    },
  ])("does not merge when $label would make the merge ambiguous", ({ manual, receipt }) => {
    const rows = [
      row(manual),
      row({
        id: "row-receipt",
        date: null,
        hours: "",
        rateMinor: DEFAULT_RATE_MINOR,
        receiptId: "receipt-1",
        ...receipt,
      }),
    ];

    applyScan(rows, "receipt-1");

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject(manual);
    expect(rows[1]).toMatchObject({
      date: DATE,
      groceriesMinor: 1_073,
      comment: "Key Foods",
      receiptId: "receipt-1",
    });
  });

  it("leaves multiple manual rows intact instead of guessing which one to merge", () => {
    const rows = [
      row({ id: "manual-1" }),
      row({ id: "manual-2", hours: "1" }),
      row({
        id: "row-receipt",
        date: null,
        hours: "",
        rateMinor: DEFAULT_RATE_MINOR,
        receiptId: "receipt-1",
      }),
    ];

    applyScan(rows, "receipt-1");

    expect(rows).toHaveLength(3);
    expect(rows.filter((candidate) => candidate.receiptId === null)).toHaveLength(2);
  });

  it("keeps a newly added blank manual row available for editing", () => {
    const rows = [
      row({ hours: "" }),
      row({
        id: "row-receipt",
        hours: "",
        rateMinor: DEFAULT_RATE_MINOR,
        comment: "Key Foods",
        receiptId: "receipt-1",
      }),
    ];

    const consolidated = consolidateInvoiceRows(rows, {
      defaultRateMinor: DEFAULT_RATE_MINOR,
      createRowId: () => "row-work",
    });

    expect(consolidated).toHaveLength(2);
    expect(consolidated.map(({ id }) => id)).toEqual(["row-manual", "row-receipt"]);
  });
});
