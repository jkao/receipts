import { describe, expect, it } from "vitest";

import {
  calculateInvoiceTotals,
  calculateLabourMinor,
  formatMinorUnits,
  normalizeHours,
  parseMoneyToMinor,
} from "./finance";
import type { InvoiceRow } from "./types";

function row(overrides: Partial<InvoiceRow> = {}): InvoiceRow {
  return {
    id: "row-1",
    date: "2026-05-12",
    groceriesMinor: null,
    hours: "",
    rateMinor: null,
    comment: "",
    receiptId: null,
    ...overrides,
  };
}

describe("money parsing and formatting", () => {
  it("parses decimal money directly into integer cents", () => {
    expect(parseMoneyToMinor("10.73")).toBe(1073);
    expect(parseMoneyToMinor("-1.2")).toBe(-120);
    expect(parseMoneyToMinor("+.05")).toBe(5);
    expect(parseMoneyToMinor("1.2300")).toBe(123);
    expect(parseMoneyToMinor(" ")).toBeNull();
    expect(parseMoneyToMinor(null)).toBeNull();
  });

  it("rejects ambiguous or sub-cent values instead of rounding money", () => {
    expect(() => parseMoneyToMinor("1,000.00")).toThrow();
    expect(() => parseMoneyToMinor("1.001")).toThrow(/fractions of a cent/);
    expect(() => parseMoneyToMinor("$1.00")).toThrow();
  });

  it("formats signed integer cents without floating point", () => {
    expect(formatMinorUnits(0)).toBe("0.00");
    expect(formatMinorUnits(5)).toBe("0.05");
    expect(formatMinorUnits(-105)).toBe("-1.05");
    expect(() => formatMinorUnits(1.5)).toThrow(/safe integer/);
  });
});

describe("hours and labour", () => {
  it("normalizes hours while retaining precision beyond two places", () => {
    expect(normalizeHours("")).toBe("");
    expect(normalizeHours("4.5000")).toBe("4.50");
    expect(normalizeHours(".125")).toBe("0.125");
    expect(normalizeHours("-0")).toBe("0.00");
  });

  it("multiplies exact decimal hours by cents and rounds half away from zero", () => {
    expect(calculateLabourMinor("4.50", 4500)).toBe(20_250);
    expect(calculateLabourMinor("0.001", 4500)).toBe(5);
    expect(calculateLabourMinor("-0.001", 4500)).toBe(-5);
    expect(calculateLabourMinor("", 4500)).toBe(0);
    expect(calculateLabourMinor("1.00", null)).toBe(0);
  });

  it("sums hours and all invoice totals without decimal drift", () => {
    const totals = calculateInvoiceTotals([
      row({ id: "a", groceriesMinor: 1073, hours: "0.10", rateMinor: 4500 }),
      row({ id: "b", groceriesMinor: 799, hours: "0.20", rateMinor: 4500 }),
      row({ id: "c", groceriesMinor: null, hours: "0.005", rateMinor: 100 }),
    ]);

    expect(totals).toEqual({
      groceriesMinor: 1872,
      hours: "0.305",
      labourMinor: 1351,
      invoiceMinor: 3223,
    });
  });

  it("reports zero totals with spreadsheet-friendly precision", () => {
    expect(calculateInvoiceTotals([])).toEqual({
      groceriesMinor: 0,
      hours: "0.00",
      labourMinor: 0,
      invoiceMinor: 0,
    });
  });

  it("sums large row collections without spreading them onto the call stack", () => {
    const rows = Array.from({ length: 150_000 }, (_, index) =>
      row({ id: `row-${index}`, hours: "0.01", rateMinor: null })
    );

    expect(calculateInvoiceTotals(rows).hours).toBe("1500.00");
  });
});
