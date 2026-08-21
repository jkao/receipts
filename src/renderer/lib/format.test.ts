import { afterEach, describe, expect, it, vi } from "vitest";
import type { InvoiceDocument, InvoiceRow } from "../../shared/types";
import {
  calculateTotals,
  formatLongDate,
  formatMoney,
  formatPeriod,
  formatShortDate,
  invoiceToSummary,
  labourMinor,
  messageFromError,
  minorToInput,
  newRowId,
  parseMoneyInput,
  todayIso,
} from "./format";

function row(overrides: Partial<InvoiceRow> = {}): InvoiceRow {
  return {
    id: "row-1",
    date: "2026-08-21",
    groceriesMinor: 1_099,
    hours: "1.25",
    rateMinor: 4_500,
    comment: "Market",
    receiptId: null,
    ...overrides,
  };
}

describe("renderer formatting", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("formats money and exact editable minor-unit values", () => {
    expect(formatMoney(1_099)).toBe("$10.99");
    expect(formatMoney(-125)).toBe("-$1.25");
    expect(formatMoney(null)).toBe("");
    expect(minorToInput(900_719_925_474_099)).toBe("9007199254740.99");
    expect(minorToInput(undefined)).toBe("");
  });

  it("parses user-entered money without accepting invalid or fractional-cent input", () => {
    expect(parseMoneyInput(" $1,234.50 ")).toBe(123_450);
    expect(parseMoneyInput("")).toBeNull();
    expect(parseMoneyInput("1.001")).toBeNull();
    expect(parseMoneyInput("not money")).toBeNull();
  });

  it("formats valid ISO dates but leaves malformed and impossible dates visible", () => {
    expect(formatShortDate("2026-08-21")).toBe("08/21");
    expect(formatLongDate("2026-08-21")).toBe("Aug 21, 2026");
    expect(formatPeriod("2026-08-01", "2026-08-31")).toBe("Aug 1, 2026 – Aug 31, 2026");
    expect(formatLongDate("2026-02-31")).toBe("2026-02-31");
    expect(formatShortDate("bad-date")).toBe("bad-date");
    expect(formatShortDate(null)).toBe("");
  });

  it("calculates exact row and invoice totals", () => {
    const rows = [
      row(),
      row({ id: "row-2", groceriesMinor: 401, hours: "0.50", rateMinor: 4_500 }),
    ];

    expect(labourMinor(rows[0])).toBe(5_625);
    expect(calculateTotals(rows)).toEqual({
      groceriesMinor: 1_500,
      hours: "1.75",
      labourMinor: 7_875,
      invoiceMinor: 9_375,
    });
  });

  it("keeps the UI usable when a partially edited row is not yet a valid decimal", () => {
    const invalid = row({ hours: "-", groceriesMinor: 250 });
    expect(labourMinor(invalid)).toBe(0);
    expect(calculateTotals([invalid])).toEqual({
      groceriesMinor: 250,
      hours: "0.00",
      labourMinor: 0,
      invoiceMinor: 250,
    });
  });

  it("derives summaries without carrying the full invoice payload", () => {
    const invoice: InvoiceDocument = {
      schemaVersion: 1,
      id: "invoice-1",
      name: "invoice-2026-08-01-2026-08-31",
      period: { startDate: "2026-08-01", endDate: "2026-08-31" },
      defaultRateMinor: 4_500,
      currency: "USD",
      revision: 4,
      rows: [row()],
      receipts: [],
      reviewAcknowledgements: [],
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-21T00:00:00.000Z",
    };

    expect(invoiceToSummary(invoice)).toEqual({
      id: invoice.id,
      name: invoice.name,
      period: invoice.period,
      rowCount: 1,
      receiptCount: 0,
      updatedAt: invoice.updatedAt,
    });
  });

  it("uses useful error messages and creates row identifiers", () => {
    expect(messageFromError(new Error("Disk is unavailable"))).toBe("Disk is unavailable");
    expect(messageFromError("bad")).toBe("Something went wrong.");
    expect(newRowId()).toMatch(/^(?:[0-9a-f-]{36}|row-)/i);
  });

  it("returns today's local calendar date", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-21T15:30:00.000Z"));
    vi.spyOn(Date.prototype, "getTimezoneOffset").mockReturnValue(0);
    expect(todayIso()).toBe("2026-08-21");
  });
});
