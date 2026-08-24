import type { InvoiceRow } from "./types";

export interface InvoiceRowConsolidationOptions {
  defaultRateMinor: number;
  createRowId: () => string;
}

/**
 * Return a consolidated copy of invoice rows. Inputs and their row objects are
 * never mutated, so callers can safely use the result for React state.
 *
 * A one-receipt date absorbs its sole compatible manual/work row. A date with
 * multiple receipts reverses an earlier automatic merge into N receipt rows
 * plus one work row. Ambiguous or lossy combinations are left untouched.
 */
export function consolidateInvoiceRows(
  rows: readonly InvoiceRow[],
  options: InvoiceRowConsolidationOptions
): InvoiceRow[] {
  const consolidated = rows.map((row) => ({ ...row }));
  const dates = new Set(
    consolidated.map((row) => row.date).filter((date): date is string => date !== null)
  );
  for (const date of dates) consolidateRowsForDate(consolidated, date, options);
  return consolidated;
}

function consolidateRowsForDate(
  rows: InvoiceRow[],
  date: string,
  { defaultRateMinor, createRowId }: InvoiceRowConsolidationOptions
): void {
  const datedRows = rows.filter((row) => row.date === date);
  const receiptRows = datedRows.filter((row) => row.receiptId !== null);
  const manualRows = datedRows.filter((row) => row.receiptId === null);

  if (receiptRows.length === 1 && manualRows.length === 1) {
    const receiptRow = receiptRows[0];
    const manualRow = manualRows[0];
    const canMergeWithoutDataLoss =
      receiptRow.hours.trim() === "" &&
      receiptRow.rateMinor === defaultRateMinor &&
      manualRow.hours.trim() !== "" &&
      manualRow.groceriesMinor === null &&
      manualRow.comment.trim() === "";
    if (!canMergeWithoutDataLoss) return;

    receiptRow.hours = manualRow.hours;
    receiptRow.rateMinor = manualRow.rateMinor;
    rows.splice(rows.indexOf(manualRow), 1);
    return;
  }

  if (receiptRows.length <= 1 || manualRows.length > 0) return;

  // With no schema-level merge marker, a sole receipt carrying work is the
  // reversible signature of the one-receipt merge above. Do not guess when
  // more than one receipt row carries work.
  const receiptRowsWithWork = receiptRows.filter((row) => row.hours.trim() !== "");
  if (receiptRowsWithWork.length !== 1) return;

  const mergedRow = receiptRowsWithWork[0];
  const workRow: InvoiceRow = {
    id: createUniqueRowId(rows, createRowId),
    date,
    groceriesMinor: null,
    hours: mergedRow.hours,
    rateMinor: mergedRow.rateMinor,
    comment: "",
    receiptId: null,
  };
  mergedRow.hours = "";
  mergedRow.rateMinor = defaultRateMinor;
  rows.splice(rows.indexOf(mergedRow), 0, workRow);
}

function createUniqueRowId(rows: readonly InvoiceRow[], createRowId: () => string): string {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = createRowId();
    if (!rows.some((row) => row.id === candidate)) return candidate;
  }
  throw new Error("Could not create a unique invoice row ID");
}
