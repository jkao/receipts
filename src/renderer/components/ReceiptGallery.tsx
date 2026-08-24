import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type {
  InvoiceCheckIssue,
  InvoiceRow,
  ReceiptPreview,
  ReceiptRecord,
} from "../../shared/types";
import { formatLongDate, formatMoney, labourMinor, messageFromError } from "../lib/format";
import { invoiceCheckIssueTitle } from "../lib/invoiceCheck";
import { receiptPreviewKind } from "../lib/receiptPreview";

const EMPTY_CHECK_ISSUES = new Map<string, readonly InvoiceCheckIssue[]>();

interface ReceiptGalleryProps {
  invoiceId: string;
  resourceGeneration: number;
  rows: InvoiceRow[];
  receipts: ReceiptRecord[];
  disabled?: boolean;
  selectedRows: ReadonlySet<string>;
  activeRowId: string | null;
  checkIssuesByRow?: ReadonlyMap<string, readonly InvoiceCheckIssue[]>;
  onSelectedRowsChange: (rows: Set<string>) => void;
  onOpenRow: (rowId: string) => void;
}

interface ReceiptThumbnailProps {
  invoiceId: string;
  receipt: ReceiptRecord;
}

function ReceiptThumbnail({ invoiceId, receipt }: ReceiptThumbnailProps) {
  const thumbnailRef = useRef<HTMLDivElement>(null);
  const [shouldLoad, setShouldLoad] = useState(() => typeof IntersectionObserver === "undefined");
  const [preview, setPreview] = useState<ReceiptPreview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") {
      setShouldLoad(true);
      return;
    }
    const thumbnail = thumbnailRef.current;
    if (!thumbnail) return;
    const observer = new IntersectionObserver(
      (entries) => setShouldLoad(entries.some((entry) => entry.isIntersecting)),
      { rootMargin: "480px 0px" }
    );
    observer.observe(thumbnail);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!shouldLoad) {
      setPreview(null);
      setError(null);
      return;
    }
    let active = true;
    setPreview(null);
    setError(null);
    void window.receiptApp
      .getReceiptThumbnail(invoiceId, receipt.id)
      .then((loadedPreview) => {
        if (active) setPreview(loadedPreview);
      })
      .catch((loadError) => {
        if (active) setError(messageFromError(loadError));
      });

    return () => {
      active = false;
      window.receiptApp.releaseReceiptThumbnail(invoiceId, receipt.id);
    };
  }, [invoiceId, receipt.id, shouldLoad]);

  let contents: ReactNode;
  if (!preview) {
    contents = (
      <div className="receipt-gallery-placeholder">
        <span aria-hidden="true" className="receipt-gallery-placeholder-icon">
          {error ? "!" : "···"}
        </span>
        <small>
          {error ? "Preview unavailable" : shouldLoad ? "Loading receipt…" : "Receipt preview"}
        </small>
      </div>
    );
  } else if (receiptPreviewKind(preview) === "image") {
    contents = (
      <img
        alt=""
        loading="lazy"
        src={preview.dataUrl}
        onError={() => {
          window.receiptApp.releaseReceiptThumbnail(invoiceId, receipt.id);
          setPreview(null);
          setError("This receipt preview could not be displayed.");
        }}
      />
    );
  } else if (receiptPreviewKind(preview) === "pdf") {
    contents = (
      <object aria-hidden="true" data={preview.dataUrl} tabIndex={-1} type="application/pdf">
        <div className="receipt-gallery-placeholder">
          <span aria-hidden="true" className="receipt-gallery-placeholder-icon">
            PDF
          </span>
          <small>Open to preview</small>
        </div>
      </object>
    );
  } else {
    contents = (
      <div className="receipt-gallery-placeholder">
        <span aria-hidden="true" className="receipt-gallery-placeholder-icon">
          ▧
        </span>
        <small>Open to preview</small>
      </div>
    );
  }

  return (
    <div ref={thumbnailRef} className="receipt-gallery-thumbnail">
      {contents}
    </div>
  );
}

function receiptStatusLabel(status: ReceiptRecord["status"]): string {
  switch (status) {
    case "needs-key":
      return "Needs key";
    case "needs-review":
      return "Needs review";
    case "queued":
    case "scanning":
      return "Scanning";
    case "error":
      return "Scan error";
    case "ready":
      return "Ready";
  }
}

