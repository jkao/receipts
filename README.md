# Receipt Invoice

Receipt Invoice is a small, single-user macOS app that turns local receipt images and PDFs into an editable client-invoice table. It is designed for one Mac, one local or Dropbox-mounted working folder, and as little infrastructure as possible.

The app has no server, SQLite database, Google login, Dropbox API, or watched-folder automation. Its only runtime network calls are testing the user-provided OpenAI key and sending receipts to OpenAI for extraction.

## Quick start

### Requirements

- An Apple Silicon Mac running macOS.
- Node.js 20 or newer, including `npm`.
- `make`, which is normally available after installing Apple's Command Line Tools.
- An OpenAI API key if you want automatic receipt scanning. Manual rows work without one.

Check the required commands:

~~~sh
node --version
npm --version
make --version
~~~

From this project folder, install dependencies and start the app:

~~~sh
make setup
make run
~~~

`make run` creates a production build and launches it locally. After the first `make setup`, the normal day-to-day command is simply:

~~~sh
make run
~~~

Run `make help` at any time to see every supported command.

## First launch

1. Choose a working folder. A locally available Dropbox folder is fine.
2. Open **Settings**.
3. Paste an OpenAI API key, click **Test Key**, and then **Save Key**.
4. Optionally change the default hourly rate.
5. Create an invoice and choose its inclusive start and end dates.
6. Drop one or many receipt images/PDFs into the window, or click **Add Receipts** and select a batch with Command- or Shift-click.
7. Review the scanned rows, edit any cells, and add hours as needed. Rows start in ascending Date order; click any user-column header to sort by that column.
8. Click **Check Invoice** to review possible duplicates, scan warnings, incomplete rows, and dates outside the invoice period. Check off advisory findings after verifying them; retry or fix operational scan failures.
9. Use **Copy TSV** for Google Sheets, then click **Build Output** when the client package is ready to send.

The saved API key is encrypted with Electron `safeStorage` before its ciphertext is written to the app's macOS Application Support directory. It is never written to the invoice folder, source tree, TSV/CSV files, or exports. Do not put API keys in this repository or in an `.env` file.

## Common commands

| Goal | Make command | Direct npm equivalent |
| --- | --- | --- |
| Install dependencies | `make setup` | `npm install` |
| Compile and run locally | `make run` | `npm run build && npm start` |
| Run development mode | `make dev` | `npm run dev` |
| Compile production assets | `make compile` | `npm run build` |
| Run tests | `make test` | `npm test` |
| Run tests with coverage | `make coverage` | `npm run test:coverage` |
| Type-check | `make typecheck` | `npm run typecheck` |
| Lint source | `make lint` | `npm run lint` |
| Format source | `make fmt` | `npm run format` |
| Verify formatting | `make fmt-check` | `npm run format:check` |
| Run the release checks | `make check` | `npm run check` |
| Package the macOS app | `make package` | `npm run package:mac` |
| Open the packaged app | `make open-app` | `open "release/mac-arm64/Receipt Invoice.app"` |
| Audit production dependencies | `make audit` | `npm audit --omit=dev` |

### Production run versus development mode

- `make run` builds the renderer and Electron main process, then launches those compiled files. Use this for ordinary local use and final checks.
- `make dev` starts Vite on `127.0.0.1:5173` and Electron together. UI edits hot-reload, so this is the convenient mode while changing the app. Press Control-C in the terminal to stop it.

## What the app does

