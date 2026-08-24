// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopApi, InvoiceDocument, InvoiceRow } from "../shared/types";

vi.mock("./components/InvoiceGrid", () => ({
  InvoiceGrid: ({ rows }: { rows: InvoiceRow[] }) => (
    <output data-testid="grid-row-count">{rows.length}</output>
  ),
}));

vi.mock("./lib/scheduleIdleTask", () => ({
  scheduleIdleTask: () => () => undefined,
}));

import App from "./App";

const invoice: InvoiceDocument = {
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

  const api = {
    getSettings: vi.fn().mockResolvedValue({
      baseFolder: "/Invoices",
      hasOpenAiKey: true,
      defaultRateMinor: 4_500,
    }),
    listInvoices: vi.fn().mockResolvedValue([
      {
        id: invoice.id,
        name: invoice.name,
        period: invoice.period,
        rowCount: invoice.rows.length,
        receiptCount: invoice.receipts.length,
        updatedAt: invoice.updatedAt,
      },
    ]),
    loadInvoice: vi.fn().mockResolvedValue(invoice),
    saveRows: vi.fn().mockImplementation(async (_id, rows) => ({ ...invoice, rows })),
    onImportProgress: vi.fn(() => () => undefined),
  } as unknown as DesktopApi;
  Object.defineProperty(window, "receiptApp", {
    configurable: true,
    value: api,
  });
});

describe("manual row shortcut", () => {
  it("adds a manual row with Command-Shift-M and shows the shortcut on hover", async () => {
    render(<App />);

    const button = await screen.findByRole("button", { name: "Manual Row" });
    expect(button.getAttribute("title")).toBe("Add a manual row (⌘⇧M)");
    expect(screen.getByTestId("grid-row-count").textContent).toBe("1");

    fireEvent.keyDown(window, { key: "M", metaKey: true, shiftKey: true });

    await waitFor(() => expect(screen.getByTestId("grid-row-count").textContent).toBe("2"));
  });
});
