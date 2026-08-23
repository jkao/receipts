// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
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
        onToggleReview: vi.fn(),
      })
    );

    expect(markup).toMatch(/<aside[^>]*aria-labelledby=/);
    expect(markup).toContain("Manual row");
    expect(markup).toContain("Review checklist");
    expect(markup).toContain("Verify the manual row date.");
    expect(markup).toContain('aria-label="Close row details"');
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
          onToggleReview: vi.fn(),
        })
      );

      fireEvent.click(view.getByRole("button", { name: "Close row details" }));
      expect(releaseReceiptPreview).toHaveBeenCalledTimes(1);
      expect(onClose).toHaveBeenCalledTimes(1);

      view.unmount();
      expect(releaseReceiptPreview).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
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
