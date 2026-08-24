// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  InvoiceCheckIssue,
  InvoiceRow,
  ReceiptDebug,
  ReceiptPreview,
  ReceiptRecord,
} from "../../shared/types";
import { ReceiptDrawer, startReceiptResourceLoad } from "./ReceiptDrawer";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const manualRow: InvoiceRow = {
  id: "manual-row",
  date: "2026-08-20",
  groceriesMinor: 1_250,
  hours: "1.5",
  rateMinor: 4_500,
  comment: "Client supplies",
  receiptId: null,
};

const reviewIssue: InvoiceCheckIssue = {
  fingerprint: "manual-date",
  acknowledgeable: true,
  acknowledgedAt: null,
  code: "date-outside-period",
  message: "Verify the manual row date.",
  rowIds: [manualRow.id],
  receiptIds: [],
};

function EditableReceiptDrawer({ onRowChange }: { onRowChange: (row: InvoiceRow) => void }) {
  const [row, setRow] = useState(manualRow);
  return createElement(ReceiptDrawer, {
    invoiceId: "invoice-1",
    resourceGeneration: 1,
    row,
    receipt: null,
    reviewDisabled: false,
    reviewIssues: [],
    updatingFingerprints: new Set<string>(),
    onClose: vi.fn(),
    onRetry: vi.fn(),
    onRowChange: (nextRow) => {
      onRowChange(nextRow);
      setRow(nextRow);
    },
    onToggleReview: vi.fn(),
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("ReceiptDrawer", () => {
  it("shows the same review checklist for a manual row without requiring receipt APIs", () => {
    const markup = renderToStaticMarkup(
      createElement(ReceiptDrawer, {
        invoiceId: "invoice-1",
        resourceGeneration: 1,
        row: manualRow,
        receipt: null,
        reviewDisabled: false,
        reviewIssues: [reviewIssue],
        updatingFingerprints: new Set<string>(),
        onClose: vi.fn(),
        onRetry: vi.fn(),
        onRowChange: vi.fn(),
        onToggleReview: vi.fn(),
      })
    );

    expect(markup).toContain('class="modal-card receipt-modal"');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain("Manual row");
    expect(markup).toContain("Review checklist");
    expect(markup).toContain("Verify the manual row date.");
    expect(markup).toContain('aria-label="Close Manual row"');
    expect(markup).toContain("This row is not linked to a receipt.");
  });

  it("releases the preview and ignores late resource results after cleanup", async () => {
    const previewRequest = deferred<ReceiptPreview>();
    const debugRequest = deferred<null>();
    const api = {
      getReceiptPreview: vi.fn().mockReturnValue(previewRequest.promise),
      releaseReceiptPreview: vi.fn(),
      getReceiptDebug: vi.fn().mockReturnValue(debugRequest.promise),
    };
    const callbacks = {
      onPreview: vi.fn(),
      onPreviewError: vi.fn(),
      onPreviewSettled: vi.fn(),
      onDebug: vi.fn(),
      onDebugError: vi.fn(),
      onDebugSettled: vi.fn(),
    };

    const cleanup = startReceiptResourceLoad(api, "invoice-1", "receipt-1", callbacks);
    cleanup();
    previewRequest.resolve({
      filename: "receipt.png",
      mimeType: "image/png",
      dataUrl: "blob:receipt",
      managedPath: "/managed/receipt.png",
    });
    debugRequest.resolve(null);
    await Promise.all([previewRequest.promise, debugRequest.promise]);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(api.releaseReceiptPreview).toHaveBeenCalledTimes(1);
    expect(callbacks.onPreview).not.toHaveBeenCalled();
    expect(callbacks.onPreviewError).not.toHaveBeenCalled();
    expect(callbacks.onPreviewSettled).not.toHaveBeenCalled();
    expect(callbacks.onDebug).not.toHaveBeenCalled();
    expect(callbacks.onDebugError).not.toHaveBeenCalled();
    expect(callbacks.onDebugSettled).not.toHaveBeenCalled();
  });

  it("keeps preview and debug outcomes independent while active", async () => {
    const preview: ReceiptPreview = {
      filename: "receipt.png",
      mimeType: "image/png",
      dataUrl: "blob:receipt",
      managedPath: "/managed/receipt.png",
    };
    const api = {
      getReceiptPreview: vi.fn().mockResolvedValue(preview),
      releaseReceiptPreview: vi.fn(),
      getReceiptDebug: vi.fn().mockRejectedValue(new Error("debug unavailable")),
    };
    const callbacks = {
      onPreview: vi.fn(),
      onPreviewError: vi.fn(),
      onPreviewSettled: vi.fn(),
      onDebug: vi.fn(),
      onDebugError: vi.fn(),
      onDebugSettled: vi.fn(),
    };

    const cleanup = startReceiptResourceLoad(api, "invoice-1", "receipt-1", callbacks);
    await vi.waitFor(() => {
      expect(callbacks.onPreview).toHaveBeenCalledWith(preview);
      expect(callbacks.onPreviewSettled).toHaveBeenCalledTimes(1);
      expect(callbacks.onDebugError).toHaveBeenCalledWith(expect.any(Error));
      expect(callbacks.onDebugSettled).toHaveBeenCalledTimes(1);
    });
    cleanup();

    expect(callbacks.onPreviewError).not.toHaveBeenCalled();
    expect(callbacks.onDebug).not.toHaveBeenCalled();
    expect(api.releaseReceiptPreview).toHaveBeenCalledTimes(1);
  });

  it("releases the active preview immediately on close and again on unmount cleanup", () => {
    const pending = new Promise<never>(() => undefined);
    const releaseReceiptPreview = vi.fn();
    vi.stubGlobal("receiptApp", {
      getReceiptPreview: vi.fn().mockReturnValue(pending),
      releaseReceiptPreview,
      getReceiptDebug: vi.fn().mockReturnValue(pending),
    });
    const receipt: ReceiptRecord = {
      id: "receipt-1",
      relativePath: "receipts/receipt.png",
      debugPath: "debug/receipt-1.json",
      originalFilename: "receipt.png",
      mimeType: "image/png",
      sha256: "a".repeat(64),
      source: { kind: "manual", method: "file-picker" },
      status: "ready",
      importedAt: "2026-08-21T12:00:00.000Z",
    };
    const onClose = vi.fn();

    try {
      const view = render(
        createElement(ReceiptDrawer, {
          invoiceId: "invoice-1",
          resourceGeneration: 1,
          row: { ...manualRow, receiptId: receipt.id },
          receipt,
          reviewDisabled: false,
          reviewIssues: [],
          updatingFingerprints: new Set<string>(),
          onClose,
          onRetry: vi.fn(),
          onRowChange: vi.fn(),
          onToggleReview: vi.fn(),
        })
      );

      expect(view.getByRole("dialog", { name: receipt.originalFilename })).toBeTruthy();
      fireEvent.click(view.getByRole("button", { name: `Close ${receipt.originalFilename}` }));
      expect(releaseReceiptPreview).toHaveBeenCalledTimes(1);
      expect(onClose).toHaveBeenCalledTimes(1);

      view.unmount();
      expect(releaseReceiptPreview).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("navigates to the previous and next invoice rows from the modal controls", () => {
    const onPreviousRow = vi.fn();
    const onNextRow = vi.fn();
    vi.stubGlobal("receiptApp", {
      releaseReceiptPreview: vi.fn(),
    });

    render(
      createElement(ReceiptDrawer, {
        invoiceId: "invoice-1",
        resourceGeneration: 1,
        row: manualRow,
        receipt: null,
        reviewDisabled: false,
        reviewIssues: [],
        updatingFingerprints: new Set<string>(),
        rowNumber: 2,
        rowCount: 3,
        onClose: vi.fn(),
        onNextRow,
        onPreviousRow,
        onRetry: vi.fn(),
        onRowChange: vi.fn(),
        onToggleReview: vi.fn(),
      })
    );

    expect(screen.getByText("2 of 3")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Previous invoice row" }));
    fireEvent.click(screen.getByRole("button", { name: "Next invoice row" }));
    expect(onPreviousRow).toHaveBeenCalledOnce();
    expect(onNextRow).toHaveBeenCalledOnce();

    fireEvent.keyDown(window, { key: "ArrowLeft" });
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(onPreviousRow).toHaveBeenCalledTimes(2);
    expect(onNextRow).toHaveBeenCalledTimes(2);
  });

  it("leaves arrow keys available to editable modal fields", () => {
    const onPreviousRow = vi.fn();
    const onNextRow = vi.fn();
    vi.stubGlobal("receiptApp", {
      releaseReceiptPreview: vi.fn(),
    });

    render(
      createElement(ReceiptDrawer, {
        invoiceId: "invoice-1",
        resourceGeneration: 1,
        row: manualRow,
        receipt: null,
        reviewDisabled: false,
        reviewIssues: [],
        updatingFingerprints: new Set<string>(),
        rowNumber: 2,
        rowCount: 3,
        onClose: vi.fn(),
        onNextRow,
        onPreviousRow,
        onRetry: vi.fn(),
        onRowChange: vi.fn(),
        onToggleReview: vi.fn(),
      })
    );

    const input = document.createElement("input");
    document.body.append(input);
    fireEvent.keyDown(input, { key: "ArrowLeft" });
    fireEvent.keyDown(input, { key: "ArrowRight" });
    expect(onPreviousRow).not.toHaveBeenCalled();
    expect(onNextRow).not.toHaveBeenCalled();
    input.remove();
  });

  it("edits summary values and recalculates labour from hours and rate", () => {
    vi.stubGlobal("receiptApp", {
      releaseReceiptPreview: vi.fn(),
    });
    const onRowChange = vi.fn();
    render(createElement(EditableReceiptDrawer, { onRowChange }));

    expect(screen.getByText("$45.00")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Edit groceries amount" }));
    const groceries = screen.getByRole("textbox", { name: "Groceries amount" });
    fireEvent.change(groceries, { target: { value: "27.35" } });
    fireEvent.blur(groceries);
    expect(onRowChange).toHaveBeenLastCalledWith({ ...manualRow, groceriesMinor: 2_735 });

    fireEvent.click(screen.getByRole("button", { name: "Edit hours worked" }));
    const hours = screen.getByRole("textbox", { name: "Hours worked" });
    fireEvent.change(hours, { target: { value: "2" } });
    expect(screen.getByText("$90.00")).toBeTruthy();
    fireEvent.blur(hours);

    fireEvent.click(screen.getByRole("button", { name: "Edit hourly rate" }));
    const rate = screen.getByRole("textbox", { name: "Hourly rate" });
    fireEvent.change(rate, { target: { value: "50" } });
    expect(screen.getByText("$100.00")).toBeTruthy();
    fireEvent.blur(rate);

    fireEvent.click(screen.getByRole("button", { name: "Edit receipt date" }));
    const date = screen.getByLabelText("Receipt date");
    fireEvent.change(date, { target: { value: "2026-08-22" } });
    fireEvent.blur(date);

    expect(onRowChange).toHaveBeenLastCalledWith({
      ...manualRow,
      date: "2026-08-22",
      groceriesMinor: 2_735,
      hours: "2",
      rateMinor: 5_000,
    });
  });

  it("reloads same-status scan resources for a newer resource generation", async () => {
    const receipt = readyReceipt("receipt-1", "receipt.png");
    const preview: ReceiptPreview = {
      filename: receipt.originalFilename,
      mimeType: receipt.mimeType,
      dataUrl: "blob:receipt",
      managedPath: `/managed/${receipt.originalFilename}`,
    };
    const getReceiptDebug = vi
      .fn()
      .mockResolvedValueOnce(receiptDebug(receipt.id, "Old merchant"))
      .mockResolvedValueOnce(receiptDebug(receipt.id, "New merchant"));
    vi.stubGlobal("receiptApp", {
      getReceiptPreview: vi.fn().mockResolvedValue(preview),
      releaseReceiptPreview: vi.fn(),
      getReceiptDebug,
    });
    const props = {
      invoiceId: "invoice-1",
      row: { ...manualRow, receiptId: receipt.id },
      receipt,
      reviewDisabled: false,
      reviewIssues: [],
      updatingFingerprints: new Set<string>(),
      onClose: vi.fn(),
      onRetry: vi.fn(),
      onRowChange: vi.fn(),
      onToggleReview: vi.fn(),
    };
    const view = render(createElement(ReceiptDrawer, { ...props, resourceGeneration: 1 }));
    await screen.findByText("Old merchant");

    view.rerender(
      createElement(ReceiptDrawer, {
        ...props,
        resourceGeneration: 1,
        row: { ...props.row, comment: "Unrelated row edit" },
      })
    );
    expect(screen.getByText("Old merchant")).toBeTruthy();
    expect(getReceiptDebug).toHaveBeenCalledTimes(1);

    view.rerender(createElement(ReceiptDrawer, { ...props, resourceGeneration: 2 }));
    expect(screen.queryByText("Old merchant")).toBeNull();
    await screen.findByText("New merchant");
    expect(getReceiptDebug).toHaveBeenCalledTimes(2);
  });

  it("never shows the prior row's resources while switching receipts", async () => {
    const firstReceipt = readyReceipt("receipt-1", "first.png");
    const secondReceipt = readyReceipt("receipt-2", "second.png");
    vi.stubGlobal("receiptApp", {
      getReceiptPreview: vi.fn().mockImplementation(async (_invoiceId, receiptId) => ({
        filename: receiptId === firstReceipt.id ? "first.png" : "second.png",
        mimeType: "image/png",
        dataUrl: `blob:${receiptId}`,
        managedPath: `/managed/${receiptId}.png`,
      })),
      releaseReceiptPreview: vi.fn(),
      getReceiptDebug: vi
        .fn()
        .mockImplementation(async (_invoiceId, receiptId) =>
          receiptDebug(
            receiptId,
            receiptId === firstReceipt.id ? "First merchant" : "Second merchant"
          )
        ),
    });
    const common = {
      invoiceId: "invoice-1",
      resourceGeneration: 3,
      reviewDisabled: false,
      reviewIssues: [],
      updatingFingerprints: new Set<string>(),
      onClose: vi.fn(),
      onRetry: vi.fn(),
      onRowChange: vi.fn(),
      onToggleReview: vi.fn(),
    };
    const view = render(
      createElement(ReceiptDrawer, {
        ...common,
        row: { ...manualRow, receiptId: firstReceipt.id },
        receipt: firstReceipt,
      })
    );
    await screen.findByText("First merchant");

    view.rerender(
      createElement(ReceiptDrawer, {
        ...common,
        row: { ...manualRow, receiptId: secondReceipt.id },
        receipt: secondReceipt,
      })
    );
    expect(screen.queryByText("First merchant")).toBeNull();
    await waitFor(() => expect(screen.getByText("Second merchant")).toBeTruthy());
  });
});

function readyReceipt(id: string, originalFilename: string): ReceiptRecord {
  return {
    id,
    relativePath: `receipts/${originalFilename}`,
    debugPath: `debug/${id}.json`,
    originalFilename,
    mimeType: "image/png",
    sha256: "a".repeat(64),
    source: { kind: "manual", method: "file-picker" },
    status: "ready",
    importedAt: "2026-08-21T12:00:00.000Z",
  };
}

function receiptDebug(receiptId: string, merchant: string): ReceiptDebug {
  return {
    receiptId,
    provider: "openai",
    model: "test-model",
    scannedAt: "2026-08-21T12:00:00.000Z",
    extraction: {
      merchant,
      date: "2026-08-20",
      currency: "USD",
      subtotal: "10.00",
      tax: null,
      tip: null,
      adjustments: [],
      total: "10.00",
      items: [],
    },
    validationWarnings: [],
    usage: {},
  };
}
