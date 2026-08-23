import { appErrorMessage } from "../../shared/app-error";
import type { InvoiceDocument, InvoiceRow, InvoiceSummary } from "../../shared/types";
import {
  calculateInvoiceTotals,
  calculateRowLabourMinor,
  formatMinorUnits,
  parseMoneyToMinor,
} from "../../shared/finance";

const currencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

const shortDateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "2-digit",
  day: "2-digit",
  timeZone: "UTC",
});

const longDateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

export function formatMoney(minor: number | null | undefined): string {
  return minor == null ? "" : currencyFormatter.format(minor / 100);
}

export function formatShortDate(value: string | null | undefined): string {
  if (!value) return "";
  const date = parseIsoDate(value);
  return date ? shortDateFormatter.format(date) : value;
}

export function formatLongDate(value: string | null | undefined): string {
  if (!value) return "";
  const date = parseIsoDate(value);
  return date ? longDateFormatter.format(date) : value;
}

export function formatPeriod(startDate: string, endDate: string): string {
  return `${formatLongDate(startDate)} – ${formatLongDate(endDate)}`;
}

function parseIsoDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value ? date : null;
}

export function parseMoneyInput(value: string): number | null {
  const normalized = value.trim().replaceAll(",", "").replace(/^\$/, "");
  try {
    return parseMoneyToMinor(normalized);
  } catch {
    return null;
  }
}

export function minorToInput(minor: number | null | undefined): string {
  if (minor == null) return "";
  return formatMinorUnits(minor);
}

export function labourMinor(row: InvoiceRow): number {
  try {
    return calculateRowLabourMinor(row);
  } catch {
    return 0;
  }
}

export interface CalculatedTotals {
  groceriesMinor: number;
  hours: string;
  labourMinor: number;
  invoiceMinor: number;
}

export function calculateTotals(rows: readonly InvoiceRow[]): CalculatedTotals {
  try {
    return calculateInvoiceTotals(rows);
  } catch {
    return {
      groceriesMinor: rows.reduce((sum, row) => sum + (row.groceriesMinor ?? 0), 0),
      hours: "0.00",
      labourMinor: rows.reduce((sum, row) => sum + labourMinor(row), 0),
      invoiceMinor: rows.reduce(
        (sum, row) => sum + (row.groceriesMinor ?? 0) + labourMinor(row),
        0
      ),
    };
  }
}

export function formatHours(hours: string): string {
  return hours;
}

export function invoiceToSummary(invoice: InvoiceDocument): InvoiceSummary {
  return {
    id: invoice.id,
    name: invoice.name,
    period: invoice.period,
    rowCount: invoice.rows.length,
    receiptCount: invoice.receipts.length,
    updatedAt: invoice.updatedAt,
  };
}

export function newRowId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `row-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function messageFromError(error: unknown): string {
  return error instanceof Error ? appErrorMessage(error) : "Something went wrong.";
}

export function todayIso(): string {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}
