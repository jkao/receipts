import { appErrorCode } from "../../shared/app-error";
import type { SaveStatus } from "../hooks/useInvoiceAutosave";

interface SaveIndicatorProps {
  status: SaveStatus;
  error: string | null;
  onRetry: () => void;
  onReload: () => void;
}

export function SaveIndicator({ status, error, onRetry, onReload }: SaveIndicatorProps) {
  if (status === "error") {
    const isRevisionConflict = appErrorCode(error) === "REVISION_CONFLICT";
    return (
      <span className="save-indicator save-indicator--error" title={error ?? undefined}>
        <span role="alert">
          <span aria-hidden="true">!</span>
          {isRevisionConflict ? "Invoice changed on disk" : "Save failed"}
        </span>
        <button
          className="save-indicator-action"
          type="button"
          onClick={isRevisionConflict ? onReload : onRetry}
        >
          {isRevisionConflict ? "Reload…" : "Retry"}
        </button>
      </span>
    );
  }
  return (
    <span className={`save-indicator save-indicator--${status}`} role="status">
      <span aria-hidden="true">{status === "saved" ? "✓" : "●"}</span>
      {status === "saving" ? "Saving…" : status === "dirty" ? "Unsaved changes" : "Saved locally"}
    </span>
  );
}
