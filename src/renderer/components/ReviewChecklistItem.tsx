import type { InvoiceCheckIssue } from "../../shared/types";

interface ReviewChecklistItemProps {
  issue: InvoiceCheckIssue;
  disabled: boolean;
  meta?: string;
  onToggle: (fingerprint: string, acknowledged: boolean) => void;
}

export function ReviewChecklistItem({ issue, disabled, meta, onToggle }: ReviewChecklistItemProps) {
  const acknowledged = issue.acknowledgedAt !== null;

  return (
    <label className={`review-check-item${acknowledged ? " review-check-item--done" : ""}`}>
      <input
        aria-label={`${acknowledged ? "Reopen" : "Mark reviewed"}: ${issue.message}`}
        checked={acknowledged}
        disabled={disabled || !issue.acknowledgeable}
        type="checkbox"
        onChange={(event) => onToggle(issue.fingerprint, event.currentTarget.checked)}
      />
      <span className="review-check-copy">
        <span>{issue.message}</span>
        {meta ? <small>{meta}</small> : null}
      </span>
    </label>
  );
}
