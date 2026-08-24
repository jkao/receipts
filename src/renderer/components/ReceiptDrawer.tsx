import { useCallback, useEffect, useId, useRef, useState } from "react";
import { normalizeHours } from "../../shared/finance";
import type {
  DesktopApi,
  InvoiceCheckIssue,
  InvoiceRow,
  ReceiptDebug,
  ReceiptPreview,
  ReceiptRecord,
} from "../../shared/types";
import {
  formatLongDate,
  formatMoney,
  labourMinor,
  messageFromError,
  minorToInput,
} from "../lib/format";
import {
  validateDateEditorInput,
  validateHoursEditorInput,
  validateMoneyEditorInput,
} from "../lib/gridEditorValidation";
import { receiptPreviewKind } from "../lib/receiptPreview";
import { ImageReceiptPreview } from "./ImageReceiptPreview";
import { ModalFrame } from "./ModalFrame";
import { ReviewChecklistItem } from "./ReviewChecklistItem";

interface ReceiptDrawerProps {
  invoiceId: string;
  resourceGeneration: number;
  row: InvoiceRow;
  receipt: ReceiptRecord | null;
  reviewDisabled: boolean;
  reviewIssues: readonly InvoiceCheckIssue[];
  updatingFingerprints: ReadonlySet<string>;
  rowNumber?: number;
  rowCount?: number;
  onClose: () => void;
  onNextRow?: () => void;
  onPreviousRow?: () => void;
  onRetry: (receiptId: string) => void;
  onRowChange: (row: InvoiceRow) => void;
  onToggleReview: (fingerprint: string, acknowledged: boolean) => void;
}

function valueOrDash(value: string | null | undefined): string {
  return value?.trim() || "—";
}

type ReceiptResourceApi = Pick<
  DesktopApi,
  "getReceiptPreview" | "releaseReceiptPreview" | "getReceiptDebug"
>;

interface ReceiptResourceCallbacks {
  onPreview: (preview: ReceiptPreview) => void;
  onPreviewError: (error: unknown) => void;
  onPreviewSettled: () => void;
  onDebug: (debug: ReceiptDebug | null) => void;
  onDebugError: (error: unknown) => void;
  onDebugSettled: () => void;
}

type EditableSummaryField = "date" | "groceriesMinor" | "hours" | "rateMinor";

function summaryInputValue(row: InvoiceRow, field: EditableSummaryField): string {
  if (field === "date") return row.date ?? "";
  if (field === "hours") return row.hours;
  return minorToInput(row[field]);
}

function summaryFieldError(field: EditableSummaryField, value: string): string | null {
  if (field === "date") return validateDateEditorInput(value).error;
  if (field === "hours") return validateHoursEditorInput(value).error;
  return validateMoneyEditorInput(
    value,
    field === "groceriesMinor" ? "Groceries amount" : "Hourly rate"
  ).error;
}

function rowWithSummaryDraft(
  row: InvoiceRow,
  field: EditableSummaryField,
  value: string
): InvoiceRow {
  if (field === "date") {
    return { ...row, date: validateDateEditorInput(value).value };
  }
  if (field === "hours") {
    return { ...row, hours: validateHoursEditorInput(value).value };
  }
  return {
    ...row,
    [field]: validateMoneyEditorInput(
      value,
      field === "groceriesMinor" ? "Groceries amount" : "Hourly rate"
    ).value,
  };
}

interface ReceiptRowSummaryProps {
  disabled: boolean;
  row: InvoiceRow;
  onRowChange: (row: InvoiceRow) => void;
}

