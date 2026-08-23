import { describe, expect, it } from "vitest";
import type { InvoiceRow } from "../../shared/types";
import {
  DEFAULT_INVOICE_SORT,
  normalizeInvoiceSort,
  rowsHaveSameOrder,
  rowsNeedResort,
  sortInvoiceRows,
} from "./invoiceSort";

function row(id: string, overrides: Partial<InvoiceRow> = {}): InvoiceRow {
  return {
    id,
    date: "2026-06-15",
    groceriesMinor: null,
    hours: "",
    rateMinor: 4_500,
    comment: id,
    receiptId: null,
    ...overrides,
  };
}

describe("invoice row sorting", () => {
  it("defaults to stable chronological order with missing dates last", () => {
    const rows = [
      row("later", { date: "2026-06-20" }),
      row("same-a", { date: "2026-06-10" }),
      row("missing", { date: null }),
      row("same-b", { date: "2026-06-10" }),
      row("earlier", { date: "2026-06-01" }),
    ];

    expect(sortInvoiceRows(rows, DEFAULT_INVOICE_SORT).map(({ id }) => id)).toEqual([
      "earlier",
      "same-a",
      "same-b",
      "later",
      "missing",
    ]);
  });

  it("keeps blanks last when descending and treats zero as a value", () => {
    const rows = [
      row("blank"),
      row("zero", { groceriesMinor: 0 }),
      row("large", { groceriesMinor: 2_500 }),
      row("small", { groceriesMinor: 100 }),
    ];

    expect(
      sortInvoiceRows(rows, [{ columnKey: "groceriesMinor", direction: "DESC" }]).map(
        ({ id }) => id
      )
    ).toEqual(["large", "small", "zero", "blank"]);
  });

  it("sorts hours, displayed rates, computed labour, and comments", () => {
    const rows = [
      row("receipt", { hours: "   ", rateMinor: 9_900, comment: "" }),
      row("ten", { hours: "10", rateMinor: 2_000, comment: "Market 10" }),
      row("two", { hours: "2", rateMinor: 4_500, comment: "market 2" }),
      row("half", { hours: "0.5", rateMinor: 4_500, comment: "Alpha" }),
      row("huge", {
        hours: "9007199254740993",
        rateMinor: 1,
        comment: "Huge",
      }),
    ];

    expect(
      sortInvoiceRows(rows, [{ columnKey: "hours", direction: "ASC" }]).map(({ id }) => id)
    ).toEqual(["half", "two", "ten", "huge", "receipt"]);
    expect(
      sortInvoiceRows(rows, [{ columnKey: "rateMinor", direction: "DESC" }]).map(({ id }) => id)
    ).toEqual(["two", "half", "ten", "huge", "receipt"]);
    expect(
      sortInvoiceRows(
        rows.filter(({ id }) => id !== "huge"),
        [{ columnKey: "labourTotal", direction: "ASC" }]
      ).map(({ id }) => id)
    ).toEqual(["receipt", "half", "two", "ten"]);
    expect(
      sortInvoiceRows(rows, [{ columnKey: "comment", direction: "ASC" }]).map(({ id }) => id)
    ).toEqual(["half", "huge", "two", "ten", "receipt"]);
  });

  it("uses the latest valid requested column and restores Date ASC when cleared", () => {
    expect(normalizeInvoiceSort([])).toEqual([{ columnKey: "date", direction: "ASC" }]);
    expect(
      normalizeInvoiceSort([
        { columnKey: "date", direction: "DESC" },
        { columnKey: "comment", direction: "ASC" },
      ])
    ).toEqual([{ columnKey: "comment", direction: "ASC" }]);
    expect(normalizeInvoiceSort([{ columnKey: "not-a-column", direction: "DESC" }])).toEqual([
      { columnKey: "date", direction: "ASC" },
    ]);
  });

  it("detects whether a new sort actually changes persisted order", () => {
    const first = row("first");
    const second = row("second");
    expect(rowsHaveSameOrder([first, second], [first, second])).toBe(true);
    expect(rowsHaveSameOrder([first, second], [second, first])).toBe(false);
  });

  it("skips sorting when an edit does not affect the active sort value", () => {
    const original = [row("first", { date: "2026-06-01" }), row("second")];
    const commentEdit = [{ ...original[0], comment: "Updated" }, original[1]];
    const dateEdit = [{ ...original[0], date: "2026-06-30" }, original[1]];

    expect(rowsNeedResort(original, commentEdit, DEFAULT_INVOICE_SORT)).toBe(false);
    expect(rowsNeedResort(original, dateEdit, DEFAULT_INVOICE_SORT)).toBe(true);
    expect(rowsNeedResort(original, [...original, row("third")], DEFAULT_INVOICE_SORT)).toBe(true);
  });

  it("accounts for displayed and computed dependencies of the active sort", () => {
    const original = [row("first", { hours: "", rateMinor: 4_500 })];
    const rateOnly = [row("first", { hours: "", rateMinor: 9_000 })];
    const withHours = [row("first", { hours: "2", rateMinor: 4_500 })];

    expect(rowsNeedResort(original, rateOnly, [{ columnKey: "rateMinor", direction: "ASC" }])).toBe(
      false
    );
    expect(
      rowsNeedResort(original, withHours, [{ columnKey: "rateMinor", direction: "ASC" }])
    ).toBe(true);
    expect(
      rowsNeedResort(original, withHours, [{ columnKey: "labourTotal", direction: "ASC" }])
    ).toBe(true);
  });

  it("keeps temporarily invalid or overflowing edited numbers at the bottom", () => {
    const rows = [
      row("invalid", { hours: "not-yet-valid" }),
      row("ordinary", { hours: "2", rateMinor: 4_500 }),
      row("overflow", { hours: "9007199254740993", rateMinor: 4_500 }),
    ];

    expect(
      sortInvoiceRows(rows, [{ columnKey: "hours", direction: "ASC" }]).map(({ id }) => id)
    ).toEqual(["ordinary", "overflow", "invalid"]);
    expect(
      sortInvoiceRows(rows, [{ columnKey: "labourTotal", direction: "DESC" }]).map(({ id }) => id)
    ).toEqual(["ordinary", "invalid", "overflow"]);
  });

  it("places an out-of-order import and a committed date edit immediately", () => {
    const existing = [row("first", { date: "2026-06-10" }), row("second", { date: "2026-06-20" })];
    const afterImport = sortInvoiceRows(
      [...existing, row("imported", { date: "2026-06-01" })],
      DEFAULT_INVOICE_SORT
    );
    expect(afterImport.map(({ id }) => id)).toEqual(["imported", "first", "second"]);

    const afterEdit = sortInvoiceRows(
      afterImport.map((item) => (item.id === "second" ? { ...item, date: "2026-06-05" } : item)),
      DEFAULT_INVOICE_SORT
    );
    expect(afterEdit.map(({ id }) => id)).toEqual(["imported", "second", "first"]);
  });

  it("toggles date direction while keeping missing dates last", () => {
    const rows = [
      row("middle", { date: "2026-06-10" }),
      row("missing", { date: null }),
      row("last", { date: "2026-06-20" }),
    ];

    expect(
      sortInvoiceRows(rows, [{ columnKey: "date", direction: "ASC" }]).map(({ id }) => id)
    ).toEqual(["middle", "last", "missing"]);
    expect(
      sortInvoiceRows(rows, [{ columnKey: "date", direction: "DESC" }]).map(({ id }) => id)
    ).toEqual(["last", "middle", "missing"]);
  });

  it("compares exact signed hours beyond Number precision", () => {
    const rows = [
      row("positive-huge", { hours: "9007199254740993" }),
      row("negative-fraction", { hours: "-0.25" }),
      row("positive-fraction", { hours: "0.125" }),
      row("negative-huge", { hours: "-9007199254740993" }),
      row("zero", { hours: "0" }),
    ];

    expect(
      sortInvoiceRows(rows, [{ columnKey: "hours", direction: "ASC" }]).map(({ id }) => id)
    ).toEqual(["negative-huge", "negative-fraction", "zero", "positive-fraction", "positive-huge"]);
  });

  it("retains stable case-insensitive ties and blanks last when descending", () => {
    const rows = [
      row("tie-a", { comment: "Market 2" }),
      row("blank", { comment: "" }),
      row("ten", { comment: "market 10" }),
      row("tie-b", { comment: "market 2" }),
    ];

    expect(
      sortInvoiceRows(rows, [{ columnKey: "comment", direction: "DESC" }]).map(({ id }) => id)
    ).toEqual(["ten", "tie-a", "tie-b", "blank"]);
  });
});
