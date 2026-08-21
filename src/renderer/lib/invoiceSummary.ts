import type { InvoiceTotals } from "../../shared/types";

export interface InvoiceSummaryRow {
  kind: "components" | "grand";
  groceriesMinor: number;
  hours: string;
  labourMinor: number;
  invoiceMinor: number;
}

export function buildInvoiceSummaryRows(totals: InvoiceTotals): InvoiceSummaryRow[] {
  return [
    { kind: "components", ...totals },
    { kind: "grand", ...totals },
  ];
}
