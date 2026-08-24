// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopApi, InvoiceCheckIssue, InvoiceRow, ReceiptRecord } from "../../shared/types";
import { ReceiptGallery } from "./ReceiptGallery";

const receipt: ReceiptRecord = {
  id: "receipt-1",
  relativePath: "receipts/market.png",
  debugPath: "debug/receipt-1.json",
  originalFilename: "market.png",
  mimeType: "image/png",
  sha256: "a".repeat(64),
  source: { kind: "manual", method: "file-picker" },
  status: "ready",
  importedAt: "2026-08-20T12:00:00.000Z",
};

const receiptRow: InvoiceRow = {
  id: "row-receipt",
  date: "2026-08-20",
  groceriesMinor: 1_250,
  hours: "1.5",
  rateMinor: 4_500,
  comment: "Market run",
  receiptId: receipt.id,
};

const manualRow: InvoiceRow = {
  id: "row-manual",
  date: "2026-08-21",
  groceriesMinor: null,
  hours: "2",
  rateMinor: 5_000,
  comment: "Client meeting",
  receiptId: null,
};

const issue: InvoiceCheckIssue = {
  fingerprint: "review-receipt",
  acknowledgeable: true,
  acknowledgedAt: null,
  code: "receipt-fields-incomplete",
  message: "Verify the receipt total.",
  rowIds: [receiptRow.id],
  receiptIds: [receipt.id],
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ReceiptGallery", () => {
  it("shows receipt previews and audit metadata without hiding manual rows", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const getReceiptThumbnail = vi.fn().mockResolvedValue({
      filename: receipt.originalFilename,
      mimeType: receipt.mimeType,
      dataUrl: "blob:receipt-card",
      managedPath: "/managed/market.png",
    });
    const releaseReceiptThumbnail = vi.fn();
    vi.stubGlobal("receiptApp", {
      getReceiptThumbnail,
      releaseReceiptThumbnail,
    } as unknown as DesktopApi);
    const onOpenRow = vi.fn();
    const onSelectedRowsChange = vi.fn();
    const view = render(
      <ReceiptGallery
        activeRowId={null}
        checkIssuesByRow={new Map([[receiptRow.id, [issue]]])}
        invoiceId="invoice-1"
        receipts={[receipt]}
        resourceGeneration={1}
        rows={[receiptRow, manualRow]}
        selectedRows={new Set()}
        onOpenRow={onOpenRow}
        onSelectedRowsChange={onSelectedRowsChange}
      />
    );

    expect(screen.getByText("market.png")).toBeTruthy();
    expect(screen.getByText("Aug 20, 2026")).toBeTruthy();
    expect(screen.getByText("$12.50")).toBeTruthy();
    expect(screen.getByText("$67.50")).toBeTruthy();
    expect(screen.getByText("Manual invoice row")).toBeTruthy();
    expect(screen.getByText("Client meeting")).toBeTruthy();
    expect(screen.getByLabelText("1 unresolved review item")).toBeTruthy();

    await waitFor(() => {
      expect(view.container.querySelector('img[src="blob:receipt-card"]')).toBeTruthy();
    });
    expect(getReceiptThumbnail).toHaveBeenCalledWith("invoice-1", receipt.id);

    fireEvent.click(
      screen.getByRole("button", { name: "Open details for market.png, Aug 20, 2026" })
    );
    expect(onOpenRow).toHaveBeenCalledWith(receiptRow.id);

    fireEvent.click(screen.getByRole("checkbox", { name: "Select market.png" }));
    expect(onSelectedRowsChange).toHaveBeenCalledWith(new Set([receiptRow.id]));

    view.unmount();
    expect(releaseReceiptThumbnail).toHaveBeenCalledWith("invoice-1", receipt.id);
  });
});