function ReceiptRowSummary({ disabled, row, onRowChange }: ReceiptRowSummaryProps) {
  const [editingField, setEditingField] = useState<EditableSummaryField | null>(null);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const error = editingField ? summaryFieldError(editingField, draft) : null;
  const previewRow = editingField && !error ? rowWithSummaryDraft(row, editingField, draft) : row;

  useEffect(() => {
    if (!editingField) return;
    const input = inputRef.current;
    input?.focus();
    if (editingField === "date") {
      try {
        input?.showPicker?.();
      } catch {
        // Some browsers require the user to open the native picker from its indicator.
      }
    } else {
      input?.select();
    }
  }, [editingField]);

  useEffect(() => {
    inputRef.current?.setCustomValidity(error ?? "");
  }, [error]);

  const beginEdit = (field: EditableSummaryField) => {
    if (disabled) return;
    setDraft(summaryInputValue(row, field));
    setEditingField(field);
  };

  const cancelEdit = () => setEditingField(null);

  const commitEdit = () => {
    if (!editingField) return true;
    if (error) {
      inputRef.current?.reportValidity();
      return false;
    }

    const nextRow = rowWithSummaryDraft(row, editingField, draft);
    const changed =
      editingField === "hours"
        ? normalizeHours(nextRow.hours) !== normalizeHours(row.hours)
        : nextRow[editingField] !== row[editingField];
    if (changed) onRowChange(nextRow);
    setEditingField(null);
    return true;
  };

  const editor = (
    field: EditableSummaryField,
    label: string,
    options?: { money?: boolean; type?: "date" }
  ) =>
    editingField === field ? (
      <div
        className={`row-summary-editor${error ? " row-summary-editor--invalid" : ""}${options?.money ? " row-summary-editor--money" : ""}`}
        title={error ?? undefined}
      >
        {options?.money ? <span aria-hidden="true">$</span> : null}
        <input
          ref={inputRef}
          aria-invalid={error ? "true" : undefined}
          aria-label={label}
          inputMode={options?.type === "date" ? undefined : "decimal"}
          max={options?.type === "date" ? "9999-12-31" : undefined}
          min={options?.type === "date" ? "0001-01-01" : undefined}
          type={options?.type ?? "text"}
          value={draft}
          onBlur={() => commitEdit()}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              cancelEdit();
            } else if (event.key === "Enter") {
              event.preventDefault();
              commitEdit();
            }
          }}
        />
      </div>
    ) : (
      <button
        aria-label={`Edit ${label.toLowerCase()}`}
        className="row-summary-edit-button"
        disabled={disabled}
        title={disabled ? "Row editing is unavailable right now" : `Edit ${label.toLowerCase()}`}
        type="button"
        onClick={() => beginEdit(field)}
      >
        {field === "date"
          ? row.date
            ? formatLongDate(row.date)
            : "—"
          : field === "groceriesMinor"
            ? formatMoney(row.groceriesMinor) || "—"
            : field === "hours"
              ? row.hours || "—"
              : formatMoney(row.rateMinor) || "—"}
      </button>
    );

  return (
    <section className="row-summary-card" aria-label="Invoice row summary">
      <div>
        <span>Date</span>
        {editor("date", "Receipt date", { type: "date" })}
      </div>
      <div>
        <span>Groceries</span>
        {editor("groceriesMinor", "Groceries amount", { money: true })}
      </div>
      <div>
        <span>Hours</span>
        {editor("hours", "Hours worked")}
      </div>
      <div>
        <span>Rate</span>
        {editor("rateMinor", "Hourly rate", { money: true })}
      </div>
      <div>
        <span>Labour</span>
        <strong aria-live="polite">{formatMoney(labourMinor(previewRow))}</strong>
      </div>
    </section>
  );
}

/** Start the two independent modal reads and return their lifecycle cleanup. */
export function startReceiptResourceLoad(
  api: ReceiptResourceApi,
  invoiceId: string,
  receiptId: string,
  callbacks: ReceiptResourceCallbacks
): () => void {
  let active = true;
  void api
    .getReceiptPreview(invoiceId, receiptId)
    .then((preview) => {
      if (active) callbacks.onPreview(preview);
    })
    .catch((error) => {
      if (active) callbacks.onPreviewError(error);
    })
    .finally(() => {
      if (active) callbacks.onPreviewSettled();
    });
  void api
    .getReceiptDebug(invoiceId, receiptId)
    .then((debug) => {
      if (active) callbacks.onDebug(debug);
    })
    .catch((error) => {
      if (active) callbacks.onDebugError(error);
    })
    .finally(() => {
      if (active) callbacks.onDebugSettled();
    });

  return () => {
    active = false;
    api.releaseReceiptPreview();
  };
}

