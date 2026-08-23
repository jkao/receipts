import { useId, useState } from "react";
import type { InvoicePeriod, InvoiceRemovalResult, SettingsView } from "../../shared/types";
import { messageFromError, parseMoneyInput, todayIso } from "../lib/format";
import { ModalFrame } from "./ModalFrame";
import { ReceiptUploadDisclosure } from "./ReceiptUploadDisclosure";
import type { ToastTone } from "./ToastRegion";

interface NewInvoiceModalProps {
  busy: boolean;
  onClose: () => void;
  onCreate: (period: InvoicePeriod) => Promise<void>;
}

export function NewInvoiceModal({ busy, onClose, onCreate }: NewInvoiceModalProps) {
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

export function SettingsModal({
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
          <ReceiptUploadDisclosure compact />
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
          <div
            className={`settings-message settings-message--${message.tone}`}
            role={message.tone === "error" ? "alert" : "status"}
          >
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

export function ExportModal({ busy, onClose, onExport }: ExportModalProps) {
  const [asZip, setAsZip] = useState(true);
  const [includeDebug, setIncludeDebug] = useState(false);

  return (
    <ModalFrame
      closeDisabled={busy}
      eyebrow="Spreadsheet and source receipts"
      title="Export Spreadsheet Package"
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
          Export TSV and CSV copies of the invoice table with its source receipts. This package does
          not include the client PDF; use Build PDF Output for that. Your working folder is not
          changed.
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
            {busy ? "Exporting…" : `Export Spreadsheet ${asZip ? "ZIP" : "Folder"}`}
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
