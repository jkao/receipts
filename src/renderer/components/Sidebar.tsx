import type { InvoiceSummary } from "../../shared/types";
import { formatPeriod } from "../lib/format";

interface SidebarProps {
  invoices: InvoiceSummary[];
  activeInvoiceId: string | null;
  importingInvoiceIds: ReadonlySet<string>;
  busy: boolean;
  backgroundInert: boolean;
  onNew: () => void;
  onOpen: (invoiceId: string) => void;
  onSettings: () => void;
}

export function Sidebar({
  invoices,
  activeInvoiceId,
  importingInvoiceIds,
  busy,
  backgroundInert,
  onNew,
  onOpen,
  onSettings,
}: SidebarProps) {
  return (
    <aside
      aria-hidden={backgroundInert || undefined}
      aria-label="Invoices"
      className="sidebar"
      inert={backgroundInert || undefined}
    >
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">
          R
        </span>
        <div>
          <strong>Receipt Invoice</strong>
          <span>Local workspace</span>
        </div>
      </div>
      <button className="new-invoice-button" disabled={busy} type="button" onClick={onNew}>
        <span aria-hidden="true">＋</span>
        New Invoice
      </button>
      <div className="sidebar-heading">
        <span>Invoices</span>
        <span>{invoices.length}</span>
      </div>
      <nav className="invoice-list" aria-label="Saved invoices">
        {invoices.length === 0 ? (
          <p className="sidebar-empty">No invoices yet.</p>
        ) : (
          invoices.map((summary) => (
            <button
              aria-current={activeInvoiceId === summary.id ? "page" : undefined}
              className={`invoice-list-item${activeInvoiceId === summary.id ? " is-active" : ""}`}
              disabled={busy}
              key={summary.id}
              type="button"
              onClick={() => onOpen(summary.id)}
            >
              <strong>{summary.name}</strong>
              <span>{formatPeriod(summary.period.startDate, summary.period.endDate)}</span>
              <small>
                {summary.rowCount} {summary.rowCount === 1 ? "row" : "rows"} ·{" "}
                {summary.receiptCount} {summary.receiptCount === 1 ? "receipt" : "receipts"}
              </small>
              {importingInvoiceIds.has(summary.id) ? (
                <span className="invoice-list-importing" role="status">
                  <span className="progress-spinner" aria-hidden="true" />
                  Scanning receipts
                </span>
              ) : null}
            </button>
          ))
        )}
      </nav>
      <button className="settings-button" disabled={busy} type="button" onClick={onSettings}>
        <span aria-hidden="true">⚙</span>
        Settings
      </button>
    </aside>
  );
}
