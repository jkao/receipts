import type { InvoiceCheckIssue, InvoiceCheckIssueCode } from "../../shared/types";

export type InvoiceCheckCategory = "duplicates" | "receipts" | "dates";

export interface InvoiceCheckIssueGroup {
  category: InvoiceCheckCategory;
  label: string;
  issues: InvoiceCheckIssue[];
}

const CATEGORY_BY_CODE: Record<InvoiceCheckIssueCode, InvoiceCheckCategory> = {
  "exact-receipt-duplicate": "duplicates",
  "likely-transaction-duplicate": "duplicates",
  "receipt-scan-not-ready": "receipts",
  "receipt-scan-warning": "receipts",
  "receipt-fields-incomplete": "receipts",
  "date-outside-period": "dates",
};

const CATEGORY_DETAILS: ReadonlyArray<{
  category: InvoiceCheckCategory;
  label: string;
}> = [
  { category: "duplicates", label: "Possible duplicates" },
  { category: "receipts", label: "Low-confidence / incomplete scans" },
  { category: "dates", label: "Dates" },
];

export function groupInvoiceCheckIssues(
  issues: readonly InvoiceCheckIssue[]
): InvoiceCheckIssueGroup[] {
  return CATEGORY_DETAILS.map(({ category, label }) => ({
    category,
    label,
    issues: issues.filter((issue) => CATEGORY_BY_CODE[issue.code] === category),
  })).filter((group) => group.issues.length > 0);
}

export function indexInvoiceCheckIssuesByRow(
  issues: readonly InvoiceCheckIssue[],
  rows: readonly { id: string; receiptId: string | null }[] = []
): Map<string, InvoiceCheckIssue[]> {
  const byRow = new Map<string, InvoiceCheckIssue[]>();
  const rowIdsByReceipt = new Map<string, string[]>();
  for (const row of rows) {
    if (!row.receiptId) continue;
    const rowIds = rowIdsByReceipt.get(row.receiptId);
    if (rowIds) rowIds.push(row.id);
    else rowIdsByReceipt.set(row.receiptId, [row.id]);
  }

  for (const issue of issues.filter(isUnresolvedReviewIssue)) {
    const affectedRowIds = new Set(issue.rowIds);
    for (const receiptId of issue.receiptIds) {
      for (const rowId of rowIdsByReceipt.get(receiptId) ?? []) affectedRowIds.add(rowId);
    }
    for (const rowId of affectedRowIds) {
      const rowIssues = byRow.get(rowId);
      if (rowIssues) rowIssues.push(issue);
      else byRow.set(rowId, [issue]);
    }
  }
  return byRow;
}

export function isReviewIssue(issue: InvoiceCheckIssue): boolean {
  return issue.acknowledgeable;
}

export function isUnresolvedReviewIssue(issue: InvoiceCheckIssue): boolean {
  return issue.acknowledgeable && issue.acknowledgedAt === null;
}

export function hasInvoiceCheckAttention(issues: readonly InvoiceCheckIssue[]): boolean {
  return issues.some((issue) => !issue.acknowledgeable || isUnresolvedReviewIssue(issue));
}

export function invoiceCheckIssueTitle(issues: readonly InvoiceCheckIssue[]): string | undefined {
  if (issues.length === 0) return undefined;
  const messages = [...new Set(issues.map((issue) => issue.message.trim()).filter(Boolean))];
  return `Review: ${messages.join(" ")}`;
}
