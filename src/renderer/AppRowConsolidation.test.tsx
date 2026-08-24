// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopApi, InvoiceDocument, InvoiceRow } from "../shared/types";

vi.mock("./components/InvoiceGrid", () => ({
  InvoiceGrid: ({
    rows,
    onRowsChange,
  }: {
    rows: InvoiceRow[];
    onRowsChange: (rows: InvoiceRow[]) => void;
  }) => (
    <div>
      <button
        type="button"
        onClick={() =>
          onRowsChange(
            rows.map((row) => (row.id === "row-work" ? { ...row, date: "2026-08-12" } : row))
          )
        }
      >
        Match work date
      </button>
      <output data-testid="row-state">{JSON.stringify(rows)}</output>
    </div>
  ),
}));

vi.mock("./lib/scheduleIdleTask", () => ({
  scheduleIdleTask: () => () => undefined,
}));

import App from "./App";

const initialInvoice: InvoiceDocument = {
  schemaVersion: 1,
  id: "invoice-id",
  name: "invoice-2026-08-01-2026-08-31",
  period: { startDate: "2026-08-01", endDate: "2026-08-31" },
  defaultRateMinor: 4_500,
  currency: "USD",
  revision: 3,
  rows: [
    {
      id: "row-receipt",
      date: "2026-08-12",
      groceriesMinor: 1_250,
      hours: "",
      rateMinor: 4_500,
      comment: "Whole Foods",
      receiptId: "receipt-1",
    },
    {
      id: "row-work",
      date: "2026-08-13",
      groceriesMinor: null,
      hours: "2.5",
      rateMinor: 5_500,
      comment: "",
      receiptId: null,
    },
  ],
  receipts: [
    {
      id: "receipt-1",
      relativePath: "receipts/2026-08-12-whole-foods-001.jpg",
      debugPath: "debug/receipt-1.json",
      originalFilename: "whole-foods.jpg",
      mimeType: "image/jpeg",
      sha256: "a".repeat(64),
      source: { kind: "manual", method: "drag-drop" },
      status: "ready",
      importedAt: "2026-08-12T12:00:00.000Z",
    },
  ],
  reviewAcknowledgements: [],
  createdAt: "2026-08-01T12:00:00.000Z",
  updatedAt: "2026-08-23T12:00:00.000Z",
};

afterEach(cleanup);

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
  const api = {
    getSettings: vi.fn().mockResolvedValue({
      baseFolder: "/Invoices",
      hasOpenAiKey: true,
      defaultRateMinor: 4_500,
    }),
    listInvoices: vi.fn().mockResolvedValue([
      {
        id: initialInvoice.id,
        name: initialInvoice.name,
        period: initialInvoice.period,
        rowCount: initialInvoice.rows.length,
        receiptCount: initialInvoice.receipts.length,
        updatedAt: initialInvoice.updatedAt,
      },
    ]),
    loadInvoice: vi.fn().mockResolvedValue(initialInvoice),
    saveRows: vi.fn().mockImplementation(async (_invoiceId, rows: InvoiceRow[], revision) => ({
      ...initialInvoice,
      rows,
      revision: revision + 1,
    })),
    onImportProgress: vi.fn(() => () => undefined),
  } as unknown as DesktopApi;
  Object.defineProperty(window, "receiptApp", {
    configurable: true,
    value: api,
  });
});

describe("invoice row consolidation", () => {
  it("merges a work row after its edited date matches the sole receipt date", async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Match work date" }));

    await waitFor(() => {
      const rows = JSON.parse(screen.getByTestId("row-state").textContent ?? "[]");
      expect(rows).toEqual([
        expect.objectContaining({
          id: "row-receipt",
          date: "2026-08-12",
          groceriesMinor: 1_250,
          hours: "2.5",
          rateMinor: 5_500,
          comment: "Whole Foods",
          receiptId: "receipt-1",
        }),
      ]);
    });
  });
});
