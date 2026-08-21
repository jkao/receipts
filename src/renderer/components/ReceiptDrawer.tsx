import { useEffect, useId, useRef, useState } from "react";
import type {
  InvoiceCheckIssue,
  InvoiceRow,
  ReceiptDebug,
  ReceiptPreview,
  ReceiptRecord,
} from "../../shared/types";
import { formatLongDate, formatMoney, labourMinor, messageFromError } from "../lib/format";
import { receiptPreviewKind } from "../lib/receiptPreview";
import { ImageReceiptPreview } from "./ImageReceiptPreview";
import { ReviewChecklistItem } from "./ReviewChecklistItem";

interface ReceiptDrawerProps {
  invoiceId: string;
  row: InvoiceRow;
  receipt: ReceiptRecord | null;
  reviewDisabled: boolean;
  reviewIssues: readonly InvoiceCheckIssue[];
  updatingFingerprints: ReadonlySet<string>;
  onClose: () => void;
  onRetry: (receiptId: string) => void;
  onToggleReview: (fingerprint: string, acknowledged: boolean) => void;
}

function valueOrDash(value: string | null | undefined): string {
  return value?.trim() || "—";
}

export function ReceiptDrawer({
  invoiceId,
  row,
  receipt,
  reviewDisabled,
  reviewIssues,
  updatingFingerprints,
  onClose,
  onRetry,
  onToggleReview,
}: ReceiptDrawerProps) {
  const reviewTitleId = useId();
  const drawerTitleId = useId();
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  const [preview, setPreview] = useState<ReceiptPreview | null>(null);
  const [debug, setDebug] = useState<ReceiptDebug | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [debugLoading, setDebugLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [debugError, setDebugError] = useState<string | null>(null);
  const unresolvedReviewCount = reviewIssues.filter(
    (issue) => issue.acknowledgedAt === null
  ).length;
  const previewKind = preview ? receiptPreviewKind(preview) : null;
  const receiptId = receipt?.id ?? null;
  const receiptStatus = receipt?.status ?? null;

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButtonRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        document.querySelector('[role="dialog"][aria-modal="true"]')
      ) {
        return;
      }
      event.preventDefault();
      onCloseRef.current();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      previouslyFocused?.focus();
    };
  }, []);

  useEffect(() => {
    setPreview(null);
    setDebug(null);
    setPreviewError(null);
    setDebugError(null);
    setPreviewLoading(Boolean(receiptId));
    setDebugLoading(Boolean(receiptId));
    if (!receiptId || !receiptStatus) return;

    let cancelled = false;
    void window.receiptApp
      .getReceiptPreview(invoiceId, receiptId)
      .then((result) => {
        if (cancelled) return;
        setPreview(result);
      })
      .catch((error) => {
        if (!cancelled) setPreviewError(messageFromError(error));
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false);
      });
    void window.receiptApp
      .getReceiptDebug(invoiceId, receiptId)
      .then((result) => {
        if (!cancelled) setDebug(result);
      })
      .catch((error) => {
        if (!cancelled) setDebugError(messageFromError(error));
      })
      .finally(() => {
        if (!cancelled) setDebugLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [invoiceId, receiptId, receiptStatus]);

  return (
    <aside aria-labelledby={drawerTitleId} className="receipt-drawer">
      <header className="drawer-header">
        <div>
          <p className="eyebrow">Row details</p>
          <h2 id={drawerTitleId}>{receipt?.originalFilename ?? "Manual row"}</h2>
        </div>
        <button
          ref={closeButtonRef}
          aria-label="Close row details"
          className="icon-button"
          type="button"
          onClick={onClose}
        >
          ×
        </button>
      </header>

      <div className="drawer-scroll">
        <section className="row-summary-card" aria-label="Invoice row summary">
          <div>
            <span>Date</span>
            <strong>{row.date ? formatLongDate(row.date) : "—"}</strong>
          </div>
          <div>
            <span>Groceries</span>
            <strong>{formatMoney(row.groceriesMinor) || "—"}</strong>
          </div>
          <div>
            <span>Hours</span>
            <strong>{row.hours || "—"}</strong>
          </div>
          <div>
            <span>Labour</span>
            <strong>{formatMoney(labourMinor(row))}</strong>
          </div>
        </section>

        {reviewIssues.length > 0 ? (
          <section className="drawer-review-checklist" aria-labelledby={reviewTitleId}>
            <div className="section-heading-line">
              <h3 id={reviewTitleId}>Review checklist</h3>
              <strong>
                {unresolvedReviewCount === 0 ? "Complete" : `${unresolvedReviewCount} remaining`}
              </strong>
            </div>
            <p>
              Advisory only. Check an item after verifying this row; no invoice values will change.
            </p>
            <div className="review-check-list">
              {reviewIssues.map((issue) => (
                <ReviewChecklistItem
                  disabled={reviewDisabled || updatingFingerprints.has(issue.fingerprint)}
                  issue={issue}
                  key={issue.fingerprint}
                  onToggle={onToggleReview}
                />
              ))}
            </div>
          </section>
        ) : null}

        {!receipt ? (
          <div className="drawer-empty">
            <span className="drawer-empty-icon" aria-hidden="true">
              ✎
            </span>
            <h3>Manual invoice row</h3>
            <p>This row is not linked to a receipt. Edit it directly in the table.</p>
          </div>
        ) : (
          <>
            <div className="receipt-meta-line">
              {receipt.status !== "needs-review" ? (
                <span className={`status-pill status-pill--${receipt.status}`}>
                  {receipt.status.replaceAll("-", " ")}
                </span>
              ) : null}
              <span>
                {receipt.source.kind === "manual" ? "Manual" : "Automation"}
                {" · "}
                {receipt.source.method.replaceAll("-", " ")}
              </span>
              <span>{receipt.mimeType}</span>
              {receipt.status !== "ready" && (
                <button
                  className="text-button"
                  disabled={reviewDisabled}
                  type="button"
                  onClick={() => onRetry(receipt.id)}
                >
                  {receipt.status === "needs-review" ? "Rescan receipt" : "Retry scan"}
                </button>
              )}
            </div>

            {receipt.error ? <div className="inline-error">{receipt.error}</div> : null}

            <section className="drawer-section">
              <h3>Receipt</h3>
              {previewKind === "pdf" && preview ? (
                <div className="receipt-preview">
                  <object
                    aria-label={`Preview of ${preview.filename}`}
                    data={preview.dataUrl}
                    type="application/pdf"
                  >
                    <p className="preview-placeholder">PDF preview is unavailable.</p>
                  </object>
                </div>
              ) : previewKind === "image" && preview ? (
                <ImageReceiptPreview
                  alt={`Receipt ${preview.filename}`}
                  filename={preview.filename}
                  src={preview.dataUrl}
                  onError={() => {
                    setPreview(null);
                    setPreviewError("This receipt preview could not be displayed.");
                  }}
                />
              ) : preview ? (
                <div className="receipt-preview">
                  <div className="preview-placeholder">
                    Preview is unavailable for {preview.mimeType || "this file type"}.
                  </div>
                </div>
              ) : (
                <div className="receipt-preview">
                  {previewLoading ? (
                    <div className="preview-placeholder">Loading preview…</div>
                  ) : null}
                  {previewError ? <div className="preview-placeholder">{previewError}</div> : null}
                  {!previewLoading && !previewError ? (
                    <div className="preview-placeholder">Preview unavailable.</div>
                  ) : null}
                </div>
              )}
            </section>

            <label className="receipt-managed-path">
              <span>
                {preview?.managedPath ? "Managed file path" : "Managed file (relative path)"}
              </span>
              <input
                aria-label={
                  preview?.managedPath
                    ? "Managed receipt file path"
                    : "Managed receipt relative file path"
                }
                readOnly
                spellCheck={false}
                title={preview?.managedPath ?? receipt.relativePath}
                value={preview?.managedPath ?? receipt.relativePath}
                onFocus={(event) => event.currentTarget.select()}
              />
            </label>

            <section className="drawer-section">
              <div className="section-heading-line">
                <h3>Itemization</h3>
                {debug?.extraction.total ? <strong>{debug.extraction.total}</strong> : null}
              </div>

              {!debug ? (
                debugError ? (
                  <p className="inline-error">Scan details could not be loaded: {debugError}</p>
                ) : debugLoading ? (
                  <p className="muted-copy">Loading scan details…</p>
                ) : (
                  <p className="muted-copy">
                    {receipt.status === "scanning" || receipt.status === "queued"
                      ? "Scanning and extracting receipt details…"
                      : "No extraction details are available yet."}
                  </p>
                )
              ) : (
                <>
                  <dl className="extraction-facts">
                    <div>
                      <dt>Merchant</dt>
                      <dd>{valueOrDash(debug.extraction.merchant)}</dd>
                    </div>
                    <div>
                      <dt>Receipt date</dt>
                      <dd>{valueOrDash(debug.extraction.date)}</dd>
                    </div>
                    <div>
                      <dt>Subtotal</dt>
                      <dd>{valueOrDash(debug.extraction.subtotal)}</dd>
                    </div>
                    <div>
                      <dt>Tax</dt>
                      <dd>{valueOrDash(debug.extraction.tax)}</dd>
                    </div>
                  </dl>

                  {debug.extraction.items.length > 0 ? (
                    <div className="items-table-wrap">
                      <table className="items-table">
                        <thead>
                          <tr>
                            <th>Item</th>
                            <th>Qty</th>
                            <th>Total</th>
                          </tr>
                        </thead>
                        <tbody>
                          {debug.extraction.items.map((item, index) => (
                            // biome-ignore lint/suspicious/noArrayIndexKey: Extraction items are immutable and have no source IDs; the index disambiguates identical lines.
                            <tr key={`${item.description ?? "item"}-${index}`}>
                              <td>{valueOrDash(item.description)}</td>
                              <td>{valueOrDash(item.quantity)}</td>
                              <td>{valueOrDash(item.lineTotal)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="muted-copy">No line items were found.</p>
                  )}

                  {debug.extraction.adjustments.length > 0 ? (
                    <div className="adjustments-list">
                      {debug.extraction.adjustments.map((adjustment, index) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: Extraction adjustments are immutable and have no source IDs; the index disambiguates identical lines.
                        <div key={`${adjustment.description ?? "adjustment"}-${index}`}>
                          <span>{valueOrDash(adjustment.description)}</span>
                          <span>{valueOrDash(adjustment.amount)}</span>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </>
              )}
            </section>

            {debug ? (
              <details className="debug-details">
                <summary>Scan details</summary>
                <dl>
                  <div>
                    <dt>Model</dt>
                    <dd>{debug.model}</dd>
                  </div>
                  <div>
                    <dt>Scanned</dt>
                    <dd>{new Date(debug.scannedAt).toLocaleString()}</dd>
                  </div>
                  {debug.usage.totalTokens != null ? (
                    <div>
                      <dt>Tokens</dt>
                      <dd>{debug.usage.totalTokens.toLocaleString()}</dd>
                    </div>
                  ) : null}
                </dl>
                {debug.validationWarnings.length > 0 ? (
                  <div className="validation-warnings">
                    <strong>Validation warnings</strong>
                    <ul>
                      {debug.validationWarnings.map((warning) => (
                        <li key={warning}>{warning}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </details>
            ) : null}
          </>
        )}
      </div>
    </aside>
  );
}
