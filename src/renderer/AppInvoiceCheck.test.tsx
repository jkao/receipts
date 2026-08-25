// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopApi, InvoiceCheckResult, InvoiceDocument, InvoiceRow } from "../shared/types";

const scheduledChecks = vi.hoisted(() => [] as Array<{ cancelled: boolean; task: () => void }>);

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
      onClick={() => onRowsChange(rows.map((row) => ({ ...row, comment: "Edited" })))}
    >
      Edit invoice row
    </button>
  ),
}));

vi.mock("./lib/scheduleIdleTask", () => ({
  scheduleIdleTask: (task: () => void) => {
    const scheduled = { cancelled: false, task };
    scheduledChecks.push(scheduled);
    return () => {
      scheduled.cancelled = true;
    };
  },
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

function checkResult(revision: number): InvoiceCheckResult {
  return {
    invoiceId: initialInvoice.id,
    revision,
    checkedAt: "2026-08-25T12:00:00.000Z",
    issues: [
      {
        fingerprint: "finding",
        acknowledgeable: true,
        acknowledgedAt: null,
        code: "date-outside-period",
        message: "Review this row.",
        rowIds: ["row-1"],
        receiptIds: [],
      },
    ],
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  scheduledChecks.length = 0;
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
});

describe("invoice check minimization", () => {
  it("stays minimized when an ordinary edit refreshes the check result", async () => {
    let savedInvoice = initialInvoice;
    const checkInvoice = vi.fn().mockImplementation(async () => checkResult(savedInvoice.revision));
    const saveRows = vi.fn().mockImplementation(async (_id, rows: InvoiceRow[]) => {
      savedInvoice = { ...savedInvoice, revision: savedInvoice.revision + 1, rows };
      return savedInvoice;
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
          receiptCount: 0,
          updatedAt: initialInvoice.updatedAt,
        },
      ]),
      loadInvoice: vi.fn().mockResolvedValue(initialInvoice),
      saveRows,
      checkInvoice,
      onImportProgress: vi.fn(() => () => undefined),
    } as unknown as DesktopApi;
    Object.defineProperty(window, "receiptApp", {
      configurable: true,
      value: api,
    });

    render(<App />);

    await screen.findByRole("button", { name: "Edit invoice row" });
    await waitFor(() => expect(scheduledChecks.some((check) => !check.cancelled)).toBe(true));
    const initialCheck = scheduledChecks.find((check) => !check.cancelled);
    await act(async () => initialCheck?.task());

    fireEvent.click(await screen.findByRole("button", { name: "Dismiss" }));
    expect(screen.getByRole("button", { name: "Show details" })).toBeTruthy();
    expect(screen.queryByText("Review this row.")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Edit invoice row" }));
    await waitFor(() => expect(saveRows).toHaveBeenCalled(), { timeout: 2_000 });
    await waitFor(() =>
      expect(scheduledChecks.some((check) => !check.cancelled && check !== initialCheck)).toBe(true)
    );
    const refreshedCheck = scheduledChecks.find(
      (check) => !check.cancelled && check !== initialCheck
    );
    await act(async () => refreshedCheck?.task());
    await waitFor(() => expect(checkInvoice).toHaveBeenCalledTimes(2));

    expect(screen.getByRole("button", { name: "Show details" })).toBeTruthy();
    expect(screen.queryByText("Review this row.")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Show details" }));
    expect(screen.getByText("Review this row.")).toBeTruthy();
  });
});
