import {
  type DragEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type { SortColumn } from "react-data-grid";
import type {
  ImportFilesOptions,
  ImportProgress,
  InvoiceCheckResult,
  InvoiceDocument,
  InvoiceOutputResult,
  InvoicePeriod,
  InvoiceRemovalResult,
  InvoiceRow,
  InvoiceSummary,
  SettingsView,
} from "../shared/types";
import { InvoiceCheckSummary } from "./components/InvoiceCheckSummary";
import { InvoiceGrid } from "./components/InvoiceGrid";
import { OutputReadyBanner } from "./components/OutputReadyBanner";
import { ReceiptDrawer } from "./components/ReceiptDrawer";
import { type SaveStatus, useInvoiceAutosave } from "./hooks/useInvoiceAutosave";
import {
  calculateTotals,
  formatMoney,
  formatPeriod,
  invoiceToSummary,
  messageFromError,
  newRowId,
  parseMoneyInput,
  todayIso,
} from "./lib/format";
import {
  hasInvoiceCheckAttention,
  indexInvoiceCheckIssuesByRow,
  isReviewIssue,
} from "./lib/invoiceCheck";
import {
  DEFAULT_INVOICE_SORT,
  normalizeInvoiceSort,
  rowsHaveSameOrder,
  sortInvoiceRows,
} from "./lib/invoiceSort";

type ToastTone = "success" | "error" | "neutral";

interface ToastAction {
  label: string;
  run: () => void;
}

interface ToastMessage {
  id: string;
  message: string;
  tone: ToastTone;
  action?: ToastAction;
}

interface InvoiceAdoptionOptions {
  checkResult?: InvoiceCheckResult;
  preserveBuiltOutput?: boolean;
  preserveSelection?: boolean;
}

interface InvoiceCheckRefreshOptions {
  force?: boolean;
  reportErrors?: boolean;
}

interface ModalFrameProps {
  title: string;
  eyebrow?: string;
  children: ReactNode;
  closeDisabled?: boolean;
  descriptionId?: string;
  onClose: () => void;
  role?: "alertdialog" | "dialog";
  wide?: boolean;
}

function ModalFrame({
  title,
  eyebrow,
  children,
  closeDisabled = false,
  descriptionId,
  onClose,
  role = "dialog",
  wide = false,
}: ModalFrameProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  const closeDisabledRef = useRef(closeDisabled);

  useEffect(() => {
    onCloseRef.current = onClose;
    closeDisabledRef.current = closeDisabled;
  }, [closeDisabled, onClose]);

  useEffect(() => {
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const focusableSelector =
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';
    const focusableElements = () =>
      dialog
        ? Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector)).filter(
            (element) => !element.hasAttribute("disabled") && element.getClientRects().length > 0
          )
        : [];
    const preferred = dialog?.querySelector<HTMLElement>("[data-autofocus]");
    (preferred ?? focusableElements()[0] ?? closeRef.current)?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (!closeDisabledRef.current) onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;

      const elements = focusableElements();
      if (elements.length === 0) {
        event.preventDefault();
        return;
      }
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      previouslyFocused?.focus();
    };
  }, []);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: The backdrop offers pointer dismissal in addition to the dialog's keyboard and button controls.
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (!closeDisabled && event.currentTarget === event.target) onClose();
      }}
    >
      {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: Both permitted roles support aria-modal; the shared frame selects one at runtime. */}
      <section
        ref={dialogRef}
        aria-describedby={descriptionId}
        aria-labelledby={titleId}
        aria-modal="true"
        className={`modal-card${wide ? " modal-card--wide" : ""}`}
        role={role}
      >
        <header className="modal-header">
          <div>
            {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
            <h2 id={titleId}>{title}</h2>
          </div>
          <button
            ref={closeRef}
            aria-label={`Close ${title}`}
            className="icon-button"
            disabled={closeDisabled}
            type="button"
            onClick={onClose}
          >
            ×
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}

interface NewInvoiceModalProps {
  busy: boolean;
  onClose: () => void;
  onCreate: (period: InvoicePeriod) => Promise<void>;
}

function NewInvoiceModal({ busy, onClose, onCreate }: NewInvoiceModalProps) {
  const today = todayIso();
  const [startDate, setStartDate] = useState(`${today.slice(0, 8)}01`);
  const [endDate, setEndDate] = useState(today);
  const [error, setError] = useState<string | null>(null);

  return (
    <ModalFrame closeDisabled={busy} eyebrow="Invoice period" title="New Invoice" onClose={onClose}>
      <form
        className="modal-body"
        onSubmit={(event) => {
          event.preventDefault();
          if (!startDate || !endDate) {
            setError("Choose both a start and end date.");
            return;
          }
          if (startDate > endDate) {
            setError("The end date must be on or after the start date.");
            return;
          }
          setError(null);
          void onCreate({ startDate, endDate });
        }}
      >
        <p className="modal-intro">
          Pick the client billing period. Receipts and manual rows will live together in this
          invoice.
        </p>
        <div className="date-range-fields">
          <label>
            <span>Start date</span>
            <input
              data-autofocus
              disabled={busy}
              required
              type="date"
              value={startDate}
              onChange={(event) => setStartDate(event.target.value)}
            />
          </label>
          <span className="date-range-arrow" aria-hidden="true">
            →
          </span>
          <label>
            <span>End date</span>
            <input
              required
              disabled={busy}
              min={startDate}
              type="date"
              value={endDate}
              onChange={(event) => setEndDate(event.target.value)}
            />
          </label>
        </div>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <footer className="modal-actions">
          <button className="button button--quiet" disabled={busy} type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="button button--primary" disabled={busy} type="submit">
            {busy ? "Creating…" : "Create Invoice"}
          </button>
        </footer>
      </form>
    </ModalFrame>
  );
}

interface SettingsModalProps {
  settings: SettingsView;
  onClose: () => void;
  onSettingsChange: (settings: SettingsView) => void;
  onChooseFolder: () => Promise<SettingsView>;
}

