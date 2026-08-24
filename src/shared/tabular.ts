import {
  calculateInvoiceTotals,
  calculateRowLabourMinor,
  formatMinorUnits,
  normalizeHours,
} from "./finance";
import type { InvoiceDocument, InvoiceRow } from "./types";

export const INVOICE_EXPORT_HEADERS = [
  "Date",
  "Groceries MP",
  "Hours Worked",
  "Rate",
  "Labour Total",
  "Comment",
] as const;

export const INVOICE_PAYMENT_NOTE =
  "Please pay groceries and labour separately. Grand total is for reference only.";

export interface InvoiceTabularOptions {
  rowIds?: string[] | null;
  includeHeaders?: boolean;
  includeTotals?: boolean;
  fullYearDates?: boolean;
}

function formatDate(value: string | null, fullYear: boolean): string {
  if (value === null || value === "") {
    return "";
  }

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    throw new TypeError(`Invalid ISO invoice date: ${value}`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new TypeError(`Invalid ISO invoice date: ${value}`);
  }
  const [, year, month, day] = match;
  return fullYear ? `${month}/${day}/${year}` : `${month}/${day}`;
}

/**
 * Receipt/merchant text is untrusted. Flatten delimiters and guard the first
 * non-whitespace character so Sheets/Excel cannot interpret it as a formula.
 */
export function sanitizeSpreadsheetComment(value: string): string {
  const flattened = value.replace(/[\t\r\n]+/g, " ");
  return /^\s*[=+\-@]/.test(flattened) ? `'${flattened}` : flattened;
}

function rowToCells(row: InvoiceRow, fullYearDates: boolean): string[] {
  const hours = normalizeHours(row.hours);
  return [
    formatDate(row.date, fullYearDates),
    row.groceriesMinor === null ? "" : formatMinorUnits(row.groceriesMinor),
    hours,
    hours === "" || row.rateMinor === null ? "" : formatMinorUnits(row.rateMinor),
    formatMinorUnits(calculateRowLabourMinor(row)),
    sanitizeSpreadsheetComment(row.comment),
  ];
}

function totalRowsToCells(rows: readonly InvoiceRow[]): string[][] {
  const totals = calculateInvoiceTotals(rows);
  return [
    [
      "Total",
      formatMinorUnits(totals.groceriesMinor),
      totals.hours,
      "",
      formatMinorUnits(totals.labourMinor),
      "",
    ],
    ["Grand Total", "", "", "", formatMinorUnits(totals.invoiceMinor), INVOICE_PAYMENT_NOTE],
  ];
}

function selectedRows(invoice: InvoiceDocument, rowIds: string[] | null | undefined): InvoiceRow[] {
  if (rowIds === undefined || rowIds === null) {
    return invoice.rows;
  }
  const selected = new Set(rowIds);
  return invoice.rows.filter((row) => selected.has(row.id));
}

export function invoiceToCells(
  invoice: InvoiceDocument,
  options: InvoiceTabularOptions = {}
): string[][] {
  const rows = selectedRows(invoice, options.rowIds);
  const cells: string[][] = [];

  if (options.includeHeaders) {
    cells.push([...INVOICE_EXPORT_HEADERS]);
  }
  cells.push(...rows.map((row) => rowToCells(row, options.fullYearDates ?? false)));
  if (options.includeTotals) {
    cells.push(...totalRowsToCells(rows));
  }

  return cells;
}

function withTerminalNewline(lines: string[]): string {
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

export function invoiceToTsv(
  invoice: InvoiceDocument,
  options: InvoiceTabularOptions = {}
): string {
  const lines = invoiceToCells(invoice, options).map((row) => row.join("\t"));
  return withTerminalNewline(lines);
}

function escapeCsvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function invoiceToCsv(
  invoice: InvoiceDocument,
  options: InvoiceTabularOptions = {}
): string {
  const lines = invoiceToCells(invoice, options).map((row) => row.map(escapeCsvCell).join(","));
  return withTerminalNewline(lines);
}
