import { describe, expect, it } from "vitest";
import type { InvoiceCheckIssue } from "../../shared/types";
import {
  groupInvoiceCheckIssues,
  hasInvoiceCheckAttention,
  indexInvoiceCheckIssuesByRow,
  invoiceCheckIssueTitle,
} from "./invoiceCheck";

const issues: InvoiceCheckIssue[] = [
  {
    fingerprint: "duplicate",
    acknowledgeable: true,
    acknowledgedAt: null,
    code: "likely-transaction-duplicate",
    message: "These transactions may be duplicates.",
    rowIds: ["receipt-row", "manual-row", "manual-row"],
    receiptIds: ["receipt-1"],
  },
  {
    fingerprint: "date",
    acknowledgeable: true,
    acknowledgedAt: null,
    code: "date-outside-period",
    message: "The date is outside this invoice period.",
    rowIds: ["manual-row"],
    receiptIds: [],
  },
];

describe("invoice check presentation", () => {
  it("groups findings into stable user-facing categories", () => {
    expect(
      groupInvoiceCheckIssues(issues).map((group) => [group.label, group.issues.length])
    ).toEqual([
      ["Possible duplicates", 1],
      ["Dates", 1],
    ]);
  });

  it("groups acknowledgeable scan warnings with incomplete scans", () => {
    const scanWarning: InvoiceCheckIssue = {
      fingerprint: "scan-warning",
      acknowledgeable: true,
      acknowledgedAt: null,
      code: "receipt-scan-warning",
      message: "Verify the extracted total.",
      rowIds: ["receipt-row"],
      receiptIds: ["receipt-1"],
    };

    expect(groupInvoiceCheckIssues([scanWarning]).map((group) => group.label)).toEqual([
      "Low-confidence / incomplete scans",
    ]);
  });

  it("indexes every affected row, including rows without receipts", () => {
    const byRow = indexInvoiceCheckIssuesByRow(issues);
    expect(byRow.get("receipt-row")).toEqual([issues[0]]);
    expect(byRow.get("manual-row")).toEqual(issues);
  });

  it("builds a concise warning title without repeating messages", () => {
    expect(invoiceCheckIssueTitle([issues[0], issues[0]])).toBe(
      "Review: These transactions may be duplicates."
    );
    expect(invoiceCheckIssueTitle([])).toBeUndefined();
  });

  it("only treats unresolved or operational findings as needing attention", () => {
    const acknowledged = {
      ...issues[0],
      acknowledgedAt: "2026-01-01T00:00:00.000Z",
    };
    const operational = {
      ...issues[0],
      fingerprint: "operational",
      acknowledgeable: false,
    };

    expect(hasInvoiceCheckAttention([])).toBe(false);
    expect(hasInvoiceCheckAttention([acknowledged])).toBe(false);
    expect(hasInvoiceCheckAttention(issues)).toBe(true);
    expect(hasInvoiceCheckAttention([operational])).toBe(true);
  });

  it("indexes only unresolved advisory findings and links receipt-only findings", () => {
    const acknowledged = {
      ...issues[1],
      fingerprint: "done",
      acknowledgedAt: "2026-01-01T00:00:00.000Z",
    };
    const operational: InvoiceCheckIssue = {
      fingerprint: "scan-error",
      acknowledgeable: false,
      acknowledgedAt: null,
      code: "receipt-scan-not-ready",
      message: "Scan failed.",
      rowIds: ["operational-row"],
      receiptIds: ["receipt-2"],
    };
    const receiptOnly: InvoiceCheckIssue = {
      ...issues[0],
      fingerprint: "receipt-only",
      rowIds: [],
      receiptIds: ["receipt-1"],
    };

    const byRow = indexInvoiceCheckIssuesByRow(
      [acknowledged, operational, receiptOnly],
      [{ id: "linked-row", receiptId: "receipt-1" }]
    );
    expect([...byRow.keys()]).toEqual(["linked-row"]);
    expect(byRow.get("linked-row")).toEqual([receiptOnly]);
  });
});
