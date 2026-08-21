import { describe, expect, it } from "vitest";
import { buildInvoiceSummaryRows } from "./invoiceSummary";

describe("invoice grid summary rows", () => {
  it("keeps component totals separate from the combined grand total", () => {
    const totals = {
      groceriesMinor: 10_073,
      hours: "4.50",
      labourMinor: 20_250,
      invoiceMinor: 30_323,
    };

    expect(buildInvoiceSummaryRows(totals)).toEqual([
      { kind: "components", ...totals },
      { kind: "grand", ...totals },
    ]);
  });
});