- Creates one date-range folder per invoice in any selected local directory.
- Bulk imports JPEG, PNG, WebP, HEIC/HEIF, and ordinary unencrypted PDF receipts up to the 20 MB safe-processing limit.
- Copies originals into the invoice and detects exact duplicates using SHA-256.
- Extracts the merchant, transaction date, final total, and optional line items.
- Provides an editable six-column grid: Date, Groceries MP, Hours Worked, Rate, Labour Total, and Comment.
- Sorts all six user columns from their headers, with stable blanks-last ordering and ascending Date as the default.
- Calculates groceries, hours, labour, and combined invoice totals exactly.
- Keeps the component `Total` row and adds a final `Grand Total` row whose combined groceries-plus-labour amount appears in the `Labour Total` column.
- Tracks each imported receipt as Manual plus its drag/drop or file-picker source.
- Continuously writes `invoice.json`, `invoice.tsv`, and `invoice.csv` using atomic file updates.
- Shows the managed receipt file path, source preview, itemization, validation warnings, and scan metadata on click.
- Lets you pinch or use the preview controls to zoom images, then drag to pan around them.
- Copies spreadsheet-ready TSV and exports client/debug folders or ZIP files.
- Builds an invoice-local `output/invoice.pdf` plus one receipt copy per unique SHA-256 under `output/receipts/`.
- **Check Invoice** detects exact receipt duplicates, warns about likely duplicate transactions, surfaces completed-scan validation warnings, and highlights incomplete rows or dates outside the invoice's inclusive range.
- Lets the user mark advisory findings reviewed while keeping receipt scan status unchanged. The acknowledgment is tied to the exact causal evidence, so a materially changed row or a new scan must be reviewed again.
- Keeps operational scan states such as queued, scanning, needs-key, and error visible and non-acknowledgeable. The check itself does not block editing, copy, export, or output building.
- Moves deleted managed files into invoice-local trash and supports one-step undo.
- Removes an invoice recoverably by writing `DELETED.json`, with an explicit opt-in option to
  permanently delete that invoice folder and all of its local files.

Original input files are never moved, modified, or deleted.

The receipt/incomplete category is deterministic rather than a model probability. A completed scan marked `needs-review` exposes its saved validation warnings as advisory checklist items. Operational states such as queued, scanning, needs-key, or error cannot be checked off; retry or fix those scans instead. Missing receipt links, required fields, possible duplicates, and out-of-period dates are advisory because a user may have valid reasons to keep them. Acknowledging a finding records review only: it does not change receipt status, edit fields, merge rows, or hide the finding. If the evidence that caused it changes, the old acknowledgment is ignored.

**Check Invoice** is advisory and never gates **Build Output**, **Copy TSV**, or **Export**. Output creation still fails safely for hard managed-file integrity problems such as a missing receipt, a symbolic link, or a SHA-256 mismatch.

### Sorting and saved order

All six user columns are sortable from their headers. Date ascending is the initial default, and switching to a different invoice resets the active sort to that chronological default. Reloading updates to the same invoice keeps its current active sort. Blank values stay at the bottom in both directions, and equal values retain their existing relative order.

Sorting changes the invoice's saved row order rather than creating a temporary screen-only view. The visible order is therefore the order used by `invoice.tsv`, `invoice.csv`, clipboard TSV, and `output/invoice.pdf`. New imports and manual rows are placed into the current sort automatically; under the default Date sort, a newly scanned or edited out-of-order date moves to its chronological position.

## Local data layout

The selected working folder is the database. Each invoice looks like this:

~~~text
invoice-2026-01-01-2026-01-31/
  invoice.json
  invoice.json.bak  # appears after the first update
  DELETED.json      # soft removal, or an interrupted permanent deletion
  invoice.tsv
  invoice.csv
  receipts/
  debug/
  .trash/
  output/
    invoice.pdf
    receipts/
~~~

- `invoice.json` is the authoritative editable state.
- `invoice.tsv` and `invoice.csv` are regenerated views for spreadsheets.
- `receipts/` contains managed copies of the source receipts.
- `debug/` contains normalized extraction and optional itemization data.
- `.trash/` supports safe row/receipt deletion and undo.
- `output/invoice.pdf` is the client-facing invoice, and `output/receipts/` contains one copy for each unique receipt SHA-256 referenced by the invoice.
- `invoice.json.bak` retains the previous valid invoice state.
- `DELETED.json` is a portable deletion sentinel. When present, the app omits that invoice from the
  sidebar and will not silently reopen or recreate it.