function SettingsModal({
  settings,
  onClose,
  onSettingsChange,
  onChooseFolder,
}: SettingsModalProps) {
  const [apiKey, setApiKey] = useState("");
  const [rate, setRate] = useState((settings.defaultRateMinor / 100).toFixed(2));
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: ToastTone; text: string } | null>(null);

  const run = async (name: string, action: () => Promise<void>) => {
    setBusy(name);
    setMessage(null);
    try {
      await action();
    } catch (error) {
      setMessage({ tone: "error", text: messageFromError(error) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <ModalFrame
      closeDisabled={busy != null}
      eyebrow="Receipt Invoice"
      title="Settings"
      wide
      onClose={onClose}
    >
      <div className="modal-body settings-body">
        <section className="settings-section">
          <div className="settings-section-copy">
            <h3>Working folder</h3>
            <p>Invoices, copied receipts, and local app data are kept together here.</p>
          </div>
          <div className="folder-setting">
            <code title={settings.baseFolder ?? undefined}>
              {settings.baseFolder ?? "No folder selected"}
            </code>
            <button
              className="button button--secondary"
              disabled={busy != null}
              type="button"
              onClick={() =>
                void run("folder", async () => {
                  const next = await onChooseFolder();
                  onSettingsChange(next);
                  if (next.baseFolder !== settings.baseFolder) {
                    setMessage({ tone: "success", text: "Working folder changed." });
                  }
                })
              }
            >
              {busy === "folder" ? "Choosing…" : "Choose…"}
            </button>
          </div>
        </section>

        <section className="settings-section settings-section--stacked">
          <div className="settings-section-copy settings-section-copy--key">
            <div>
              <h3>OpenAI API key</h3>
              <p>
                Used only to scan receipts. The saved key stays encrypted on this Mac and is never
                shown here.
              </p>
            </div>
            <span className={`key-status${settings.hasOpenAiKey ? " key-status--saved" : ""}`}>
              {settings.hasOpenAiKey ? "Key saved" : "No key"}
            </span>
          </div>
          <label className="field-label">
            <span>{settings.hasOpenAiKey ? "Replace saved key" : "API key"}</span>
            <input
              autoComplete="new-password"
              disabled={busy != null}
              placeholder="sk-…"
              spellCheck={false}
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
            />
          </label>
          <div className="inline-actions">
            <button
              className="button button--primary"
              disabled={!apiKey.trim() || busy != null}
              type="button"
              onClick={() =>
                void run("save-key", async () => {
                  const next = await window.receiptApp.saveOpenAiKey(apiKey.trim());
                  setApiKey("");
                  onSettingsChange(next);
                  setMessage({ tone: "success", text: "API key saved securely." });
                })
              }
            >
              {busy === "save-key" ? "Saving…" : "Save Key"}
            </button>
            <button
              className="button button--secondary"
              disabled={(!apiKey.trim() && !settings.hasOpenAiKey) || busy != null}
              type="button"
              onClick={() =>
                void run("test-key", async () => {
                  const result = await window.receiptApp.testOpenAiKey(apiKey.trim() || undefined);
                  setMessage({ tone: result.ok ? "success" : "error", text: result.message });
                })
              }
            >
              {busy === "test-key" ? "Testing…" : "Test Key"}
            </button>
            {settings.hasOpenAiKey ? (
              <button
                className="button button--danger-quiet"
                disabled={busy != null}
                type="button"
                onClick={() => {
                  if (!window.confirm("Delete the saved OpenAI API key from this Mac?")) return;
                  void run("delete-key", async () => {
                    const next = await window.receiptApp.deleteOpenAiKey();
                    setApiKey("");
                    onSettingsChange(next);
                    setMessage({ tone: "neutral", text: "Saved API key deleted." });
                  });
                }}
              >
                {busy === "delete-key" ? "Deleting…" : "Delete Key"}
              </button>
            ) : null}
          </div>
        </section>

        <section className="settings-section">
          <div className="settings-section-copy">
            <h3>Default hourly rate</h3>
            <p>Used for new invoices and their labour rows.</p>
          </div>
          <form
            className="rate-setting"
            onSubmit={(event) => {
              event.preventDefault();
              const minor = parseMoneyInput(rate);
              if (minor == null || minor < 0) {
                setMessage({ tone: "error", text: "Enter a valid hourly rate." });
                return;
              }
              void run("rate", async () => {
                const next = await window.receiptApp.updateDefaultRate(minor);
                onSettingsChange(next);
                setRate((next.defaultRateMinor / 100).toFixed(2));
                setMessage({ tone: "success", text: "Default rate updated." });
              });
            }}
          >
            <label className="money-field">
              <span aria-hidden="true">$</span>
              <input
                aria-label="Default hourly rate"
                disabled={busy != null}
                inputMode="decimal"
                min="0"
                step="0.01"
                type="number"
                value={rate}
                onChange={(event) => setRate(event.target.value)}
              />
            </label>
            <button className="button button--secondary" disabled={busy != null} type="submit">
              {busy === "rate" ? "Saving…" : "Save"}
            </button>
          </form>
        </section>

        {message ? (
          <div className={`settings-message settings-message--${message.tone}`} role="status">
            {message.text}
          </div>
        ) : null}

        <footer className="modal-actions">
          <button
            className="button button--primary"
            disabled={busy != null}
            type="button"
            onClick={onClose}
          >
            Done
          </button>
        </footer>
      </div>
    </ModalFrame>
  );
}

interface ExportModalProps {
  busy: boolean;
  onClose: () => void;
  onExport: (asZip: boolean, includeDebug: boolean) => Promise<void>;
}

function ExportModal({ busy, onClose, onExport }: ExportModalProps) {
  const [asZip, setAsZip] = useState(true);
  const [includeDebug, setIncludeDebug] = useState(false);

  return (
    <ModalFrame
      closeDisabled={busy}
      eyebrow="Share with client"
      title="Export Invoice"
      onClose={onClose}
    >
      <form
        className="modal-body"
        onSubmit={(event) => {
          event.preventDefault();
          void onExport(asZip, includeDebug);
        }}
      >
        <p className="modal-intro">
          Export the invoice table with its source receipts. Your working folder is not changed.
        </p>
        <fieldset className="choice-cards" disabled={busy}>
          <legend>Format</legend>
          <label className={asZip ? "choice-card choice-card--selected" : "choice-card"}>
            <input checked={asZip} name="format" type="radio" onChange={() => setAsZip(true)} />
            <span>
              <strong>ZIP archive</strong>
              <small>One file that is easy to send.</small>
            </span>
          </label>
          <label className={!asZip ? "choice-card choice-card--selected" : "choice-card"}>
            <input checked={!asZip} name="format" type="radio" onChange={() => setAsZip(false)} />
            <span>
              <strong>Folder</strong>
              <small>An unpacked copy you can browse.</small>
            </span>
          </label>
        </fieldset>
        <label className="checkbox-line">
          <input
            checked={includeDebug}
            disabled={busy}
            type="checkbox"
            onChange={(event) => setIncludeDebug(event.target.checked)}
          />
          <span>
            <strong>Include scan debug files</strong>
            <small>Usually unnecessary; useful only for troubleshooting.</small>
          </span>
        </label>
        <footer className="modal-actions">
          <button className="button button--quiet" disabled={busy} type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="button button--primary" disabled={busy} type="submit">
            {busy ? "Exporting…" : `Export ${asZip ? "ZIP" : "Folder"}`}
          </button>
        </footer>
      </form>
    </ModalFrame>
  );
}

interface RemoveInvoiceModalProps {
  busy: boolean;
  error: string | null;
  invoiceName: string;
  onClose: () => void;
  onReload?: () => void;
  onRemove: (hardDelete: boolean) => Promise<void>;
}

export function removeInvoiceButtonLabel(hardDelete: boolean, busy: boolean): string {
  if (busy) return hardDelete ? "Permanently Deleting…" : "Removing…";
  return hardDelete ? "Permanently Delete Invoice" : "Remove Invoice";
}

export function invoiceRemovalNotification(result: InvoiceRemovalResult): {
  message: string;
  tone: ToastTone;
} {
  if (result.warning) {
    return {
      message: `${result.invoiceName} was removed from the app, but permanent deletion was incomplete: ${result.warning}`,
      tone: "error",
    };
  }
  return {
    message:
      result.mode === "hard"
        ? `Permanently deleted ${result.invoiceName} and its local files.`
        : `Removed ${result.invoiceName}. Its local files were kept.`,
    tone: "success",
  };
}

export function RemoveInvoiceModal({
  busy,
  error,
  invoiceName,
  onClose,
  onReload,
  onRemove,
}: RemoveInvoiceModalProps) {
  const [hardDelete, setHardDelete] = useState(false);
  const descriptionId = useId();

  return (
    <ModalFrame
      closeDisabled={busy}
      descriptionId={descriptionId}
      eyebrow="Invoice removal"
      role="alertdialog"
      title="Remove Invoice?"
      onClose={onClose}
    >
      <form
        className="modal-body"
        onSubmit={(event) => {
          event.preventDefault();
          void onRemove(hardDelete);
        }}
      >
        <p className="modal-intro" id={descriptionId}>
          Remove <strong>{invoiceName}</strong> from the invoice list? By default, its folder and
          files stay on disk and a <code>DELETED.json</code> marker hides it from the app. You can
          restore it later by removing that marker in Finder.
        </p>
        <label
          className={`checkbox-line remove-invoice-hard-delete${
            hardDelete ? " remove-invoice-hard-delete--selected" : ""
          }`}
        >
          <input
            checked={hardDelete}
            disabled={busy}
            type="checkbox"
            onChange={(event) => setHardDelete(event.target.checked)}
          />
          <span>
            <strong>Permanently delete this invoice folder and every local file</strong>
            <small>
              The app cannot undo this. Receipts, scan details, invoice output, the .trash folder,
              and every other file in the invoice folder will be deleted.
            </small>
          </span>
        </label>
        {error ? (
          <div className="form-error form-error--action" role="alert">
            <span>{error}</span>
            {onReload ? (
              <button className="text-button" disabled={busy} type="button" onClick={onReload}>
                Reload Invoice…
              </button>
            ) : null}
          </div>
        ) : null}
        <footer className="modal-actions">
          <button
            className="button button--quiet"
            data-autofocus
            disabled={busy}
            type="button"
            onClick={onClose}
          >
            Cancel
          </button>
          <button className="button button--danger" disabled={busy} type="submit">
            {removeInvoiceButtonLabel(hardDelete, busy)}
          </button>
        </footer>
      </form>
    </ModalFrame>
  );
}

interface SidebarProps {
  invoices: InvoiceSummary[];
  activeInvoiceId: string | null;
  busy: boolean;
  onNew: () => void;
  onOpen: (invoiceId: string) => void;
  onSettings: () => void;
}

function Sidebar({ invoices, activeInvoiceId, busy, onNew, onOpen, onSettings }: SidebarProps) {
  return (
    <aside className="sidebar" aria-label="Invoices">
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

interface OnboardingProps {
  busy: boolean;
  error: string | null;
  onChooseFolder: () => void;
}

function Onboarding({ busy, error, onChooseFolder }: OnboardingProps) {
  return (
    <main className="onboarding-shell">
      <section className="onboarding-card">
        <div className="onboarding-icon" aria-hidden="true">
          <span>▤</span>
        </div>
        <p className="eyebrow">Receipt Invoice</p>
        <h1>Turn receipts into a clean client invoice.</h1>
        <p className="onboarding-lede">
          Choose one local folder for your invoices and receipt copies. A Dropbox folder works too,
          as long as the files are available on this Mac.
        </p>
        <div className="privacy-note">
          <span aria-hidden="true">⌂</span>
          <div>
            <strong>Your folder is the database</strong>
            <p>No account or hosted database. You can browse and back up the files yourself.</p>
          </div>
        </div>
        {error ? (
          <div className="onboarding-error" role="alert">
            {error}
          </div>
        ) : null}
        <button
          className="button button--primary button--large"
          disabled={busy}
          type="button"
          onClick={onChooseFolder}
        >
          {busy ? "Opening Finder…" : "Choose Working Folder"}
        </button>
        <small className="onboarding-footnote">You can change this later in Settings.</small>
      </section>
    </main>
  );
}

function SaveIndicator({
  status,
  error,
  onRetry,
  onReload,
}: {
  status: SaveStatus;
  error: string | null;
  onRetry: () => void;
  onReload: () => void;
}) {
  if (status === "error") {
    const isRevisionConflict = /changed: expected revision \d+, found \d+/i.test(error ?? "");
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

function ToastRegion({
  toasts,
  dismiss,
}: {
  toasts: ToastMessage[];
  dismiss: (id: string) => void;
}) {
  return (
    <div className="toast-region">
      {toasts.map((toast) => (
        <div className={`toast toast--${toast.tone}`} key={toast.id}>
          <span className="toast-icon" aria-hidden="true">
            {toast.tone === "success" ? "✓" : toast.tone === "error" ? "!" : "i"}
          </span>
          <span role={toast.tone === "error" ? "alert" : "status"}>{toast.message}</span>
          {toast.action ? (
            <button
              className="toast-action"
              type="button"
              onClick={() => {
                dismiss(toast.id);
                toast.action?.run();
              }}
            >
              {toast.action.label}
            </button>
          ) : null}
          <button
            aria-label="Dismiss message"
            className="toast-close"
            type="button"
            onClick={() => dismiss(toast.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

export default function App() {
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [invoices, setInvoices] = useState<InvoiceSummary[]>([]);
  const [invoice, setInvoice] = useState<InvoiceDocument | null>(null);
  const [rows, setRows] = useState<InvoiceRow[]>([]);
  const [sortColumns, setSortColumns] = useState<SortColumn[]>(() =>
    normalizeInvoiceSort(DEFAULT_INVOICE_SORT)
  );
  const [selectedRows, setSelectedRows] = useState<ReadonlySet<string>>(new Set());
  const [detailRowId, setDetailRowId] = useState<string | null>(null);
  const [focusRowId, setFocusRowId] = useState<string | null>(null);
  const [booting, setBooting] = useState(true);
  const [bootError, setBootError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [newInvoiceOpen, setNewInvoiceOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [removeInvoiceOpen, setRemoveInvoiceOpen] = useState(false);
  const [removeInvoiceError, setRemoveInvoiceError] = useState<string | null>(null);
  const [removeInvoiceConflict, setRemoveInvoiceConflict] = useState(false);
  const [importProgress, setImportProgress] = useState<ImportProgress | null>(null);
  const [invoiceCheckResult, setInvoiceCheckResult] = useState<InvoiceCheckResult | null>(null);
  const [checkSummaryVisible, setCheckSummaryVisible] = useState(true);
  const [updatingReviewFingerprints, setUpdatingReviewFingerprints] = useState<ReadonlySet<string>>(
    new Set()
  );
  const [builtOutput, setBuiltOutput] = useState<{
    invoiceId: string;
    result: InvoiceOutputResult;
  } | null>(null);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const dragDepthRef = useRef(0);
  const allowCloseRef = useRef(false);
  const closeSaveInFlightRef = useRef(false);
  const saveStatusRef = useRef<SaveStatus>("saved");
  const busyActionRef = useRef<string | null>(busyAction);
  const currentInvoiceRef = useRef<InvoiceDocument | null>(null);
  const sortColumnsRef = useRef<readonly SortColumn[]>(sortColumns);
  const checkGenerationRef = useRef(0);
  const checkInFlightRef = useRef<{ key: string } | null>(null);
  const checkRetryAttemptsRef = useRef(new Map<string, number>());
  const checkRetryKeyRef = useRef<string | null>(null);
  const checkRetryTimerRef = useRef<number | null>(null);
  const refreshInvoiceCheckRef = useRef<
    | ((
        invoiceId: string,
        expectedRevision: number,
        options?: InvoiceCheckRefreshOptions
      ) => Promise<InvoiceCheckResult | null>)
    | null
  >(null);
  const reloadInvoiceFromDiskRef = useRef<(() => Promise<void>) | null>(null);
  const dismissedCheckKeyRef = useRef<string | null>(null);
  const invoiceCheckResultRef = useRef<InvoiceCheckResult | null>(invoiceCheckResult);
  currentInvoiceRef.current = invoice;
  busyActionRef.current = busyAction;
  sortColumnsRef.current = sortColumns;
  invoiceCheckResultRef.current = invoiceCheckResult;

  const clearInvoiceCheck = useCallback(() => {
    checkGenerationRef.current += 1;
    checkInFlightRef.current = null;
    checkRetryAttemptsRef.current.clear();
    checkRetryKeyRef.current = null;
    if (checkRetryTimerRef.current !== null) {
      window.clearTimeout(checkRetryTimerRef.current);
      checkRetryTimerRef.current = null;
    }
    dismissedCheckKeyRef.current = null;
    invoiceCheckResultRef.current = null;
    setInvoiceCheckResult(null);
    setCheckSummaryVisible(true);
  }, []);

  const dismissInvoiceCheck = useCallback(() => {
    const current = currentInvoiceRef.current;
    if (current) dismissedCheckKeyRef.current = `${current.id}:${current.revision}`;
    setCheckSummaryVisible(false);
  }, []);

  const clearBuiltOutput = useCallback(() => setBuiltOutput(null), []);

  const dismissToast = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const pushToast = useCallback(
    (message: string, tone: ToastTone = "neutral", action?: ToastAction) => {
      const id = newRowId();
      setToasts((current) => [...current.slice(-3), { id, message, tone, action }]);
      window.setTimeout(() => dismissToast(id), action ? 10_000 : 5_000);
    },
    [dismissToast]
  );

  const mergeSummary = useCallback((document: InvoiceDocument) => {
    setInvoices((current) => {
      const next = current.filter((summary) => summary.id !== document.id);
      next.push(invoiceToSummary(document));
      return next.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    });
  }, []);

  const handleSaveError = useCallback(
    (error: unknown) => {
      pushToast(`Changes were not saved: ${messageFromError(error)}`, "error");
    },
    [pushToast]
  );

  const handleSaved = useCallback(
    (document: InvoiceDocument) => {
      if (currentInvoiceRef.current?.id === document.id) currentInvoiceRef.current = document;
      setInvoice((current) => (current?.id === document.id ? document : current));
      mergeSummary(document);
    },
    [mergeSummary]
  );

  const autosave = useInvoiceAutosave({ onSaved: handleSaved, onError: handleSaveError });
  saveStatusRef.current = autosave.status;

  const refreshInvoiceCheck = useCallback(
    async (
      invoiceId: string,
      expectedRevision: number,
      options: InvoiceCheckRefreshOptions = {}
    ): Promise<InvoiceCheckResult | null> => {
      const key = `${invoiceId}:${expectedRevision}`;
      const existing = invoiceCheckResultRef.current;
      if (
        !options.force &&
        existing?.invoiceId === invoiceId &&
        existing.revision === expectedRevision
      ) {
        return existing;
      }
      if (!options.force && dismissedCheckKeyRef.current === key) return null;
      if (!options.force && checkInFlightRef.current?.key === key) return null;
      if (!options.force && checkRetryKeyRef.current === key) return null;
      if (!options.force && (checkRetryAttemptsRef.current.get(key) ?? 0) >= 3) return null;
      if (options.force) {
        checkRetryAttemptsRef.current.delete(key);
        checkRetryKeyRef.current = null;
        if (checkRetryTimerRef.current !== null) {
          window.clearTimeout(checkRetryTimerRef.current);
          checkRetryTimerRef.current = null;
        }
        dismissedCheckKeyRef.current = null;
        setCheckSummaryVisible(true);
      }

      const requestGeneration = checkGenerationRef.current + 1;
      const request = { key };
      checkGenerationRef.current = requestGeneration;
      checkInFlightRef.current = request;
      try {
        const result = await window.receiptApp.checkInvoice(invoiceId);
        const currentDocument = currentInvoiceRef.current;
        if (
          checkGenerationRef.current !== requestGeneration ||
          result.invoiceId !== invoiceId ||
          currentDocument?.id !== invoiceId ||
          currentDocument.revision !== expectedRevision
        ) {
          if (options.reportErrors) {
            pushToast("The invoice changed while it was being checked. Run Check Invoice again.");
          }
          return null;
        }
        if (result.revision !== expectedRevision) {
          pushToast(
            "The invoice changed on disk while it was being checked. Reload the latest version.",
            "error",
            {
              label: "Reload",
              run: () => {
                if (currentInvoiceRef.current?.id !== invoiceId) return;
                if (busyActionRef.current) {
                  pushToast("Wait for the current invoice action to finish.");
                  return;
                }
                void reloadInvoiceFromDiskRef.current?.();
              },
            }
          );
          return null;
        }
        checkRetryAttemptsRef.current.delete(key);
        invoiceCheckResultRef.current = result;
        setCheckSummaryVisible(
          options.force ||
            (dismissedCheckKeyRef.current !== key && hasInvoiceCheckAttention(result.issues))
        );
        setInvoiceCheckResult(result);
        return result;
      } catch (error) {
        if (options.reportErrors) {
          pushToast(`Could not check invoice: ${messageFromError(error)}`, "error");
        } else {
          const currentDocument = currentInvoiceRef.current;
          if (
            checkGenerationRef.current === requestGeneration &&
            currentDocument?.id === invoiceId &&
            currentDocument.revision === expectedRevision
          ) {
            const attempt = (checkRetryAttemptsRef.current.get(key) ?? 0) + 1;
            checkRetryAttemptsRef.current.set(key, attempt);
            if (attempt < 3) {
              checkRetryKeyRef.current = key;
              checkRetryTimerRef.current = window.setTimeout(() => {
                checkRetryTimerRef.current = null;
                checkRetryKeyRef.current = null;
                const current = currentInvoiceRef.current;
                if (
                  current?.id === invoiceId &&
                  current.revision === expectedRevision &&
                  saveStatusRef.current === "saved"
                ) {
                  void refreshInvoiceCheckRef.current?.(invoiceId, expectedRevision);
                }
              }, attempt * 1_000);
            } else {
              pushToast(
                "Invoice review could not refresh. Use Check Invoice to try again.",
                "error"
              );
            }
          }
        }
        return null;
      } finally {
        if (checkInFlightRef.current === request) checkInFlightRef.current = null;
      }
    },
    [pushToast]
  );
  refreshInvoiceCheckRef.current = refreshInvoiceCheck;

  useEffect(() => {
    return () => {
      if (checkRetryTimerRef.current !== null) {
        window.clearTimeout(checkRetryTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (allowCloseRef.current) return;

      // Main-process file work cannot be safely interrupted. Let the current
      // action settle, then a subsequent close can proceed normally.
      if (busyActionRef.current) {
        event.preventDefault();
        event.returnValue = "";
        return;
      }
      if (saveStatusRef.current === "saved") return;

      // Electron silently cancels an unload when returnValue is set. Finish
      // the queued revisioned save, then repeat the close once it is safe.
      event.preventDefault();
      event.returnValue = "";
      if (closeSaveInFlightRef.current) return;
      closeSaveInFlightRef.current = true;
      void autosave
        .flush()
        .then(() => {
          allowCloseRef.current = true;
          window.close();
          window.setTimeout(() => {
            allowCloseRef.current = false;
            closeSaveInFlightRef.current = false;
          }, 1_000);
        })
        .catch(() => {
          closeSaveInFlightRef.current = false;
        });
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [autosave.flush]);

  useEffect(() => {
    if (!invoice || autosave.status !== "saved") return;
    void refreshInvoiceCheck(invoice.id, invoice.revision);
  }, [autosave.status, invoice, refreshInvoiceCheck]);

  const adoptInvoice = useCallback(
    (document: InvoiceDocument, options: InvoiceAdoptionOptions = {}) => {
      const sameInvoice = currentInvoiceRef.current?.id === document.id;
      const activeSort = sameInvoice
        ? normalizeInvoiceSort(sortColumnsRef.current)
        : normalizeInvoiceSort(DEFAULT_INVOICE_SORT);
      const orderedRows = sortInvoiceRows(document.rows, activeSort);
      const viewDocument = { ...document, rows: orderedRows };

      if (!sameInvoice) {
        sortColumnsRef.current = activeSort;
        setSortColumns(activeSort);
      }
      if (options.checkResult) {
        checkGenerationRef.current += 1;
        dismissedCheckKeyRef.current = null;
        invoiceCheckResultRef.current = options.checkResult;
        setInvoiceCheckResult(options.checkResult);
      } else {
        clearInvoiceCheck();
      }
      if (!options.preserveBuiltOutput) clearBuiltOutput();
      currentInvoiceRef.current = viewDocument;
      setInvoice(viewDocument);
      setRows(orderedRows);
      const orderedRowIds = new Set(orderedRows.map((row) => row.id));
      setSelectedRows((current) =>
        options.preserveSelection
          ? new Set([...current].filter((id) => orderedRowIds.has(id)))
          : new Set()
      );
      setFocusRowId(null);
      setDetailRowId((current) =>
        current && document.rows.some((row) => row.id === current) ? current : null
      );
      autosave.reset(document);
      if (!rowsHaveSameOrder(document.rows, orderedRows)) autosave.stage(orderedRows);
      mergeSummary(viewDocument);
    },
    [autosave.reset, autosave.stage, clearBuiltOutput, clearInvoiceCheck, mergeSummary]
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        if (!window.receiptApp)
          throw new Error("The desktop bridge is unavailable. Restart the app.");
        const initialSettings = await window.receiptApp.getSettings();
        if (cancelled) return;
        setSettings(initialSettings);
        if (initialSettings.baseFolder) {
          const list = (await window.receiptApp.listInvoices()).sort((a, b) =>
            b.updatedAt.localeCompare(a.updatedAt)
          );
          if (cancelled) return;
          setInvoices(list);
          if (list[0]) {
            const document = await window.receiptApp.loadInvoice(list[0].id);
            if (!cancelled) adoptInvoice(document);
          }
        }
      } catch (error) {
        if (!cancelled) setBootError(messageFromError(error));
      } finally {
        if (!cancelled) setBooting(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [adoptInvoice]);

  useEffect(() => {
    if (!window.receiptApp) return;
    return window.receiptApp.onImportProgress((progress) => {
      if (progress.invoiceId === currentInvoiceRef.current?.id) setImportProgress(progress);
    });
  }, []);

  const chooseFolder = useCallback(async (): Promise<SettingsView> => {
    await autosave.flush();
    const previousFolder = settings?.baseFolder ?? null;
    const next = await window.receiptApp.chooseBaseFolder();
    setSettings(next);
    if (next.baseFolder && next.baseFolder !== previousFolder) {
      // The settings change is already durable at this point. Clear the old
      // workspace before reading the new folder so a read error can never
      // leave an invoice from the previous folder editable on screen.
      setInvoices([]);
      clearInvoiceCheck();
      clearBuiltOutput();
      currentInvoiceRef.current = null;
      setInvoice(null);
      setRows([]);
      setSelectedRows(new Set());
      setFocusRowId(null);
      setDetailRowId(null);
      autosave.reset(null);
      const list = (await window.receiptApp.listInvoices()).sort((a, b) =>
        b.updatedAt.localeCompare(a.updatedAt)
      );
      setInvoices(list);
      if (list[0]) {
        adoptInvoice(await window.receiptApp.loadInvoice(list[0].id));
      }
    }
    return next;
  }, [
    adoptInvoice,
    autosave.flush,
    autosave.reset,
    clearBuiltOutput,
    clearInvoiceCheck,
    settings?.baseFolder,
  ]);

  const handleOnboardingFolder = async () => {
    setBusyAction("folder");
    setBootError(null);
    try {
      const next = await chooseFolder();
      if (!next.baseFolder) setBootError(null);
    } catch (error) {
      setBootError(messageFromError(error));
    } finally {
      setBusyAction(null);
    }
  };

  const openInvoice = async (invoiceId: string) => {
    if (busyAction || invoice?.id === invoiceId) return;
    setBusyAction("load");
    try {
      await autosave.flush();
      adoptInvoice(await window.receiptApp.loadInvoice(invoiceId));
    } catch (error) {
      pushToast(`Could not open invoice: ${messageFromError(error)}`, "error");
    } finally {
      setBusyAction(null);
    }
  };

  const reloadInvoiceFromDisk = async () => {
    if (!invoice || busyAction) return;
    if (
      !window.confirm(
        "Reload the latest invoice from disk? Your unsaved table edits will be discarded."
      )
    ) {
      return;
    }
    setBusyAction("load");
    try {
      const document = await window.receiptApp.loadInvoice(invoice.id);
      adoptInvoice(document);
      pushToast("Reloaded the latest invoice from disk.", "success");
    } catch (error) {
      pushToast(`Could not reload invoice: ${messageFromError(error)}`, "error");
    } finally {
      setBusyAction(null);
    }
  };
  reloadInvoiceFromDiskRef.current = reloadInvoiceFromDisk;

  const createInvoice = async (period: InvoicePeriod) => {
    setBusyAction("create");
    try {
      await autosave.flush();
      const document = await window.receiptApp.createInvoice(period);
      adoptInvoice(document);
      setNewInvoiceOpen(false);
      pushToast("Invoice created.", "success");
    } catch (error) {
      pushToast(`Could not create invoice: ${messageFromError(error)}`, "error");
    } finally {
      setBusyAction(null);
    }
  };

  const removeActiveInvoice = async (hardDelete: boolean) => {
    const activeInvoice = currentInvoiceRef.current;
    if (!activeInvoice || busyActionRef.current) return;

    const invoiceId = activeInvoice.id;
    busyActionRef.current = "remove-invoice";
    setBusyAction("remove-invoice");
    setRemoveInvoiceError(null);
    setRemoveInvoiceConflict(false);
    try {
      const savedDocument = await autosave.flush();
      const documentToRemove = savedDocument ?? currentInvoiceRef.current;
      if (!documentToRemove || documentToRemove.id !== invoiceId) {
        throw new Error("The open invoice changed before it could be removed.");
      }

      const result = await window.receiptApp.removeInvoice(invoiceId, {
        expectedRevision: documentToRemove.revision,
        hardDelete,
      });
      if (result.invoiceId !== invoiceId) {
        throw new Error("The removal result did not match the open invoice.");
      }

      clearInvoiceCheck();
      clearBuiltOutput();
      currentInvoiceRef.current = null;
      setInvoice(null);
      setRows([]);
      setSelectedRows(new Set());
      setFocusRowId(null);
      setDetailRowId(null);
      setImportProgress(null);
      autosave.reset(null);
      setInvoices((current) => current.filter((summary) => summary.id !== invoiceId));
      setRemoveInvoiceOpen(false);
      setRemoveInvoiceConflict(false);

      const notification = invoiceRemovalNotification(result);
      pushToast(notification.message, notification.tone);

      try {
        const list = (await window.receiptApp.listInvoices()).sort((a, b) =>
          b.updatedAt.localeCompare(a.updatedAt)
        );
        setInvoices(list);
        if (list[0]) {
          try {
            adoptInvoice(await window.receiptApp.loadInvoice(list[0].id));
          } catch (error) {
            pushToast(
              `The invoice was removed, but the next invoice could not open: ${messageFromError(error)}`,
              "error"
            );
          }
        }
      } catch (error) {
        pushToast(
          `The invoice was removed, but the invoice list could not refresh: ${messageFromError(error)}`,
          "error"
        );
      }
    } catch (error) {
      const errorMessage = messageFromError(error);
      const revisionConflict = /revision|changed|conflict/i.test(errorMessage);
      setRemoveInvoiceConflict(revisionConflict);
      setRemoveInvoiceError(errorMessage);
      pushToast(`Could not remove invoice: ${errorMessage}`, "error");
    } finally {
      if (busyActionRef.current === "remove-invoice") {
        busyActionRef.current = null;
        setBusyAction(null);
      }
    }
  };

  const updateRows = useCallback(
    (nextRows: InvoiceRow[]) => {
      const orderedRows = sortInvoiceRows(nextRows, sortColumnsRef.current);
      clearInvoiceCheck();
      clearBuiltOutput();
      setRows(orderedRows);
      autosave.stage(orderedRows);
      const orderedRowIds = new Set(orderedRows.map((row) => row.id));
      setSelectedRows((current) => new Set([...current].filter((id) => orderedRowIds.has(id))));
    },
    [autosave.stage, clearBuiltOutput, clearInvoiceCheck]
  );

  const handleSortColumnsChange = useCallback(
    (requestedSort: SortColumn[]) => {
      const nextSort = normalizeInvoiceSort(requestedSort);
      sortColumnsRef.current = nextSort;
      setSortColumns(nextSort);

      const orderedRows = sortInvoiceRows(rows, nextSort);
      if (!rowsHaveSameOrder(rows, orderedRows)) {
        updateRows(orderedRows);
      }
    },
    [rows, updateRows]
  );

  const addManualRow = () => {
    if (!invoice) return;
    const today = todayIso();
    const date =
      today >= invoice.period.startDate && today <= invoice.period.endDate
        ? today
        : invoice.period.endDate;
    const row: InvoiceRow = {
      id: newRowId(),
      date,
      groceriesMinor: null,
      hours: "",
      rateMinor: invoice.defaultRateMinor,
      comment: "",
      receiptId: null,
    };
    updateRows([...rows, row]);
    setFocusRowId(row.id);
  };

  const retryableSelectedReceiptIds = useMemo(() => {
    if (!invoice) return [];
    const retryable = new Set(
      invoice.receipts.filter((receipt) => receipt.status !== "ready").map((receipt) => receipt.id)
    );
    return rows
      .filter((row) => selectedRows.has(row.id) && row.receiptId && retryable.has(row.receiptId))
      .map((row) => row.receiptId as string);
  }, [invoice, rows, selectedRows]);

  const importPaths = useCallback(
    async (paths: string[], method: NonNullable<ImportFilesOptions["method"]>) => {
      if (!invoice || paths.length === 0) return;
      if (busyAction) {
        pushToast("Wait for the current invoice action to finish.");
        return;
      }
      clearBuiltOutput();
      setBusyAction("import");
      setImportProgress({
        invoiceId: invoice.id,
        current: 0,
        total: paths.length,
        filename:
          paths.length === 1
            ? (paths[0].split("/").pop() ?? "Receipt")
            : `${paths.length} receipts`,
        status: "copying",
      });
      try {
        await autosave.flush();
        let result = await window.receiptApp.importFiles(invoice.id, paths, { method });
        const crossInvoiceDuplicates = result.duplicates.filter(
          (duplicate) => !duplicate.sameInvoice
        );
        if (
          crossInvoiceDuplicates.length > 0 &&
          window.confirm(
            `${crossInvoiceDuplicates.length} receipt${crossInvoiceDuplicates.length === 1 ? " was" : "s were"} already used in another invoice. Import ${crossInvoiceDuplicates.length === 1 ? "it" : "them"} here too?`
          )
        ) {
          const duplicateResult = await window.receiptApp.importFiles(
            invoice.id,
            crossInvoiceDuplicates.map((duplicate) => duplicate.path),
            { method, allowCrossInvoiceDuplicates: true }
          );
          result = {
            invoice: duplicateResult.invoice,
            importedCount: result.importedCount + duplicateResult.importedCount,
            duplicates: [...result.duplicates, ...duplicateResult.duplicates],
            errors: [...result.errors, ...duplicateResult.errors],
          };
        }
        adoptInvoice(result.invoice);
        if (result.importedCount > 0) {
          pushToast(
            `${result.importedCount} receipt${result.importedCount === 1 ? "" : "s"} added.`,
            "success"
          );
        }
        if (result.errors.length > 0) {
          const [firstError] = result.errors;
          const remaining = result.errors.length - 1;
          pushToast(
            `${firstError.filename}: ${firstError.message}${remaining > 0 ? ` (+${remaining} more)` : ""}`,
            "error"
          );
        }
        const skipped = result.duplicates.filter((duplicate) => duplicate.sameInvoice).length;
        if (skipped > 0) {
          pushToast(
            `${skipped} duplicate${skipped === 1 ? " was" : "s were"} already in this invoice.`
          );
        }
      } catch (error) {
        pushToast(`Receipt import failed: ${messageFromError(error)}`, "error");
      } finally {
        setBusyAction(null);
        setImportProgress(null);
      }
    },
    [adoptInvoice, autosave.flush, busyAction, clearBuiltOutput, invoice, pushToast]
  );

  const chooseReceipts = async () => {
    if (!invoice) return;
    try {
      const paths = await window.receiptApp.chooseReceiptFiles();
      await importPaths(paths, "file-picker");
    } catch (error) {
      pushToast(`Could not choose receipts: ${messageFromError(error)}`, "error");
    }
  };

  const dropFiles = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    dragDepthRef.current = 0;
    setDraggingFiles(false);
    if (!invoice) {
      pushToast("Create or open an invoice before adding receipts.", "error");
      return;
    }
    const paths: string[] = [];
    for (const file of Array.from(event.dataTransfer.files)) {
      try {
        const path = window.receiptApp.pathForFile(file);
        if (path) paths.push(path);
      } catch {
        // The main process performs final validation; inaccessible browser files are simply skipped.
      }
    }
    if (paths.length === 0) {
      pushToast("No local image or PDF files were found in that drop.", "error");
      return;
    }
    void importPaths(paths, "drag-drop");
  };

  const retryReceiptIds = async (receiptIds: string[]) => {
    if (busyAction) {
      pushToast("Wait for the current invoice action to finish.");
      return;
    }
    if (!invoice || receiptIds.length === 0) {
      pushToast("Select one or more receipt rows to retry.");
      return;
    }
    clearBuiltOutput();
    setBusyAction("retry");
    try {
      await autosave.flush();
      const uniqueReceiptIds = [...new Set(receiptIds)];
      const document = await window.receiptApp.retryReceipts(invoice.id, uniqueReceiptIds);
      adoptInvoice(document);
      const retried = document.receipts.filter((receipt) => uniqueReceiptIds.includes(receipt.id));
      const completedCount = retried.filter(
        (receipt) => receipt.status === "ready" || receipt.status === "needs-review"
      ).length;
      const failedCount = uniqueReceiptIds.length - completedCount;
      const reviewCount = retried.filter((receipt) => receipt.status === "needs-review").length;
      if (failedCount > 0) {
        pushToast(
          `${failedCount} receipt${failedCount === 1 ? "" : "s"} still could not be scanned. Open the receipt details for the error.`,
          "error"
        );
      } else if (reviewCount > 0) {
        pushToast(
          `${reviewCount} receipt${reviewCount === 1 ? " needs" : "s need"} review.`,
          "neutral"
        );
      } else {
        pushToast(
          `${uniqueReceiptIds.length} receipt${uniqueReceiptIds.length === 1 ? "" : "s"} rescanned.`,
          "success"
        );
      }
    } catch (error) {
      pushToast(`Retry failed: ${messageFromError(error)}`, "error");
    } finally {
      setBusyAction(null);
      setImportProgress(null);
    }
  };

  const retrySelected = () => {
    void retryReceiptIds(retryableSelectedReceiptIds);
  };

  const copyTsv = async () => {
    if (!invoice) return;
    setBusyAction("copy");
    try {
      await autosave.flush();
      const selected = selectedRows.size > 0 ? [...selectedRows] : null;
      await window.receiptApp.copyTsv(invoice.id, selected, true, selected == null);
      pushToast(
        selected
          ? `${selected.length} selected row${selected.length === 1 ? "" : "s"} copied.`
          : "Invoice copied for Google Sheets.",
        "success"
      );
    } catch (error) {
      pushToast(`Could not copy rows: ${messageFromError(error)}`, "error");
    } finally {
      setBusyAction(null);
    }
  };

  const deleteSelected = useCallback(async () => {
    if (!invoice || selectedRows.size === 0 || busyAction) return;
    const invoiceId = invoice.id;
    const count = selectedRows.size;
    if (!window.confirm(`Delete ${count} selected row${count === 1 ? "" : "s"}?`)) return;
    clearBuiltOutput();
    setBusyAction("delete");
    try {
      await autosave.flush();
      if (currentInvoiceRef.current?.id !== invoiceId) return;
      const document = await window.receiptApp.deleteRows(invoiceId, [...selectedRows]);
      if (currentInvoiceRef.current?.id !== invoiceId) return;
      adoptInvoice(document);
      pushToast(`${count} row${count === 1 ? "" : "s"} deleted.`, "neutral", {
        label: "Undo",
        run: () => {
          if (currentInvoiceRef.current?.id !== invoiceId) {
            pushToast("Undo is only available while the original invoice is open.");
            return;
          }
          if (busyActionRef.current) {
            pushToast("Wait for the current invoice action to finish.");
            return;
          }
          void (async () => {
            busyActionRef.current = "undo";
            setBusyAction("undo");
            try {
              await autosave.flush();
              if (currentInvoiceRef.current?.id !== invoiceId) return;
              clearBuiltOutput();
              const restored = await window.receiptApp.undoLastDelete(invoiceId);
              if (currentInvoiceRef.current?.id !== invoiceId) return;
              adoptInvoice(restored);
              pushToast("Delete undone.", "success");
            } catch (error) {
              pushToast(`Could not undo: ${messageFromError(error)}`, "error");
            } finally {
              if (busyActionRef.current === "undo") {
                busyActionRef.current = null;
                setBusyAction(null);
              }
            }
          })();
        },
      });
    } catch (error) {
      pushToast(`Could not delete rows: ${messageFromError(error)}`, "error");
    } finally {
      setBusyAction(null);
    }
  }, [
    adoptInvoice,
    autosave.flush,
    busyAction,
    clearBuiltOutput,
    invoice,
    pushToast,
    selectedRows,
  ]);

  const exportInvoice = async (asZip: boolean, includeDebug: boolean) => {
    if (!invoice) return;
    setBusyAction("export");
    try {
      await autosave.flush();
      const result = await window.receiptApp.exportPackage(invoice.id, { asZip, includeDebug });
      if (!result.canceled) {
        setExportOpen(false);
        pushToast(`${asZip ? "ZIP" : "Folder"} exported.`, "success");
      }
    } catch (error) {
      pushToast(`Export failed: ${messageFromError(error)}`, "error");
    } finally {
      setBusyAction(null);
    }
  };

  const revealInvoice = async () => {
    if (!invoice) return;
    try {
      await window.receiptApp.revealInvoice(invoice.id);
    } catch (error) {
      pushToast(`Could not open Finder: ${messageFromError(error)}`, "error");
    }
  };

  const runInvoiceCheck = async () => {
    if (!invoice || busyAction) return;
    const invoiceId = invoice.id;
    setBusyAction("check");
    try {
      const savedDocument = await autosave.flush();
      const documentToCheck = savedDocument ?? currentInvoiceRef.current;
      if (!documentToCheck || documentToCheck.id !== invoiceId) return;
      await refreshInvoiceCheck(invoiceId, documentToCheck.revision, {
        force: true,
        reportErrors: true,
      });
    } catch (error) {
      pushToast(`Could not save before checking: ${messageFromError(error)}`, "error");
    } finally {
      setBusyAction(null);
    }
  };

  const setReviewAcknowledgement = async (fingerprint: string, acknowledged: boolean) => {
    if (!invoice || busyAction) return;
    const invoiceId = invoice.id;
    setUpdatingReviewFingerprints(new Set([fingerprint]));
    setBusyAction("review");
    try {
      const savedDocument = await autosave.flush();
      const documentToUpdate = savedDocument ?? currentInvoiceRef.current;
      if (!documentToUpdate || documentToUpdate.id !== invoiceId) return;

      const result = await window.receiptApp.setReviewAcknowledgement(
        invoiceId,
        fingerprint,
        acknowledged,
        documentToUpdate.revision
      );
      if (
        result.invoice.id !== invoiceId ||
        result.check.invoiceId !== invoiceId ||
        result.check.revision !== result.invoice.revision
      ) {
        throw new Error("The review result did not match the open invoice.");
      }
      adoptInvoice(result.invoice, {
        checkResult: result.check,
        preserveBuiltOutput: true,
        preserveSelection: true,
      });
      pushToast(acknowledged ? "Review item checked off." : "Review item reopened.", "success");
    } catch (error) {
      const errorMessage = messageFromError(error);
      const revisionConflict = /revision|changed|conflict/i.test(errorMessage);
      pushToast(
        `Could not update the review checklist: ${errorMessage}`,
        "error",
        revisionConflict
          ? {
              label: "Reload",
              run: () => {
                if (currentInvoiceRef.current?.id !== invoiceId) return;
                if (busyActionRef.current) {
                  pushToast("Wait for the current invoice action to finish.");
                  return;
                }
                void reloadInvoiceFromDisk();
              },
            }
          : undefined
      );
    } finally {
      setUpdatingReviewFingerprints(new Set());
      setBusyAction(null);
    }
  };

  const buildOutput = async () => {
    if (!invoice || busyAction) return;
    const invoiceId = invoice.id;
    setBusyAction("build-output");
    try {
      await autosave.flush();
      if (currentInvoiceRef.current?.id !== invoiceId) return;
      const result = await window.receiptApp.buildInvoiceOutput(invoiceId);
      if (currentInvoiceRef.current?.id !== invoiceId) return;
      setBuiltOutput({ invoiceId, result });
      pushToast(
        `Output built with ${result.receiptCount} unique receipt file${result.receiptCount === 1 ? "" : "s"}.`,
        "success"
      );
    } catch (error) {
      pushToast(
        `Could not build output. Any previous output was left unchanged: ${messageFromError(error)}`,
        "error"
      );
    } finally {
      setBusyAction(null);
    }
  };

  const revealBuiltOutput = async () => {
    if (!invoice || !builtOutput || builtOutput.invoiceId !== invoice.id || busyAction) return;
    setBusyAction("reveal-output");
    try {
      await window.receiptApp.revealOutput(invoice.id);
    } catch (error) {
      pushToast(`Could not show the output folder: ${messageFromError(error)}`, "error");
    } finally {
      setBusyAction(null);
    }
  };

  const totals = useMemo(() => calculateTotals(rows), [rows]);
  const checkIssuesByRow = useMemo(
    () => indexInvoiceCheckIssuesByRow(invoiceCheckResult?.issues ?? [], rows),
    [invoiceCheckResult, rows]
  );
  const selectedReceiptCount = retryableSelectedReceiptIds.length;
  const detailRow = detailRowId ? (rows.find((row) => row.id === detailRowId) ?? null) : null;
  const detailReceipt =
    detailRow?.receiptId && invoice
      ? (invoice.receipts.find((receipt) => receipt.id === detailRow.receiptId) ?? null)
      : null;
  const detailReviewIssues = useMemo(() => {
    if (!detailRow || !invoiceCheckResult) return [];
    return invoiceCheckResult.issues.filter(
      (issue) =>
        isReviewIssue(issue) &&
        (issue.rowIds.includes(detailRow.id) ||
          (detailReceipt !== null && issue.receiptIds.includes(detailReceipt.id)))
    );
  }, [detailReceipt, detailRow, invoiceCheckResult]);

  const handleDragEnter = (event: DragEvent<HTMLElement>) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setDraggingFiles(true);
  };

  const handleDragLeave = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDraggingFiles(false);
  };

  if (booting) {
    return (
      <main className="loading-screen" aria-busy="true">
        <span className="loading-mark" aria-hidden="true">
          R
        </span>
        <p>Opening your local workspace…</p>
      </main>
    );
  }

  if (!settings?.baseFolder) {
    return (
      <>
        <Onboarding
          busy={busyAction === "folder"}
          error={bootError}
          onChooseFolder={() => void handleOnboardingFolder()}
        />
        <ToastRegion dismiss={dismissToast} toasts={toasts} />
      </>
    );
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: File drag events are delegated at the application boundary; the file picker remains the keyboard equivalent.
    <div
      className="app-shell"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files")) {
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }
      }}
      onDrop={dropFiles}
    >
      <Sidebar
        activeInvoiceId={invoice?.id ?? null}
        busy={busyAction != null}
        invoices={invoices}
        onNew={() => setNewInvoiceOpen(true)}
        onOpen={(id) => void openInvoice(id)}
        onSettings={() => setSettingsOpen(true)}
      />

      <main className="workspace">
        {bootError ? (
          <div className="workspace-error">
            <span aria-hidden="true">!</span>
            <p role="alert">
              <strong>Could not fully open the workspace.</strong> {bootError}
            </p>
            <button className="text-button" type="button" onClick={() => setBootError(null)}>
              Dismiss
            </button>
          </div>
        ) : null}
        {!settings.hasOpenAiKey ? (
          <div className="key-banner">
            <span aria-hidden="true">!</span>
            <p role="status">
              <strong>Add an OpenAI API key to scan receipts.</strong> Manual rows and exports still
              work.
            </p>
            <button className="text-button" type="button" onClick={() => setSettingsOpen(true)}>
              Open Settings
            </button>
          </div>
        ) : null}

        {!invoice ? (
          <section className="empty-workspace">
            <div className="empty-workspace-illustration" aria-hidden="true">
              ＋
            </div>
            <h1>Create your first invoice</h1>
            <p>Choose a billing period, then add receipt images or PDFs in one batch.</p>
            <button
              className="button button--primary button--large"
              type="button"
              onClick={() => setNewInvoiceOpen(true)}
            >
              New Invoice
            </button>
          </section>
        ) : (
          <>
            <header className="workspace-header">
              <div className="workspace-title">
                <p className="eyebrow">Client invoice</p>
                <h1>{invoice.name}</h1>
                <span>{formatPeriod(invoice.period.startDate, invoice.period.endDate)}</span>
              </div>
              <div className="workspace-summary">
                <div>
                  <span>Groceries</span>
                  <strong>{formatMoney(totals.groceriesMinor)}</strong>
                </div>
                <div>
                  <span>Labour</span>
                  <strong>{formatMoney(totals.labourMinor)}</strong>
                </div>
                <div className="workspace-summary-total">
                  <span>Invoice total</span>
                  <strong>{formatMoney(totals.invoiceMinor)}</strong>
                </div>
              </div>
            </header>

            <div className="toolbar" aria-label="Invoice actions" role="toolbar">
              <div className="toolbar-primary">
                <button
                  className="button button--primary"
                  disabled={busyAction != null}
                  title="Open the file picker for one or many receipt images or PDFs"
                  type="button"
                  onClick={() => void chooseReceipts()}
                >
                  <span aria-hidden="true">＋</span>
                  {busyAction === "import" ? "Importing…" : "Add Receipts"}
                </button>
                <button
                  className="button button--secondary"
                  disabled={busyAction != null}
                  type="button"
                  onClick={addManualRow}
                >
                  <span aria-hidden="true">✎</span>
                  Manual Row
                </button>
                <button
                  className="button button--secondary"
                  disabled={busyAction != null || selectedReceiptCount === 0}
                  title={
                    selectedReceiptCount === 0 ? "Select one or more receipt rows first" : undefined
                  }
                  type="button"
                  onClick={retrySelected}
                >
                  <span aria-hidden="true">↻</span>
                  Retry Selected
                </button>
                <button
                  className="button button--secondary"
                  disabled={busyAction != null}
                  title="Check for duplicate transactions, incomplete scans, and dates outside the invoice period"
                  type="button"
                  onClick={() => void runInvoiceCheck()}
                >
                  <span aria-hidden="true">✓</span>
                  {busyAction === "check" ? "Checking…" : "Check Invoice"}
                </button>
              </div>
              <div className="toolbar-secondary">
                {selectedRows.size > 0 ? (
                  <button
                    className="button button--danger-quiet"
                    disabled={busyAction != null}
                    type="button"
                    onClick={() => void deleteSelected()}
                  >
                    Delete {selectedRows.size}
                  </button>
                ) : null}
                <button
                  className="button button--secondary"
                  disabled={busyAction != null}
                  title="Build the invoice PDF and unique receipt files, replacing any previous output"
                  type="button"
                  onClick={() => void buildOutput()}
                >
                  <span aria-hidden="true">▣</span>
                  {busyAction === "build-output" ? "Building…" : "Build Output"}
                </button>
                <button
                  className="button button--secondary"
                  disabled={busyAction != null}
                  type="button"
                  onClick={() => void copyTsv()}
                >
                  <span aria-hidden="true">⧉</span>
                  Copy TSV
                </button>
                <button
                  className="button button--secondary"
                  disabled={busyAction != null}
                  type="button"
                  onClick={() => setExportOpen(true)}
                >
                  <span aria-hidden="true">⇧</span>
                  Export…
                </button>
                <button
                  className="button button--danger-quiet"
                  disabled={busyAction != null}
                  type="button"
                  onClick={() => {
                    setRemoveInvoiceError(null);
                    setRemoveInvoiceConflict(false);
                    setRemoveInvoiceOpen(true);
                  }}
                >
                  Remove Invoice…
                </button>
                <button
                  aria-label="Reveal invoice in Finder"
                  className="icon-button icon-button--bordered"
                  disabled={busyAction != null}
                  title="Reveal in Finder"
                  type="button"
                  onClick={() => void revealInvoice()}
                >
                  ⌕
                </button>
              </div>
            </div>

            {invoiceCheckResult && checkSummaryVisible ? (
              <InvoiceCheckSummary
                disabled={busyAction != null}
                result={invoiceCheckResult}
                updatingFingerprints={updatingReviewFingerprints}
                onDismiss={dismissInvoiceCheck}
                onToggle={(fingerprint, acknowledged) =>
                  void setReviewAcknowledgement(fingerprint, acknowledged)
                }
              />
            ) : null}

            {builtOutput?.invoiceId === invoice.id ? (
              <OutputReadyBanner
                disabled={busyAction != null}
                revealing={busyAction === "reveal-output"}
                result={builtOutput.result}
                onDismiss={clearBuiltOutput}
                onReveal={() => void revealBuiltOutput()}
              />
            ) : null}

            {importProgress ? (
              <div className="import-progress" role="status" aria-live="polite">
                <div className="import-progress-copy">
                  <span className="progress-spinner" aria-hidden="true" />
                  <strong>
                    {importProgress.status === "copying"
                      ? "Copying"
                      : importProgress.status === "duplicate"
                        ? "Checking duplicate"
                        : importProgress.status === "error"
                          ? "Import issue"
                          : "Scanning"}
                  </strong>
                  <span title={importProgress.filename}>{importProgress.filename}</span>
                  <small>
                    {Math.min(importProgress.current, importProgress.total)} of{" "}
                    {importProgress.total}
                  </small>
                </div>
                <progress
                  max={Math.max(importProgress.total, 1)}
                  value={Math.min(importProgress.current, importProgress.total)}
                />
              </div>
            ) : null}

            <section className="grid-panel" aria-busy={busyAction != null}>
              <div className="grid-panel-heading">
                <div>
                  <h2>Invoice rows</h2>
                  <span>
                    {rows.length} {rows.length === 1 ? "row" : "rows"}
                  </span>
                </div>
                <SaveIndicator
                  error={autosave.saveError}
                  status={autosave.status}
                  onReload={() => void reloadInvoiceFromDisk()}
                  onRetry={autosave.retry}
                />
              </div>
              <InvoiceGrid
                activeRowId={detailRowId}
                checkIssuesByRow={checkIssuesByRow}
                disabled={busyAction != null}
                focusRowId={focusRowId}
                receipts={invoice.receipts}
                rows={rows}
                selectedRows={selectedRows}
                sortColumns={sortColumns}
                onDeleteSelected={() => void deleteSelected()}
                onFocusRowHandled={() => setFocusRowId(null)}
                onOpenRow={setDetailRowId}
                onRowsChange={updateRows}
                onSelectedRowsChange={setSelectedRows}
                onSortColumnsChange={handleSortColumnsChange}
              />
              <div className="grid-help-line">
                <span>Click a column header to sort. Double-click a cell to edit.</span>
                <span>The file picker and drag-and-drop both accept one file or a batch.</span>
              </div>
            </section>
          </>
        )}
      </main>

      {detailRow && invoice ? (
        <ReceiptDrawer
          invoiceId={invoice.id}
          receipt={detailReceipt}
          reviewDisabled={busyAction != null}
          reviewIssues={detailReviewIssues}
          row={detailRow}
          updatingFingerprints={updatingReviewFingerprints}
          onClose={() => setDetailRowId(null)}
          onRetry={(receiptId) => void retryReceiptIds([receiptId])}
          onToggleReview={(fingerprint, acknowledged) =>
            void setReviewAcknowledgement(fingerprint, acknowledged)
          }
        />
      ) : null}

      {draggingFiles ? (
        <div className="drop-overlay" aria-hidden="true">
          <div>
            <span>↓</span>
            <strong>Drop one or many receipts to add them</strong>
            <small>A batch of images and PDFs will be copied into this invoice.</small>
          </div>
        </div>
      ) : null}

      {newInvoiceOpen ? (
        <NewInvoiceModal
          busy={busyAction === "create"}
          onClose={() => setNewInvoiceOpen(false)}
          onCreate={createInvoice}
        />
      ) : null}
      {settingsOpen ? (
        <SettingsModal
          settings={settings}
          onChooseFolder={chooseFolder}
          onClose={() => setSettingsOpen(false)}
          onSettingsChange={setSettings}
        />
      ) : null}
      {exportOpen ? (
        <ExportModal
          busy={busyAction === "export"}
          onClose={() => setExportOpen(false)}
          onExport={exportInvoice}
        />
      ) : null}
      {removeInvoiceOpen && invoice ? (
        <RemoveInvoiceModal
          busy={busyAction === "remove-invoice"}
          error={removeInvoiceError}
          invoiceName={invoice.name}
          onClose={() => {
            setRemoveInvoiceError(null);
            setRemoveInvoiceConflict(false);
            setRemoveInvoiceOpen(false);
          }}
          onReload={
            removeInvoiceConflict
              ? () => {
                  setRemoveInvoiceError(null);
                  setRemoveInvoiceConflict(false);
                  setRemoveInvoiceOpen(false);
                  void reloadInvoiceFromDisk();
                }
              : undefined
          }
          onRemove={removeActiveInvoice}
        />
      ) : null}
      <ToastRegion dismiss={dismissToast} toasts={toasts} />
    </div>
  );
}
