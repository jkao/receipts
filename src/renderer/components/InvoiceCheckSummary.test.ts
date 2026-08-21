import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { InvoiceCheckIssue, InvoiceCheckResult } from "../../shared/types";
import { InvoiceCheckSummary } from "./InvoiceCheckSummary";

function issue(overrides: Partial<InvoiceCheckIssue>): InvoiceCheckIssue {
  return {
    fingerprint: "finding",
    acknowledgeable: true,
    acknowledgedAt: null,
    code: "date-outside-period",
    message: "Verify this date.",
    rowIds: ["row-1"],
    receiptIds: [],
    ...overrides,
  };
}

function result(issues: InvoiceCheckIssue[]): InvoiceCheckResult {
  return {
    invoiceId: "invoice-1",
    revision: 4,
    checkedAt: "2026-08-21T12:00:00.000Z",
    issues,
  };
}

describe("InvoiceCheckSummary", () => {
  it("keeps acknowledged findings visible without counting them as unresolved", () => {
    const markup = renderToStaticMarkup(
      createElement(InvoiceCheckSummary, {
        disabled: false,
        result: result([
          issue({ fingerprint: "open" }),
          issue({
            fingerprint: "done",
            acknowledgedAt: "2026-08-21T12:05:00.000Z",
            message: "Already verified.",
          }),
        ]),
        updatingFingerprints: new Set<string>(),
        onDismiss: vi.fn(),
        onToggle: vi.fn(),
      })
    );

    expect(markup).toContain("1 review item remaining");
    expect(markup).toContain("1 of 2 remaining");
    expect(markup).toContain("Already verified.");
    expect(markup).toMatch(/aria-label="Reopen: Already verified\."[^>]*checked=""/);
    expect(markup).toMatch(/aria-label="Mark reviewed: Verify this date\."/);
  });

  it("renders operational scan errors separately and disables dismissal while busy", () => {
    const markup = renderToStaticMarkup(
      createElement(InvoiceCheckSummary, {
        disabled: true,
        result: result([
          issue({
            fingerprint: "scan-error",
            acknowledgeable: false,
            code: "receipt-scan-not-ready",
            message: "The receipt scan failed.",
          }),
        ]),
        updatingFingerprints: new Set<string>(),
        onDismiss: vi.fn(),
        onToggle: vi.fn(),
      })
    );

    expect(markup).toContain("The receipt scan failed.");
    expect(markup).toContain("These are scan statuses, not checklist items.");
    expect(markup).not.toContain('type="checkbox"');
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Dismiss<\/button>/);
  });
});
