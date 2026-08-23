import type { ImportProgress } from "../../shared/types";

interface ImportProgressPanelProps {
  progress: ImportProgress;
  cancelling: boolean;
  onCancel: (jobId: string) => void;
}

export function importProgressLabel(status: ImportProgress["status"]): string {
  switch (status) {
    case "copying":
      return "Copying";
    case "duplicate":
      return "Checking duplicate";
    case "error":
      return "Import issue";
    case "queued":
      return "Waiting to scan";
    case "needs-key":
      return "Needs OpenAI key";
    case "needs-review":
      return "Scan needs review";
    case "ready":
      return "Receipt scanned";
    case "cancelled":
      return "Finishing cancellation";
    case "complete":
      return "Finishing scan";
    case "failed":
      return "Import failed";
    case "scanning":
      return "Scanning";
  }
}

export function ImportProgressPanel({ progress, cancelling, onCancel }: ImportProgressPanelProps) {
  const jobId = progress.jobId;
  const canCancel =
    Boolean(jobId) &&
    progress.status !== "complete" &&
    progress.status !== "cancelled" &&
    progress.status !== "failed";
  return (
    <section aria-label="Receipt import progress" className="import-progress">
      <div className="import-progress-copy" role="status" aria-live="polite">
        <span className="progress-spinner" aria-hidden="true" />
        <strong>{importProgressLabel(progress.status)}</strong>
        <span title={progress.filename}>{progress.filename}</span>
        <small>
          {Math.min(progress.current, progress.total)} of {progress.total}
        </small>
      </div>
      <progress
        aria-label="Receipt scan progress"
        max={Math.max(progress.total, 1)}
        value={Math.min(progress.current, progress.total)}
      />
      {canCancel && jobId ? (
        <button
          className="button button--secondary import-progress-cancel"
          disabled={cancelling}
          type="button"
          onClick={() => onCancel(jobId)}
        >
          {cancelling ? "Cancelling…" : "Cancel scan"}
        </button>
      ) : null}
    </section>
  );
}