export function ReceiptGallery({
  invoiceId,
  resourceGeneration,
  rows,
  receipts,
  disabled = false,
  selectedRows,
  activeRowId,
  checkIssuesByRow = EMPTY_CHECK_ISSUES,
  onSelectedRowsChange,
  onOpenRow,
}: ReceiptGalleryProps) {
  const receiptById = useMemo(
    () => new Map(receipts.map((receipt) => [receipt.id, receipt])),
    [receipts]
  );

  if (rows.length === 0) {
    return (
      <div className="receipt-gallery-empty">
        <span aria-hidden="true" className="receipt-gallery-empty-icon">
          ▧
        </span>
        <strong>No receipts yet</strong>
        <p>Add receipt files or a manual row to start this invoice.</p>
      </div>
    );
  }

  return (
    <section
      aria-busy={disabled || undefined}
      aria-label="Receipt gallery"
      className={`receipt-gallery${disabled ? " receipt-gallery--disabled" : ""}`}
    >
      {rows.map((row) => {
        const receipt = row.receiptId ? receiptById.get(row.receiptId) : undefined;
        const checkIssues = checkIssuesByRow.get(row.id) ?? [];
        const checkTitle = invoiceCheckIssueTitle(checkIssues);
        const selected = selectedRows.has(row.id);
        const filename = receipt?.originalFilename ?? "Manual row";
        const date = formatLongDate(row.date) || "No date";
        const hours = row.hours.trim();
        const cardLabel = `Open details for ${filename}, ${date}`;

        return (
          <article
            className={[
              "receipt-gallery-card",
              selected ? "receipt-gallery-card--selected" : "",
              row.id === activeRowId ? "receipt-gallery-card--active" : "",
              receipt?.status === "error" ? "receipt-gallery-card--error" : "",
              checkIssues.length > 0 ? "receipt-gallery-card--warning" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            key={row.id}
            title={checkTitle}
          >
            <label className="receipt-gallery-select">
              <input
                aria-label={`Select ${filename}`}
                checked={selected}
                disabled={disabled}
                type="checkbox"
                onChange={(event) => {
                  const next = new Set(selectedRows);
                  if (event.currentTarget.checked) next.add(row.id);
                  else next.delete(row.id);
                  onSelectedRowsChange(next);
                }}
              />
            </label>

            <div className="receipt-gallery-preview" aria-hidden="true">
              {receipt ? (
                <ReceiptThumbnail
                  key={`${receipt.id}:${resourceGeneration}`}
                  invoiceId={invoiceId}
                  receipt={receipt}
                />
              ) : (
                <div className="receipt-gallery-placeholder receipt-gallery-placeholder--manual">
                  <span
                    aria-hidden="true"
                    className="receipt-gallery-placeholder-icon receipt-gallery-placeholder-icon--manual"
                  >
                    ✎
                  </span>
                  <small>Manual invoice row</small>
                </div>
              )}
            </div>

            <div className="receipt-gallery-card-body">
              <div className="receipt-gallery-card-heading">
                <div>
                  <strong>{filename}</strong>
                  <span>{date}</span>
                </div>
                <div className="receipt-gallery-badges">
                  {checkIssues.length > 0 ? (
                    <span
                      aria-label={`${checkIssues.length} unresolved review ${checkIssues.length === 1 ? "item" : "items"}`}
                      className="receipt-gallery-review-badge"
                      role="img"
                    >
                      <span aria-hidden="true">!</span>
                      {checkIssues.length}
                    </span>
                  ) : null}
                  {receipt ? (
                    <span className={`status-pill status-pill--${receipt.status}`}>
                      {receiptStatusLabel(receipt.status)}
                    </span>
                  ) : (
                    <span className="status-pill status-pill--manual">Manual</span>
                  )}
                </div>
              </div>

              <dl className="receipt-gallery-facts">
                <div>
                  <dt>Groceries</dt>
                  <dd>{formatMoney(row.groceriesMinor) || "—"}</dd>
                </div>
                <div>
                  <dt>Hours</dt>
                  <dd>{hours || "—"}</dd>
                </div>
                <div>
                  <dt>Labour</dt>
                  <dd>{hours ? formatMoney(labourMinor(row)) : "—"}</dd>
                </div>
              </dl>

              <p className={`receipt-gallery-comment${row.comment.trim() ? "" : " is-empty"}`}>
                {row.comment.trim() || "No comment"}
              </p>
              <span className="receipt-gallery-open-label">View audit details →</span>
            </div>

            <button
              aria-label={cardLabel}
              className="receipt-gallery-card-hit"
              disabled={disabled}
              type="button"
              onClick={() => onOpenRow(row.id)}
            />
          </article>
        );
      })}
    </section>
  );
}
