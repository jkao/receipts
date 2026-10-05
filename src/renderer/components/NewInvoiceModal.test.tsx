// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InvoiceSummary } from "../../shared/types";
import { NewInvoiceModal } from "./InvoiceModals";

const existingInvoice: InvoiceSummary = {
  id: "invoice-1",
  name: "invoice-2026-08-01-2026-08-24",
  period: { startDate: "2026-08-01", endDate: "2026-08-24" },
  rowCount: 10,
  receiptCount: 8,
  updatedAt: "2026-08-24T12:00:00.000Z",
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("NewInvoiceModal", () => {
  it("uses the supplied non-overlapping dates", () => {
    render(
      <NewInvoiceModal
        busy={false}
        existingInvoices={[existingInvoice]}
        initialPeriod={{ startDate: "2026-08-25", endDate: "2026-08-25" }}
        onClose={vi.fn()}
        onCreate={vi.fn()}
      />
    );

    expect((screen.getByLabelText("Start date") as HTMLInputElement).value).toBe("2026-08-25");
    expect((screen.getByLabelText("End date") as HTMLInputElement).value).toBe("2026-08-25");
    expect(screen.queryByText(/overlaps/i)).toBeNull();
  });

  it("warns about an overlap and requires confirmation before creation", async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    Object.defineProperty(window, "confirm", { configurable: true, value: confirm });
    render(
      <NewInvoiceModal
        busy={false}
        existingInvoices={[existingInvoice]}
        initialPeriod={{ startDate: "2026-08-20", endDate: "2026-08-25" }}
        onClose={vi.fn()}
        onCreate={onCreate}
      />
    );

    expect(screen.getByRole("status").textContent).toContain("overlaps");
    fireEvent.click(screen.getByRole("button", { name: "Create Invoice" }));
    expect(onCreate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Create Invoice" }));

    await waitFor(() => {
      expect(confirm).toHaveBeenCalledTimes(2);
      expect(onCreate).toHaveBeenCalledWith({ startDate: "2026-08-20", endDate: "2026-08-25" });
    });
  });
});
