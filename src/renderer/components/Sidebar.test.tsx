// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InvoiceSummary } from "../../shared/types";
import { Sidebar } from "./Sidebar";

afterEach(cleanup);

describe("Sidebar", () => {
  it("marks a scanning invoice while keeping navigation available", () => {
    const onOpen = vi.fn();
    render(
      <Sidebar
        activeInvoiceId="invoice-1"
        backgroundInert={false}
        busy={false}
        importingInvoiceIds={new Set(["invoice-1"])}
        invoices={[summary()]}
        onNew={vi.fn()}
        onOpen={onOpen}
        onSettings={vi.fn()}
      />
    );

    expect(screen.getByRole("status").textContent).toContain("Scanning receipts");
    const invoiceButton = screen.getByRole("button", { name: /invoice-2026/i });
    expect(invoiceButton.hasAttribute("disabled")).toBe(false);
    fireEvent.click(invoiceButton);
    expect(onOpen).toHaveBeenCalledWith("invoice-1");
  });
});

function summary(): InvoiceSummary {
  return {
    id: "invoice-1",
    name: "invoice-2026-08-01-2026-08-31",
    period: { startDate: "2026-08-01", endDate: "2026-08-31" },
    rowCount: 2,
    receiptCount: 1,
    updatedAt: "2026-08-23T12:00:00.000Z",
  };
}
