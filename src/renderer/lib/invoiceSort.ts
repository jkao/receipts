import type { SortColumn } from "react-data-grid";
import { calculateRowLabourMinor, normalizeHours } from "../../shared/finance";
import type { InvoiceRow } from "../../shared/types";

export const DEFAULT_INVOICE_SORT: readonly SortColumn[] = Object.freeze([
  Object.freeze({ columnKey: "date", direction: "ASC" as const }),
]);

const SORTABLE_COLUMNS = new Set([
  "date",
  "groceriesMinor",
  "hours",
  "rateMinor",
  "labourTotal",
  "comment",
]);

const commentCollator = new Intl.Collator("en-US", {
  numeric: true,
  sensitivity: "base",
});

type SortValue = number | string | null;

/**
 * The grid supports Ctrl-click multi-sort, but the invoice deliberately keeps
 * one clear, persisted order. An empty sort always returns to chronological
 * Date order; if several columns arrive, the most recently added one wins.
 */
export function normalizeInvoiceSort(requested: readonly SortColumn[]): SortColumn[] {
  const selected = [...requested]
    .reverse()
    .find((column) => SORTABLE_COLUMNS.has(column.columnKey));
  return selected
    ? [{ columnKey: selected.columnKey, direction: selected.direction }]
    : DEFAULT_INVOICE_SORT.map((column) => ({ ...column }));
}

/** Stable invoice-row sorting with blank cells last in either direction. */
export function sortInvoiceRows(
  rows: readonly InvoiceRow[],
  requestedSort: readonly SortColumn[]
): InvoiceRow[] {
  const [{ columnKey, direction }] = normalizeInvoiceSort(requestedSort);

  return rows
    .map((row, index) => ({ row, index }))
    .sort((left, right) => {
      const leftValue = valueForColumn(left.row, columnKey);
      const rightValue = valueForColumn(right.row, columnKey);

      if (leftValue === null && rightValue === null) {
        return left.index - right.index;
      }
      if (leftValue === null) return 1;
      if (rightValue === null) return -1;

      const comparison = compareValues(leftValue, rightValue, columnKey);
      return comparison === 0
        ? left.index - right.index
        : direction === "ASC"
          ? comparison
          : -comparison;
    })
    .map(({ row }) => row);
}

export function rowsHaveSameOrder(
  left: readonly InvoiceRow[],
  right: readonly InvoiceRow[]
): boolean {
  return left.length === right.length && left.every((row, index) => row.id === right[index]?.id);
}

/**
 * Fast path for grid edits: only re-run the O(n log n) sort when row identity
 * or the value used by the active sort actually changed.
 */
export function rowsNeedResort(
  previous: readonly InvoiceRow[],
  next: readonly InvoiceRow[],
  requestedSort: readonly SortColumn[]
): boolean {
  if (previous.length !== next.length) return true;
  const [{ columnKey }] = normalizeInvoiceSort(requestedSort);
  return previous.some((row, index) => {
    const nextRow = next[index];
    return (
      !nextRow ||
      row.id !== nextRow.id ||
      !Object.is(valueForColumn(row, columnKey), valueForColumn(nextRow, columnKey))
    );
  });
}

function valueForColumn(row: InvoiceRow, columnKey: string): SortValue {
  switch (columnKey) {
    case "date":
      return row.date;
    case "groceriesMinor":
      return row.groceriesMinor;
    case "hours": {
      try {
        const hours = normalizeHours(row.hours);
        return hours === "" ? null : hours;
      } catch {
        return null;
      }
    }
    case "rateMinor":
      return row.hours.trim() === "" ? null : row.rateMinor;
    case "labourTotal":
      try {
        return calculateRowLabourMinor(row);
      } catch {
        return null;
      }
    case "comment": {
      const comment = row.comment.trim();
      return comment === "" ? null : comment;
    }
    default:
      return null;
  }
}

function compareValues(left: number | string, right: number | string, columnKey: string): number {
  if (typeof left === "number" && typeof right === "number") {
    return left - right;
  }
  if (columnKey === "hours") {
    return compareExactDecimals(String(left), String(right));
  }
  if (columnKey === "comment") {
    return commentCollator.compare(String(left), String(right));
  }
  return String(left).localeCompare(String(right));
}

function compareExactDecimals(left: string, right: string): number {
  const leftNegative = left.startsWith("-");
  const rightNegative = right.startsWith("-");
  if (leftNegative !== rightNegative) return leftNegative ? -1 : 1;

  const leftUnsigned = left.replace(/^[+-]/, "");
  const rightUnsigned = right.replace(/^[+-]/, "");
  const [leftWhole = "0", leftFraction = ""] = leftUnsigned.split(".");
  const [rightWhole = "0", rightFraction = ""] = rightUnsigned.split(".");
  const normalizedLeftWhole = leftWhole.replace(/^0+(?=\d)/, "");
  const normalizedRightWhole = rightWhole.replace(/^0+(?=\d)/, "");

  let magnitude = normalizedLeftWhole.length - normalizedRightWhole.length;
  if (magnitude === 0) {
    magnitude = normalizedLeftWhole.localeCompare(normalizedRightWhole);
  }
  if (magnitude === 0) {
    const fractionLength = Math.max(leftFraction.length, rightFraction.length);
    magnitude = leftFraction
      .padEnd(fractionLength, "0")
      .localeCompare(rightFraction.padEnd(fractionLength, "0"));
  }
  return leftNegative ? -magnitude : magnitude;
}
