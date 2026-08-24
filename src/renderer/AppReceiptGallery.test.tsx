// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopApi, InvoiceDocument } from "../shared/types";

vi.mock("./components/InvoiceGrid", () => ({
  InvoiceGrid: () => <div data-testid="invoice-grid">Editable table</div>,
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
      date: "2026-08-20",
      groceriesMinor: 1_250,
      hours: "",
      rateMinor: 4_500,
      comment: "Market run",
      receiptId: "receipt-1",
    },
  ],
  receipts: [
    {
      id: "receipt-1",
      relativePath: "receipts/market.png",
      debugPath: "debug/receipt-1.json",
      originalFilename: "market.png",
      mimeType: "image/png",
      sha256: "a".repeat(64),
      source: { kind: "manual", method: "file-picker" },
      status: "ready",
      importedAt: "2026-08-20T12:00:00.000Z",
    },
  ],
  reviewAcknowledgements: [],
  createdAt: "2026-08-01T12:00:00.000Z",
  updatedAt: "2026-08-23T12:00:00.000Z",
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
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

describe("invoice receipt gallery", () => {
  it("toggles between the editable table and the visual audit view", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const getReceiptThumbnail = vi.fn().mockResolvedValue({
      filename: "market.png",
      mimeType: "image/png",
      dataUrl: "blob:market",
      managedPath: "/Invoices/receipts/market.png",
    });
    const releaseReceiptThumbnail = vi.fn();
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
      getReceiptThumbnail,
      releaseReceiptThumbnail,
      onImportProgress: vi.fn(() => () => undefined),
    } as unknown as DesktopApi;
    Object.defineProperty(window, "receiptApp", {
      configurable: true,
      value: api,
    });

    render(<App />);
    expect(await screen.findByTestId("invoice-grid")).toBeTruthy();
    const tableButton = screen.getByRole("button", { name: "Table" });
    const galleryButton = screen.getByRole("button", { name: "Gallery" });
    expect(tableButton.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(galleryButton);
    expect(await screen.findByText("Receipt gallery")).toBeTruthy();
    expect(screen.queryByTestId("invoice-grid")).toBeNull();
    expect(galleryButton.getAttribute("aria-pressed")).toBe("true");
    await waitFor(() => {
      expect(getReceiptThumbnail).toHaveBeenCalledWith(invoice.id, "receipt-1");
    });

    fireEvent.click(tableButton);
    expect(await screen.findByTestId("invoice-grid")).toBeTruthy();
    expect(tableButton.getAttribute("aria-pressed")).toBe("true");
    expect(releaseReceiptThumbnail).toHaveBeenCalledWith(invoice.id, "receipt-1");
  });
});
