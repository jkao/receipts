import { ReceiptUploadDisclosure } from "./ReceiptUploadDisclosure";

interface OnboardingProps {
  busy: boolean;
  error: string | null;
  onChooseFolder: () => void;
}

export function Onboarding({ busy, error, onChooseFolder }: OnboardingProps) {
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
        <ReceiptUploadDisclosure />
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