Building the client output reconstructs the complete `output/` directory and replaces the previous version only after the new build succeeds. Receipts removed from the invoice therefore cannot linger as stale client attachments. Editing, importing, rescanning, deleting, or restoring invoice data clears the in-app ready state; click **Build Output** again before sending. If a rebuild fails, the previous output remains intact. The build reads the invoice's managed receipt copies; original files selected from Dropbox or elsewhere are never changed, moved, or deleted.

Moving or backing up the complete working folder preserves the invoices. Dropbox may sync it like any other local folder, but the app does not connect to Dropbox itself.

### Removing an invoice

**Remove Invoice** defaults to a recoverable removal: the invoice folder and all files stay in
place, and the app writes a visible `DELETED.json` marker inside it. To restore that invoice, quit
the app, confirm the marker does not say `"hardDeleteIncomplete": true`, delete only its
`DELETED.json` file in Finder, and reopen the app.

The confirmation dialog also contains an unchecked option to permanently delete the entire local
invoice folder. That hard-delete path cannot be undone by this app or restored from its invoice
trash; recovery would require an external backup or Dropbox file history. If permanent deletion is
interrupted, the surviving marker records `"hardDeleteIncomplete": true`; some files may already be
gone, so inspect a backup rather than treating that folder as a normal recoverable removal.

## Package the desktop app

~~~sh
make check
make package
~~~

The Apple Silicon bundle is created at:

~~~text
release/mac-arm64/Receipt Invoice.app
~~~

Open it with `make open-app` or through Finder. The bundle is intentionally unsigned and intended for this Mac. If Gatekeeper blocks the first launch, right-click the app in Finder, choose **Open**, and confirm. Distributing it to other Macs would require code signing and notarization.

## Development notes

The main areas of the source tree are:

~~~text
src/main/       Electron lifecycle, filesystem, imports, exports, and OpenAI
src/renderer/   React user interface
src/shared/     Data types, exact finance math, and TSV/CSV generation
~~~

Before handing off a change, run:

~~~sh
make check
~~~

OpenAI tests use mocked responses. They do not need a key and never make a live API request.

`make coverage` writes the browsable V8 report to `coverage/index.html` and the machine-readable
summary to `coverage/coverage-summary.json`. Coverage includes the Electron main process, renderer,
and shared business logic; only bootstrap files and type-only declarations are excluded. The
configured thresholds are enforced by both `make coverage` and `make check`.

For the review findings, fixes, measured coverage, and explicitly deferred hardening work, see
[CODE_REVIEW.md](./CODE_REVIEW.md).

## Troubleshooting

- **`node`, `npm`, or `make` is missing:** install Node.js 20+ and Apple's Command Line Tools, then reopen Terminal.
- **Development mode says port 5173 is in use:** stop the other Vite process, then run `make dev` again.
- **A receipt stays at Needs key:** open Settings and save a successfully tested OpenAI key. The row remains manually editable in the meantime.
- **A scan fails:** confirm the file is a supported image or unencrypted PDF no larger than 20 MB, then select the row and choose **Retry Selected**.
- **The working folder is unavailable:** make Dropbox files available offline or choose another local folder in Settings.
- **The app reports that an invoice changed on disk:** reload it from disk rather than overwriting the newer revision.
- **A removed invoice should be restored:** quit the app and inspect its `DELETED.json`. If it does
  not contain `"hardDeleteIncomplete": true`, remove the marker and reopen the app. If that flag is
  present, some files may already be missing; restore from a backup instead.

## OpenAI behavior

Receipt extraction uses the Responses API with `gpt-5.6-luna`, reasoning effort `none`, `store: false`, direct image/PDF input, and strict JSON-schema Structured Outputs. Receipt contents are treated as untrusted data, and extracted amounts/dates are checked deterministically before being shown for editing.

- [OpenAI file-input documentation](https://developers.openai.com/api/docs/guides/file-inputs)
- [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- [GPT-5.6 Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna)

For more detail about product decisions and deferred features, see [RECEIPT_DESKTOP_APP_PLAN.md](./RECEIPT_DESKTOP_APP_PLAN.md).
