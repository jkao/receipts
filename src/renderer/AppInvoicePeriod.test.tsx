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
    <button
      type="button"
      onClick={() => onRowsChange(rows.map((row) => ({ ...row, comment: "Edited before dates" })))}
    >
      Stage row edit
    </button>
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
      id: "row-1",
      date: "2026-08-12",
      groceriesMinor: 1_250,
      hours: "",
      rateMinor: 4_500,
      comment: "Original",
      receiptId: null,
    },
  ],
  receipts: [],
  reviewAcknowledgements: [],
  createdAt: "2026-08-01T12:00:00.000Z",
  updatedAt: "2026-08-23T12:00:00.000Z",
};

function summary(invoice: InvoiceDocument) {
  return {
    id: invoice.id,
    name: invoice.name,
    period: invoice.period,
    rowCount: invoice.rows.length,
    receiptCount: invoice.receipts.length,
    updatedAt: invoice.updatedAt,
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
});

describe("invoice period editing", () => {
  it("updates the open invoice with the flushed revision and adopts the returned period", async () => {
    const savedInvoice: InvoiceDocument = {
      ...initialInvoice,
      revision: 4,
      rows: initialInvoice.rows.map((row) => ({ ...row, comment: "Edited before dates" })),
    };
    const updatedInvoice: InvoiceDocument = {
      ...savedInvoice,
      name: "invoice-2026-08-05-2026-09-05",
      period: { startDate: "2026-08-05", endDate: "2026-09-05" },
      revision: 5,
      updatedAt: "2026-08-23T13:00:00.000Z",
    };
    const updateInvoicePeriod = vi.fn().mockResolvedValue(updatedInvoice);
    const saveRows = vi.fn().mockResolvedValue(savedInvoice);
    const api = {
      getSettings: vi.fn().mockResolvedValue({
        baseFolder: "/Invoices",
        hasOpenAiKey: true,
        defaultRateMinor: 4_500,
      }),
      listInvoices: vi.fn().mockResolvedValue([summary(initialInvoice)]),
      loadInvoice: vi.fn().mockResolvedValue(initialInvoice),
      updateInvoicePeriod,
      saveRows,
      onImportProgress: vi.fn(() => () => undefined),
    } as unknown as DesktopApi;
    Object.defineProperty(window, "receiptApp", {
      configurable: true,
      value: api,
    });

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Stage row edit" }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit invoice dates" }));
    expect(screen.getByRole("dialog", { name: "Edit Invoice Dates" })).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Start date"), {
      target: { value: "2026-08-05" },
    });
    fireEvent.change(screen.getByLabelText("End date"), {
      target: { value: "2026-09-05" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save Dates" }));

    await waitFor(() => {
      expect(saveRows).toHaveBeenCalledWith("invoice-id", savedInvoice.rows, 3);
      expect(updateInvoicePeriod).toHaveBeenCalledWith(
        "invoice-id",
        { startDate: "2026-08-05", endDate: "2026-09-05" },
        4
      );
    });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Edit Invoice Dates" })).toBeNull()
    );
    expect(screen.getAllByText("invoice-2026-08-05-2026-09-05").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Aug 5, 2026 – Sep 5, 2026").length).toBeGreaterThan(0);
    expect(screen.getByText("Invoice dates updated.")).toBeTruthy();
  });
});
