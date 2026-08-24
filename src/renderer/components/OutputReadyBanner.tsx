import { useId } from "react";
import type { InvoiceOutputResult } from "../../shared/types";

interface OutputReadyBannerProps {
  result: InvoiceOutputResult;
  disabled: boolean;
  revealing: boolean;
  onDismiss: () => void;
  onReveal: () => void;
}

export function OutputReadyBanner({
  result,
  disabled,
  revealing,
  onDismiss,
  onReveal,
}: OutputReadyBannerProps) {
  const titleId = useId();

  return (
    <section aria-labelledby={titleId} className="output-ready">
      <span className="output-ready-icon" aria-hidden="true">
        ✓
      </span>
      <div className="output-ready-content">
        <div className="output-ready-heading">
          <div>
            <h2 id={titleId}>Output ready</h2>
            <p role="status">
              Built the invoice PDF, ZIP archive, and {result.receiptCount} unique receipt file
              {result.receiptCount === 1 ? "" : "s"}. Any previous output was replaced.
            </p>
          </div>
          <div className="output-ready-actions">
            <button
              className="button button--secondary"
              disabled={disabled}
              type="button"
              onClick={onReveal}
            >
              {revealing ? "Opening…" : "Show in Finder"}
            </button>
            <button className="text-button" disabled={disabled} type="button" onClick={onDismiss}>
              Dismiss
            </button>
          </div>
        </div>
        <label className="output-ready-path">
          <span>Output folder</span>
          <input
            aria-label="Output folder path"
            readOnly
            spellCheck={false}
            title={result.outputPath}
            value={result.outputPath}
            onFocus={(event) => event.currentTarget.select()}
          />
        </label>
      </div>
    </section>
  );
}
