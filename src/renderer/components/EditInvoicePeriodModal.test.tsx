// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditInvoicePeriodModal } from "./InvoiceModals";

const period = { startDate: "2026-08-01", endDate: "2026-08-31" };

afterEach(cleanup);

describe("EditInvoicePeriodModal", () => {
  it("starts with the saved period and only submits a valid change", async () => {
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    render(
      <EditInvoicePeriodModal busy={false} period={period} onClose={vi.fn()} onUpdate={onUpdate} />
    );

    const startDate = screen.getByLabelText("Start date") as HTMLInputElement;
    const endDate = screen.getByLabelText("End date") as HTMLInputElement;
    const save = screen.getByRole("button", { name: "Save Dates" });
    expect(startDate.value).toBe("2026-08-01");
    expect(endDate.value).toBe("2026-08-31");
    expect(save.hasAttribute("disabled")).toBe(true);

    fireEvent.change(startDate, { target: { value: "2026-09-10" } });
    fireEvent.submit(save.closest("form") as HTMLFormElement);
    expect(screen.getByRole("alert").textContent).toContain(
      "The end date must be on or after the start date."
    );
    expect(onUpdate).not.toHaveBeenCalled();

    fireEvent.change(endDate, { target: { value: "2026-09-30" } });
    fireEvent.click(save);
    await waitFor(() =>
      expect(onUpdate).toHaveBeenCalledWith({
        startDate: "2026-09-10",
        endDate: "2026-09-30",
      })
    );
  });

  it("keeps the modal open and surfaces a failed update", async () => {
    const onClose = vi.fn();
    const onUpdate = vi.fn().mockRejectedValue(new Error("That invoice period already exists."));
    render(
      <EditInvoicePeriodModal busy={false} period={period} onClose={onClose} onUpdate={onUpdate} />
    );

    fireEvent.change(screen.getByLabelText("End date"), {
      target: { value: "2026-09-01" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save Dates" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "That invoice period already exists."
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Edit Invoice Dates" })).toBeTruthy();
  });
});
