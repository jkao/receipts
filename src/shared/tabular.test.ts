import { describe, expect, it } from "vitest";

import {
  INVOICE_EXPORT_HEADERS,
  invoiceToCells,
  invoiceToCsv,
  invoiceToTsv,
  sanitizeSpreadsheetComment,
} from "./tabular";
import { INVOICE_SCHEMA_VERSION, type InvoiceDocument, type InvoiceRow } from "./types";

function row(overrides: Partial<InvoiceRow> = {}): InvoiceRow {
  return {
    id: "row-1",
    date: "2026-05-12",
    groceriesMinor: 1073,
    hours: "4.50",
    rateMinor: 4500,
    comment: "Key Foods",
    receiptId: null,
    ...overrides,
  };
}

function invoice(rows: InvoiceRow[]): InvoiceDocument {
  return {
    schemaVersion: INVOICE_SCHEMA_VERSION,
    id: "inv-1",
    name: "invoice-2026-05-01-2026-05-31",
    period: { startDate: "2026-05-01", endDate: "2026-05-31" },
    defaultRateMinor: 4500,
    currency: "USD",
    revision: 0,
    rows,
    receipts: [],
    reviewAcknowledgements: [],
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
  };
}

describe("spreadsheet comment safety", () => {
  it.each(["=1+1", "+cmd", "-SUM(A1:A2)", "@IMPORT", "  =hidden"])(
    "prefixes a potentially executable comment: %s",
    (comment) => {
      expect(sanitizeSpreadsheetComment(comment).startsWith("'")).toBe(true);
    }
  );

  it("flattens tabs and line breaks but preserves ordinary merchant text", () => {
    expect(sanitizeSpreadsheetComment("Whole\tFoods\r\nMarket")).toBe("Whole Foods Market");
    expect(sanitizeSpreadsheetComment("Key Foods")).toBe("Key Foods");
  });
});

describe("invoice tabular exports", () => {
  it("produces exactly six columns with optional headers and totals", () => {
    const document = invoice([
      row(),
      row({
        id: "row-2",
        date: "2026-05-13",
        groceriesMinor: null,
        hours: "",
        rateMinor: 4500,
        comment: "  =not-a-formula",
      }),
    ]);

    const cells = invoiceToCells(document, {
      includeHeaders: true,
      includeTotals: true,
    });

    expect(cells[0]).toEqual([...INVOICE_EXPORT_HEADERS]);
    expect(cells).toEqual([
      ["Date", "Groceries MP", "Hours Worked", "Rate", "Labour Total", "Comment"],
      ["05/12", "10.73", "4.50", "45.00", "202.50", "Key Foods"],
      ["05/13", "", "", "", "0.00", "'  =not-a-formula"],
      ["Total", "10.73", "4.50", "", "202.50", ""],
      ["Grand Total", "", "", "", "213.23", "Groceries + Labour"],
    ]);
    expect(cells.every((tableRow) => tableRow.length === 6)).toBe(true);
  });

  it("omits the default rate on a receipt-only row with no hours", () => {
    const [cells] = invoiceToCells(
      invoice([
        row({
          groceriesMinor: 2500,
          hours: "",
          rateMinor: 4500,
          comment: "Receipt only",
        }),
      ])
    );

    expect(cells).toEqual(["05/12", "25.00", "", "", "0.00", "Receipt only"]);
  });

  it("supports full-year dates and selected rows while retaining invoice order", () => {
    const document = invoice([
      row({ id: "first", groceriesMinor: 100 }),
      row({ id: "second", date: "2026-05-13", groceriesMinor: 200 }),
      row({ id: "third", date: null, groceriesMinor: 300 }),
    ]);

    const cells = invoiceToCells(document, {
      rowIds: ["third", "first"],
      fullYearDates: true,
      includeTotals: true,
    });

    expect(cells.map((cellsRow) => cellsRow[0])).toEqual([
      "05/12/2026",
      "",
      "Total",
      "Grand Total",
    ]);
    expect(cells.at(-2)?.[1]).toBe("4.00");
    expect(cells.at(-1)).toEqual(["Grand Total", "", "", "", "409.00", "Groceries + Labour"]);
  });

  it("writes both component totals and the combined grand total to TSV and CSV", () => {
    const document = invoice([row()]);

    expect(invoiceToTsv(document, { includeTotals: true })).toContain(
      "Total\t10.73\t4.50\t\t202.50\t\n" + "Grand Total\t\t\t\t213.23\tGroceries + Labour\n"
    );
    expect(invoiceToCsv(document, { includeTotals: true })).toContain(
      "Total,10.73,4.50,,202.50,\n" + "Grand Total,,,,213.23,Groceries + Labour\n"
    );
  });

  it("preserves the persisted row order in TSV and CSV without sorting by date", () => {
    const document = invoice([
      row({
        id: "persisted-first",
        date: "2026-05-20",
        comment: "Persisted first",
      }),
      row({
        id: "persisted-second",
        date: "2026-05-01",
        comment: "Persisted second",
      }),
      row({
        id: "persisted-third",
        date: null,
        comment: "Persisted third",
      }),
    ]);

    const tsvComments = invoiceToTsv(document)
      .trimEnd()
      .split("\n")
      .map((line) => line.split("\t").at(-1));
    const csvComments = invoiceToCsv(document)
      .trimEnd()
      .split("\n")
      .map((line) => line.split(",").at(-1));

    expect(tsvComments).toEqual(["Persisted first", "Persisted second", "Persisted third"]);
    expect(csvComments).toEqual(tsvComments);
  });

  it("writes copy-ready TSV with a terminal newline", () => {
    const tsv = invoiceToTsv(invoice([row()]), { includeHeaders: true });
    const lines = tsv.trimEnd().split("\n");
    expect(tsv.endsWith("\n")).toBe(true);
    expect(lines).toHaveLength(2);
    expect(lines.every((line) => line.split("\t").length === 6)).toBe(true);
    expect(lines[1]).toBe("05/12\t10.73\t4.50\t45.00\t202.50\tKey Foods");
  });

  it("quotes CSV punctuation and keeps malicious text inert", () => {
    const csv = invoiceToCsv(
      invoice([
        row({
          comment: '=HYPERLINK("https://bad.example","merchant, name")\nnext',
        }),
      ])
    );

    expect(csv).toBe(
      '05/12,10.73,4.50,45.00,202.50,"\'=HYPERLINK(""https://bad.example"",""merchant, name"") next"\n'
    );
    expect(csv.trimEnd().split(",")).toHaveLength(8); // Quoted commas remain data.
  });
});
