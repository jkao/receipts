import {
  consolidateInvoiceRows,
  type InvoiceRowConsolidationOptions,
} from "../shared/invoice-row-consolidation";
import type { InvoiceRow } from "../shared/types";

export interface ScannedReceiptRowValues {
  date: string | null;
  groceriesMinor: number | null;
  merchant: string | null;
}

/**
 * Apply extraction results and collapse the common one-receipt/one-work-row
 * shape without discarding user-authored invoice data.
 *
 * A merge is deliberately conservative: the same-date manual row must have no
 * groceries or comment of its own, and the receipt row must not already carry
 * work. If another receipt later lands on the same date, the work values from
 * the earlier automatic merge are split back into one manual row. This leaves
 * N receipt rows plus one work row for dates with multiple receipts.
 */
export function applyScannedReceiptToRows(
  rows: InvoiceRow[],
  receiptId: string,
  values: ScannedReceiptRowValues,
  options: InvoiceRowConsolidationOptions
): void {
  const receiptRow = rows.find((row) => row.receiptId === receiptId);
  if (!receiptRow) return;

  receiptRow.date = values.date;
  receiptRow.groceriesMinor = values.groceriesMinor;
  receiptRow.comment = values.merchant?.trim() || receiptRow.comment;

  if (receiptRow.date === null) return;
  rows.splice(0, rows.length, ...consolidateInvoiceRows(rows, options));
}
