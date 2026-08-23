// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CalculatedColumn, RenderEditCellProps } from "react-data-grid";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InvoiceRow } from "../../shared/types";
import { commitActiveGridEditor } from "../lib/activeGridEditor";
import type { InvoiceSummaryRow } from "../lib/invoiceSummary";
import { CommentEditor, DateEditor, HoursEditor, InvoiceGrid, MoneyEditor } from "./InvoiceGrid";

const row: InvoiceRow = {
  id: "row-1",
  date: "2026-08-20",
  groceriesMinor: 500,
  hours: "1.00",
  rateMinor: 4_500,
  comment: "Original",
  receiptId: null,
};

function editorProps() {
  return {
    column: {} as CalculatedColumn<InvoiceRow, InvoiceSummaryRow>,
    row,
    rowIdx: 0,
    onRowChange: vi.fn(),
    onClose: vi.fn(),
  } satisfies RenderEditCellProps<InvoiceRow, InvoiceSummaryRow>;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function exposeAllGridColumns(): void {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(2_000);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  const querySelector = Element.prototype.querySelector;
  vi.spyOn(Element.prototype, "querySelector").mockImplementation(function (
    this: Element,
    selector
  ) {
    return querySelector.call(this, selector.replace(/^&/, ":scope"));
  });
}

describe("InvoiceGrid editors", () => {
  it("keeps money keystrokes local and commits exactly once on Enter", () => {
    const props = editorProps();
    render(<MoneyEditor {...props} field="groceriesMinor" label="Groceries amount" />);

    const input = screen.getByRole("textbox", { name: "Groceries amount" });
    fireEvent.change(input, { target: { value: "12.34" } });
    expect(props.onRowChange).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.blur(input);
    expect(props.onRowChange).toHaveBeenCalledTimes(1);
    expect(props.onRowChange).toHaveBeenCalledWith({ ...row, groceriesMinor: 1_234 }, true);
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("keeps an invalid money edit open and exposes its error to assistive technology", () => {
    vi.useFakeTimers();
    const props = editorProps();
    render(<MoneyEditor {...props} field="rateMinor" label="Hourly rate" />);

    const input = screen.getByRole("textbox", { name: "Hourly rate" });
    fireEvent.change(input, { target: { value: "12.345" } });
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-errormessage")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("two decimal places");

    fireEvent.blur(input);
    expect(props.onRowChange).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("defers hours and comment updates until a successful commit", () => {
    const hoursProps = editorProps();
    const { unmount } = render(<HoursEditor {...hoursProps} />);
    const hours = screen.getByRole("textbox", { name: "Hours worked" });
    fireEvent.change(hours, { target: { value: "2.75" } });
    expect(hoursProps.onRowChange).not.toHaveBeenCalled();
    fireEvent.blur(hours);
    expect(hoursProps.onRowChange).toHaveBeenCalledOnce();
    expect(hoursProps.onRowChange).toHaveBeenCalledWith({ ...row, hours: "2.75" }, true);

    unmount();
    const commentProps = editorProps();
    render(<CommentEditor {...commentProps} />);
    const comment = screen.getByRole("textbox", { name: "Comment" });
    fireEvent.change(comment, { target: { value: "Updated locally" } });
    expect(commentProps.onRowChange).not.toHaveBeenCalled();
    fireEvent.blur(comment);
    expect(commentProps.onRowChange).toHaveBeenCalledOnce();
    expect(commentProps.onRowChange).toHaveBeenCalledWith(
      { ...row, comment: "Updated locally" },
      true
    );
  });

  it("commits valid drafts before Tab navigation and blocks invalid drafts", () => {
    const commentProps = editorProps();
    const { unmount } = render(<CommentEditor {...commentProps} />);
    const comment = screen.getByRole("textbox", { name: "Comment" });
    fireEvent.change(comment, { target: { value: "Tab commit" } });
    fireEvent.keyDown(comment, { key: "Tab" });
    expect(commentProps.onRowChange).toHaveBeenCalledWith({ ...row, comment: "Tab commit" }, true);

    unmount();
    const hoursProps = editorProps();
    render(<HoursEditor {...hoursProps} />);
    const hours = screen.getByRole("textbox", { name: "Hours worked" });
    fireEvent.change(hours, { target: { value: "invalid" } });
    expect(fireEvent.keyDown(hours, { key: "Tab" })).toBe(false);
    expect(hoursProps.onRowChange).not.toHaveBeenCalled();
    expect(hoursProps.onClose).not.toHaveBeenCalled();
  });

  it("validates date drafts and commits them through the same local editor path", () => {
    const props = editorProps();
    const view = render(<DateEditor {...props} />);
    const input = screen.getByLabelText("Receipt date") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "2026-08-21" } });
    fireEvent.keyDown(input, { key: "Tab" });
    expect(props.onRowChange).toHaveBeenCalledWith({ ...row, date: "2026-08-21" }, true);

    view.unmount();
    const invalidProps = editorProps();
    render(<DateEditor {...invalidProps} />);
    const invalidDate = screen.getByLabelText("Receipt date") as HTMLInputElement;
    invalidDate.setCustomValidity("Incomplete date");
    expect(fireEvent.keyDown(invalidDate, { key: "Tab" })).toBe(false);
    expect(invalidProps.onRowChange).not.toHaveBeenCalled();
    expect(invalidProps.onClose).not.toHaveBeenCalled();
    expect(invalidDate.getAttribute("aria-invalid")).toBe("true");
  });

  it("closes normalized no-op drafts without publishing a row change", () => {
    const moneyProps = editorProps();
    const { unmount } = render(
      <MoneyEditor {...moneyProps} field="groceriesMinor" label="Groceries amount" />
    );
    fireEvent.blur(screen.getByRole("textbox", { name: "Groceries amount" }));
    expect(moneyProps.onRowChange).not.toHaveBeenCalled();
    expect(moneyProps.onClose).toHaveBeenCalledWith(false);

    unmount();
    const hoursProps = editorProps();
    render(<HoursEditor {...hoursProps} />);
    const hours = screen.getByRole("textbox", { name: "Hours worked" });
    fireEvent.change(hours, { target: { value: "1" } });
    fireEvent.blur(hours);
    expect(hoursProps.onRowChange).not.toHaveBeenCalled();
    expect(hoursProps.onClose).toHaveBeenCalledWith(false);
  });

  it("commits a local draft through React Data Grid instead of its stale editor row", async () => {
    exposeAllGridColumns();
    const user = userEvent.setup();
    const onRowsChange = vi.fn();
    render(
      <InvoiceGrid
        activeRowId={null}
        receipts={[]}
        rows={[row]}
        selectedRows={new Set()}
        sortColumns={[]}
        totals={{ groceriesMinor: 500, hours: "1.00", labourMinor: 4_500, invoiceMinor: 5_000 }}
        onDeleteSelected={vi.fn()}
        onOpenRow={vi.fn()}
        onRowsChange={onRowsChange}
        onSelectedRowsChange={vi.fn()}
        onSortColumnsChange={vi.fn()}
      />
    );

    await user.dblClick(screen.getByText("Original"));
    const input = screen.getByRole("textbox", { name: "Comment" });
    await user.clear(input);
    await user.type(input, "Committed value{Enter}");

    expect(onRowsChange).toHaveBeenCalledOnce();
    expect(onRowsChange.mock.calls[0][0]).toEqual([{ ...row, comment: "Committed value" }]);
  });

  it("keeps an invalid local draft open when another grid cell is clicked", async () => {
    exposeAllGridColumns();
    const user = userEvent.setup();
    let gridContainer: HTMLDivElement | null = null;
    render(
      <div
        ref={(element) => {
          gridContainer = element;
        }}
        onMouseDownCapture={(event) => {
          if (event.target === document.activeElement) return;
          if (commitActiveGridEditor(gridContainer) !== "invalid") return;
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        <InvoiceGrid
          activeRowId={null}
          receipts={[]}
          rows={[row]}
          selectedRows={new Set()}
          sortColumns={[]}
          totals={{
            groceriesMinor: 500,
            hours: "1.00",
            labourMinor: 4_500,
            invoiceMinor: 5_000,
          }}
          onDeleteSelected={vi.fn()}
          onOpenRow={vi.fn()}
          onRowsChange={vi.fn()}
          onSelectedRowsChange={vi.fn()}
          onSortColumnsChange={vi.fn()}
        />
      </div>
    );

    const groceriesCell = screen
      .getAllByText("$5.00")
      .find((element) => element.getAttribute("role") === "gridcell");
    expect(groceriesCell).toBeTruthy();
    await user.dblClick(groceriesCell as HTMLElement);
    const input = screen.getByRole("textbox", { name: "Groceries amount" });
    await user.clear(input);
    await user.type(input, "12.345");
    await user.click(screen.getByText("Original"));

    expect(screen.getByRole("textbox", { name: "Groceries amount" })).toBe(input);
    expect(input.getAttribute("aria-invalid")).toBe("true");
  });
});
