import { useId, useMemo } from "react";
import type { InvoiceCheckIssue, InvoiceCheckResult } from "../../shared/types";
import {
  groupInvoiceCheckIssues,
  hasInvoiceCheckAttention,
  isReviewIssue,
  isUnresolvedReviewIssue,
} from "../lib/invoiceCheck";
import { ReviewChecklistItem } from "./ReviewChecklistItem";

interface InvoiceCheckSummaryProps {
  disabled: boolean;
  result: InvoiceCheckResult;
  updatingFingerprints: ReadonlySet<string>;
  onDismiss: () => void;
  onToggle: (fingerprint: string, acknowledged: boolean) => void;
}

function affectedRowCount(issues: readonly InvoiceCheckIssue[]): number {
  return new Set(issues.flatMap((issue) => issue.rowIds)).size;
}

export function InvoiceCheckSummary({
  disabled,
  result,
  updatingFingerprints,
  onDismiss,
  onToggle,
}: InvoiceCheckSummaryProps) {
  const titleId = useId();
  const reviewIssues = useMemo(() => result.issues.filter(isReviewIssue), [result.issues]);
  const unresolvedIssues = useMemo(
    () => reviewIssues.filter(isUnresolvedReviewIssue),
    [reviewIssues]
  );
  const operationalIssues = useMemo(
    () => result.issues.filter((issue) => !issue.acknowledgeable),
    [result.issues]
  );
  const groups = useMemo(() => groupInvoiceCheckIssues(reviewIssues), [reviewIssues]);
  const rowCount = affectedRowCount(unresolvedIssues);
  const unlinkedIssueCount = unresolvedIssues.filter((issue) => issue.rowIds.length === 0).length;
  const needsAttention = hasInvoiceCheckAttention(result.issues);

  const affectedRowsCopy =
    rowCount === 0
      ? unresolvedIssues.length > 0
        ? "These remaining items are not attached to a visible row. "
        : ""
      : `${rowCount} ${rowCount === 1 ? "row is" : "rows are"} highlighted below. ${
          unlinkedIssueCount > 0
            ? `${unlinkedIssueCount} additional ${unlinkedIssueCount === 1 ? "item is" : "items are"} not attached to a visible row. `
            : ""
        }`;

  return (
    <section
      aria-labelledby={titleId}
      className={`invoice-check${needsAttention ? " invoice-check--warning" : " invoice-check--clear"}`}
    >
      <span className="invoice-check-icon" aria-hidden="true">
        {needsAttention ? "!" : "✓"}
      </span>
      <div className="invoice-check-content">
        <div className="invoice-check-heading">
          <div>
            <h2 id={titleId}>
              {unresolvedIssues.length > 0
                ? `${unresolvedIssues.length} review ${unresolvedIssues.length === 1 ? "item" : "items"} remaining`
                : reviewIssues.length > 0
                  ? "Review checklist complete"
                  : operationalIssues.length > 0
                    ? "No review checklist items"
                    : "Invoice check found no issues"}
            </h2>
            <p role="status">
              {affectedRowsCopy}
              {reviewIssues.length > unresolvedIssues.length
                ? "Checked items remain listed but are no longer highlighted. "
                : ""}
              Review is advisory only; checking an item does not change table or export data.
            </p>
          </div>
          <button className="text-button" disabled={disabled} type="button" onClick={onDismiss}>
            Dismiss
          </button>
        </div>

        {groups.length > 0 ? (
          <div className="invoice-check-groups">
            {groups.map((group) => {
              const remaining = group.issues.filter(isUnresolvedReviewIssue).length;
              return (
                <div className="invoice-check-group" key={group.category}>
                  <h3>
                    {group.label}
                    <span className="invoice-check-count">
                      <span aria-hidden="true">
                        {remaining}/{group.issues.length}
                      </span>
                      <span className="sr-only">
                        {remaining} of {group.issues.length} remaining
                      </span>
                    </span>
                  </h3>
                  <div className="review-check-list">
                    {group.issues.map((issue) => {
                      const rows = new Set(issue.rowIds).size;
                      return (
                        <ReviewChecklistItem
                          disabled={disabled || updatingFingerprints.has(issue.fingerprint)}
                          issue={issue}
                          key={issue.fingerprint}
                          meta={rows > 0 ? `${rows} ${rows === 1 ? "row" : "rows"}` : undefined}
                          onToggle={onToggle}
                        />
                      );
                    })}
                  </div>
                  {group.category === "receipts" ? (
                    <p className="invoice-check-note">
                      Based on scan status, scan warnings, and missing fields—not a probability
                      score.
                    </p>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : null}

        {operationalIssues.length > 0 ? (
          <div className="invoice-check-operational">
            <strong>Scan status</strong>
            <ul>
              {operationalIssues.map((issue) => (
                <li key={issue.fingerprint}>{issue.message}</li>
              ))}
            </ul>
            <small>
              These are scan statuses, not checklist items. Retry when extracted details are needed;
              building output remains available.
            </small>
          </div>
        ) : null}
      </div>
    </section>
  );
}