export function ReceiptDrawer({
  invoiceId,
  resourceGeneration,
  row,
  receipt,
  reviewDisabled,
  reviewIssues,
  updatingFingerprints,
  rowNumber = 1,
  rowCount = 1,
  onClose,
  onNextRow,
  onPreviousRow,
  onRetry,
  onRowChange,
  onToggleReview,
}: ReceiptDrawerProps) {
  const reviewTitleId = useId();
  const [loadedPreview, setPreview] = useState<ReceiptPreview | null>(null);
  const [loadedDebug, setDebug] = useState<ReceiptDebug | null>(null);
  const [loadedPreviewLoading, setPreviewLoading] = useState(false);
  const [loadedDebugLoading, setDebugLoading] = useState(false);
  const [loadedPreviewError, setPreviewError] = useState<string | null>(null);
  const [loadedDebugError, setDebugError] = useState<string | null>(null);
  const [loadedResourceKey, setLoadedResourceKey] = useState<string | null>(null);
  const unresolvedReviewCount = reviewIssues.filter(
    (issue) => issue.acknowledgedAt === null
  ).length;
  const receiptId = receipt?.id ?? null;
  const receiptStatus = receipt?.status ?? null;
  const resourceKey = `${invoiceId}:${resourceGeneration}:${receiptId ?? "manual"}:${receiptStatus ?? "none"}`;
  const resourcesAreCurrent = loadedResourceKey === resourceKey;
  const preview = resourcesAreCurrent ? loadedPreview : null;
  const debug = resourcesAreCurrent ? loadedDebug : null;
  const previewLoading = resourcesAreCurrent ? loadedPreviewLoading : Boolean(receiptId);
  const debugLoading = resourcesAreCurrent ? loadedDebugLoading : Boolean(receiptId);
  const previewError = resourcesAreCurrent ? loadedPreviewError : null;
  const debugError = resourcesAreCurrent ? loadedDebugError : null;
  const previewKind = preview ? receiptPreviewKind(preview) : null;

  const closeModal = useCallback(() => {
    window.receiptApp.releaseReceiptPreview();
    onClose();
  }, [onClose]);

  useEffect(() => {
    const handleRowNavigation = (event: globalThis.KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        (event.key !== "ArrowLeft" && event.key !== "ArrowRight")
      ) {
        return;
      }

      const target = event.target;
      if (
        target instanceof Element &&
        target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')
      ) {
        return;
      }

      const navigate = event.key === "ArrowLeft" ? onPreviousRow : onNextRow;
      if (!navigate) return;
      event.preventDefault();
      navigate();
    };

    window.addEventListener("keydown", handleRowNavigation);
    return () => window.removeEventListener("keydown", handleRowNavigation);
  }, [onNextRow, onPreviousRow]);

  useEffect(() => {
    setLoadedResourceKey(resourceKey);
    setPreview(null);
    setDebug(null);
    setPreviewError(null);
    setDebugError(null);
    setPreviewLoading(Boolean(receiptId));
    setDebugLoading(Boolean(receiptId));
    if (!receiptId || !receiptStatus) {
      window.receiptApp.releaseReceiptPreview();
      return;
    }

    return startReceiptResourceLoad(window.receiptApp, invoiceId, receiptId, {
      onPreview: setPreview,
      onPreviewError: (error) => setPreviewError(messageFromError(error)),
      onPreviewSettled: () => setPreviewLoading(false),
      onDebug: setDebug,
      onDebugError: (error) => setDebugError(messageFromError(error)),
      onDebugSettled: () => setDebugLoading(false),
    });
  }, [invoiceId, receiptId, receiptStatus, resourceKey]);

  const reviewChecklist =
    reviewIssues.length > 0 ? (
      <section className="drawer-review-checklist" aria-labelledby={reviewTitleId}>
        <div className="section-heading-line">
          <h3 id={reviewTitleId}>Review checklist</h3>
          <strong>
            {unresolvedReviewCount === 0 ? "Complete" : `${unresolvedReviewCount} remaining`}
          </strong>
        </div>
        <p>Advisory only. Check an item after verifying this row; no invoice values will change.</p>
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
    ) : null;

  return (
    <ModalFrame
      className="receipt-modal"
      eyebrow="Receipt details"
      headerActions={
        <fieldset className="receipt-modal-navigation">
          <legend className="sr-only">Navigate invoice rows</legend>
          <button
            aria-label="Previous invoice row"
            aria-keyshortcuts="ArrowLeft"
            className="icon-button receipt-modal-nav-button"
            disabled={!onPreviousRow}
            title="Previous invoice row (Left Arrow)"
            type="button"
            onClick={onPreviousRow}
          >
            ←
          </button>
          <output aria-live="polite">
            {rowNumber} of {rowCount}
          </output>
          <button
            aria-label="Next invoice row"
            aria-keyshortcuts="ArrowRight"
            className="icon-button receipt-modal-nav-button"
            disabled={!onNextRow}
            title="Next invoice row (Right Arrow)"
            type="button"
            onClick={onNextRow}
          >
            →
          </button>
        </fieldset>
      }
      title={receipt?.originalFilename ?? "Manual row"}
      onClose={closeModal}
    >
      <div className="receipt-modal-content">
        <div className="receipt-modal-overview">
          <ReceiptRowSummary
            key={row.id}
            disabled={reviewDisabled}
            row={row}
            onRowChange={onRowChange}
          />

          {receipt ? (
            <>
              <div className="receipt-meta-line">
                <span className={`status-pill status-pill--${receipt.status}`}>
                  {receipt.status.replaceAll("-", " ")}
                </span>
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
            </>
          ) : null}
        </div>

        {!receipt ? (
          <div className="receipt-modal-manual">
            {reviewChecklist}
            <div className="drawer-empty">
              <span className="drawer-empty-icon" aria-hidden="true">
                ✎
              </span>
              <h3>Manual invoice row</h3>
              <p>This row is not linked to a receipt. Edit it directly in the table.</p>
            </div>
          </div>
        ) : (
          <div className="receipt-modal-columns">
            <div className="receipt-modal-preview-pane">
              <section className="drawer-section receipt-source-section">
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
                      window.receiptApp.releaseReceiptPreview();
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
                    {previewError ? (
                      <div className="preview-placeholder">{previewError}</div>
                    ) : null}
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
            </div>

            <div className="receipt-modal-details-pane">
              {reviewChecklist}
              <section className="drawer-section receipt-itemization-section">
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
            </div>
          </div>
        )}
      </div>
    </ModalFrame>
  );
}
