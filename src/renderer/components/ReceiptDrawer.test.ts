import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { InvoiceCheckIssue, InvoiceRow } from "../../shared/types";
import { ReceiptDrawer } from "./ReceiptDrawer";

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

describe("ReceiptDrawer", () => {
  it("shows the same review checklist for a manual row without requiring receipt APIs", () => {
    const markup = renderToStaticMarkup(
      createElement(ReceiptDrawer, {
        invoiceId: "invoice-1",
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
});
