// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopApi, InvoiceDocument } from "../shared/types";

vi.mock("./components/InvoiceGrid", () => ({
  InvoiceGrid: () => <div>Invoice rows</div>,
}));

vi.mock("./lib/scheduleIdleTask", () => ({
  scheduleIdleTask: () => () => undefined,
}));

import App from "./App";

function invoice(id: string, name: string, updatedAt: string): InvoiceDocument {
  return {
    schemaVersion: 1,
    id,
    name,
    period: { startDate: "2026-08-01", endDate: "2026-08-31" },
    defaultRateMinor: 4_500,
    currency: "USD",
    revision: 1,
    rows: [],
    receipts: [],
    reviewAcknowledgements: [],
    createdAt: updatedAt,
    updatedAt,
  };
}

function summary(document: InvoiceDocument) {
  return {
    id: document.id,
    name: document.name,
    period: document.period,
    rowCount: document.rows.length,
    receiptCount: document.receipts.length,
    updatedAt: document.updatedAt,
  };
}

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
});

describe("invoice state folder", () => {
  it("saves a complete backup of the current saved revision", async () => {
    const currentInvoice = invoice(
      "invoice-id",
      "invoice-2026-08-01-2026-08-31",
      "2026-08-25T12:00:00.000Z"
    );
    const backupInvoice = vi.fn().mockResolvedValue({
      canceled: false,
      outputPath: `/Backups/${currentInvoice.name}-backup-2026-08-25`,
    });
    const api = {
      getSettings: vi.fn().mockResolvedValue({
        baseFolder: "/Invoices",
        hasOpenAiKey: true,
        defaultRateMinor: 4_500,
      }),
      listInvoices: vi.fn().mockResolvedValue([summary(currentInvoice)]),
      loadInvoice: vi.fn().mockResolvedValue(currentInvoice),
      backupInvoice,
      onImportProgress: vi.fn(() => () => undefined),
    } as unknown as DesktopApi;
    Object.defineProperty(window, "receiptApp", {
      configurable: true,
      value: api,
    });

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Save Backup…" }));

    await waitFor(() => expect(backupInvoice).toHaveBeenCalledWith(currentInvoice.id, 1));
    expect(
      await screen.findByText(`Backup saved as ${currentInvoice.name}-backup-2026-08-25.`)
    ).toBeTruthy();
  });

  it("switches the app to the invoices at the newly selected path", async () => {
    const oldInvoice = invoice(
      "old-invoice",
      "invoice-2026-08-01-2026-08-31",
      "2026-08-20T12:00:00.000Z"
    );
    const newInvoice = invoice(
      "new-invoice",
      "invoice-2026-09-01-2026-09-30",
      "2026-08-23T12:00:00.000Z"
    );
    const listInvoices = vi
      .fn()
      .mockResolvedValueOnce([summary(oldInvoice)])
      .mockResolvedValueOnce([summary(newInvoice)]);
    const loadInvoice = vi.fn().mockResolvedValueOnce(oldInvoice).mockResolvedValueOnce(newInvoice);
    const chooseBaseFolder = vi.fn().mockResolvedValue({
      baseFolder: "/NewInvoices",
      hasOpenAiKey: true,
      defaultRateMinor: 4_500,
    });
    const api = {
      getSettings: vi.fn().mockResolvedValue({
        baseFolder: "/OldInvoices",
        hasOpenAiKey: true,
        defaultRateMinor: 4_500,
      }),
      chooseBaseFolder,
      listInvoices,
      loadInvoice,
      onImportProgress: vi.fn(() => () => undefined),
    } as unknown as DesktopApi;
    Object.defineProperty(window, "receiptApp", {
      configurable: true,
      value: api,
    });

    render(<App />);
    await screen.findAllByText(oldInvoice.name);
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Change…" }));

    await waitFor(() => {
      expect(chooseBaseFolder).toHaveBeenCalledOnce();
      expect(listInvoices).toHaveBeenCalledTimes(2);
      expect(loadInvoice).toHaveBeenLastCalledWith(newInvoice.id);
    });
    expect((await screen.findAllByText(newInvoice.name)).length).toBeGreaterThan(0);
    expect(screen.getByText("Invoice state folder changed.")).toBeTruthy();
  });
});
