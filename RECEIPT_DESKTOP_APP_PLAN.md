# Receipt Invoice App — Simplified macOS MVP Plan

Last reviewed: 2026-08-21

## Recommendation

Build a small, single-user macOS desktop app with:

- Electron, React, and TypeScript.
- OpenAI as the first receipt-extraction provider.
- A user-selected folder as the database.
- One subfolder per invoice period.
- An editable table that matches the existing client spreadsheet.
- Clipboard TSV, CSV, ordinary-folder, and ZIP exports.

Do not add SQLite, Azure, Google Sheets integration, a hosted backend, watched-folder automation, or multi-provider checking to the first release.

The app's only direct network operation is receipt extraction: when files are imported, it sends them to OpenAI. Everything else is managed through local files. If the chosen base folder is inside Dropbox, Dropbox may sync those invoice files independently; the app has no Dropbox integration.

## What the app needs to produce

The primary table should match the existing sheet:

| Column | Meaning | Behavior |
| --- | --- | --- |
| Date | Receipt or work date | Date picker; scanned when a receipt is attached |
| Groceries MP | Final receipt total | Scanned, then editable |
| Hours Worked | Billable hours | Manual entry |
| Rate | Hourly rate | Defaults from invoice settings; editable |
| Labour Total | Hours × rate | Read-only calculated value |
| Comment | Usually the merchant | Scanned, then editable |

The footer calculates:

- Total receipt costs.
- Total hours.
- Total labour.
- Invoice total: receipt costs + labour.

Spreadsheet TSV/CSV output keeps the existing six-column component `Total` row, then appends this final six-cell row:

~~~text
Grand Total |  |  |  | combined groceries + labour | Groceries + Labour
~~~

The combined amount uses the `Labour Total` position because it is the table's final numeric total column; the comment cell makes clear that the value includes both groceries and labour.

A row may contain a receipt, work hours, or both. Work-only rows are allowed. No general spreadsheet formula engine is needed.

Receipt line items are diagnostic data, not part of the normal table. Clicking a receipt-backed row opens a drawer containing the source preview, extracted fields, optional itemization, validation warnings, and file hash.

Store dates as ISO YYYY-MM-DD values. Display and copy them as MM/DD by default to match the current sheet, with a full-year export option.

All six user columns are sortable from their headers. Use one active sort column at a time, initially defaulting to Date ascending and returning to that default when the user switches to a different invoice; updates adopted for the same invoice retain its active sort. Comparisons are stable and keep blank values last in both ascending and descending directions. Sorting reorders and saves the invoice rows themselves, so the visible order is authoritative for TSV, CSV, clipboard, and PDF output rather than being a temporary presentation layer.

## Core workflow

1. On first launch, choose a base folder, such as a locally available Dropbox directory.
2. Enter an OpenAI API key in Settings.
3. Click New invoice and choose inclusive start and end dates.
4. The app creates a folder such as invoice-2026-01-01-2026-02-01.
5. Drag several images/PDFs into the window or select them with a file picker.
6. The app hashes each source, checks for duplicates, copies it into the invoice folder, and scans it.
7. Each successful scan creates an editable table row using the receipt date, final total, and merchant.
8. Fix any uncertain values and add hours/rates as needed.
9. Run Check Invoice to review duplicate, completed-scan validation, incomplete-row, and out-of-period-date warnings. Mark advisory findings reviewed; retry or fix operational scan failures.
10. Copy the table as TSV when needed, then build the client output at `output/invoice.pdf` and `output/receipts/`; optionally use ZIP/folder export for a spreadsheet/debug package.

Original input files are never moved, modified, or deleted.

## Folder-as-database design

### App settings

Store machine-level settings outside the selected base folder:

~~~text
~/Library/Application Support/Receipt Invoice/settings.json
~~~

Example:

~~~json
{
  "schemaVersion": 1,
  "baseFolder": "/Users/jeff/Dropbox/Client Invoices",
  "openaiApiKeyEncrypted": "BASE64_ENCRYPTED_VALUE",
  "defaultRateMinor": 4500
}
~~~

This still follows the requested simple local JSON setup. Electron's built-in safeStorage encrypts the user-entered key with macOS-backed protection before the Base64 ciphertext is serialized into settings.json. The app should:

- Create the settings file with owner-only permissions (mode 0600).
- Mask the key in the UI and provide Test and Delete buttons.
- Never put settings or API keys in the Dropbox/base folder or an export.
- Keep provider calls in the Electron main process so the renderer never receives the key.
- Never ship a shared key inside the app; this private build uses a key entered by its owner.

### Invoice folders

The selected base folder is the complete portable data store:

~~~text
Client Invoices/
  invoice-2026-01-01-2026-02-01/
    invoice.json
    invoice.tsv
    invoice.csv
    receipts/
      r_a1b2c3d4__whole-foods.jpg
      r_e5f6g7h8__key-foods.pdf
    debug/
      r_a1b2c3d4.json
      r_e5f6g7h8.json
    .trash/
    output/
      invoice.pdf
      receipts/
  invoice-2026-01-01-2026-02-01.zip
~~~

The two dates are inclusive and mirror the dates selected in the UI. The example above means January 1 through February 1; a January-only invoice would use invoice-2026-01-01-2026-01-31.

- invoice.json is the authoritative editable state.
- invoice.tsv and invoice.csv are regenerated views for people and spreadsheets.
- receipts contains copies managed by this invoice.
- debug contains normalized extraction results and itemization.
- .trash makes row/file deletion recoverable.
- output/invoice.pdf is the client-facing invoice, and output/receipts contains one attachment per unique receipt SHA-256 in the invoice.
- The ZIP is created only when explicitly requested.

On launch, the app discovers invoices by scanning immediate child folders for invoice.json. There is no global index and no hidden database. Moving the whole base folder to another Mac preserves all invoice data. Creating an invoice whose date-range folder already exists opens the existing invoice; it never overwrites it.

### Suggested invoice.json shape

~~~json
{
  "schemaVersion": 1,
  "id": "inv_01...",
  "name": "invoice-2026-01-01-2026-02-01",
  "period": {
    "startDate": "2026-01-01",
    "endDate": "2026-02-01"
  },
  "defaultRateMinor": 4500,
  "currency": "USD",
  "rows": [
    {
      "id": "row_01...",
      "date": "2026-01-12",
      "groceriesMinor": 1073,
      "hours": "4.50",
      "rateMinor": 4500,
      "comment": "Key Foods",
      "receiptId": "rcpt_01..."
    }
  ],
  "receipts": [
    {
      "id": "rcpt_01...",
      "relativePath": "receipts/r_a1b2c3d4__key-foods.jpg",
      "debugPath": "debug/r_a1b2c3d4.json",
      "originalFilename": "IMG_1234.jpg",
      "sha256": "a1b2c3d4...",
      "source": {
        "kind": "manual",
        "method": "drag-drop"
      },
      "status": "ready"
    }
  ],
  "createdAt": "2026-02-02T15:00:00Z",
  "updatedAt": "2026-02-02T15:05:00Z"
}
~~~

Use integer minor units for money and decimal strings for hours. Calculate totals instead of storing them, so stale formulas cannot occur.

Save safely by writing invoice.json.tmp, syncing it, renaming it over invoice.json, and retaining the previous valid file as invoice.json.bak. Enforce Electron's single-instance lock, serialize all writes for an invoice through one save queue, and use the document revision to reject stale app writes. Editing invoice.json externally while that invoice is open is outside the single-user MVP.

## Table and CRUD behavior

The invoice screen is the main screen. It should feel like a small spreadsheet, not an accounting system.

Required interactions:

- Click or press Enter to edit a cell.
- Tab, Shift-Tab, and arrow-key navigation.
- Activate any of the six user-column headers with a click, Enter, or Space to sort; expose the current direction through the grid header's accessible sort state.
- A date picker for every date cell.
- Append a blank manual row.
- Edit any input cell and delete selected rows.
- Multi-select with checkboxes and Shift-click.
- Bulk retry scans, copy, or delete for selected rows; export the complete invoice package.
- Remove an invoice with a confirmation dialog. The default recoverable path writes a visible
  `DELETED.json` sentinel and preserves its folder; a separate unchecked confirmation option may
  permanently delete that exact invoice folder and every local file inside it.
- An advisory Check Invoice action that highlights possible duplicates, completed-scan validation warnings, incomplete rows, operational scan states, and dates outside the inclusive invoice period. Advisory findings can be acknowledged without changing scan status; operational states cannot be acknowledged and remain visible until retried or fixed. The check never gates output, edits, merges, or deletes rows.
- Undo the most recent deletion.
- Open a receipt or PDF preview from its row.
- Drag more files into the current invoice at any time.

Date ascending is the default sort. A different active header sort is allowed during the current invoice session, but switching invoices restores chronological Date order. Equal sort keys retain their current relative order, and blank cells remain at the bottom for both directions. Any sort result is passed through the normal revisioned autosave path; selection and receipt/detail identity remain attached to row IDs while rows move.

Persist review acknowledgments on the invoice as a finding fingerprint plus timestamp, separate from each receipt's scan status. Construct the fingerprint from the issue code, affected row/receipt IDs, and canonical causal evidence used by the detector. Cosmetic changes that do not alter the predicate keep an acknowledgment; materially changed evidence or a new scan timestamp produces a new, unacknowledged finding. Read-only checks ignore obsolete fingerprints, and a subsequent acknowledgment mutation prunes obsolete entries under the normal expected-revision save. The toggle response returns both the newly revisioned invoice and a check result for that same revision so the renderer can adopt them together without starting a redundant row autosave.

Autosave after edits settle briefly, then regenerate TSV and CSV atomically. Also regenerate missing or stale TSV/CSV files whenever an invoice opens and immediately before copy/export. Because sorting saves the row sequence, TSV/CSV/PDF output always follows the order currently visible in the grid. If a row is deleted, move its managed receipt/debug files to the invoice's .trash directory. Never affect the original source file.

Show a small Manual source badge on receipt-backed rows and the import method/original filename in the detail drawer. Automation is only a reserved future source type.

Invoice discovery ignores folders containing `DELETED.json`, and loading or recreating the same
period must surface a recovery message rather than silently resurrecting it. The marker travels with
the folder and is therefore more consistent with the folder-as-database design than a machine-local
deletion index. Permanent deletion must be revision-checked and constrained to the canonical,
immediate-child invoice folder; it must never accept a renderer-provided filesystem path.
Before removing files it records `hardDeleteIncomplete: true` in the sentinel. Successful deletion
removes the whole folder; interruption leaves explicit partial-loss recovery guidance on disk.

The only calculated cells are:

~~~text
row labour = hours × rate
receipt total = sum(groceries)
hours total = sum(hours)
labour total = sum(row labour)
invoice total = receipt total + labour total
~~~

Use decimal-safe arithmetic and integer cents, not JavaScript floating-point money.

## Bulk receipt import

Accept:

- JPEG, PNG, WebP, HEIC/HEIF, and ordinary unencrypted PDFs.
- Multiple files from drag/drop.
- Multiple files from the macOS file picker.

For each file:

1. Read and hash the original.
2. Run the exact-deduplication check.
3. Copy it into receipts with a sanitized, short-hash-prefixed filename.
4. Create a receipt record with source.kind = manual and method = drag-drop or file-picker.
5. Queue one extraction request.
6. Add or update its table row.
7. Store the extraction details under debug.

Process the queue sequentially in the MVP. This is fast enough for personal batches, makes progress understandable, and avoids API rate-limit/concurrency work.

After each import or manual date edit, insert/reposition the row according to the active stable sort. In the default Date-ascending view, late-arriving older receipts move into chronological position automatically; missing dates remain below all dated rows.

Keep source.kind in the file format as manual or automation from day one, but the MVP always writes manual. That preserves the requested provenance distinction without building an automation system yet.

On macOS, convert HEIC/HEIF to a temporary JPEG with the system ImageIO tooling before upload. Do not rely on Sharp's packaged binaries for HEIC decoding.

## Simple deduplication

Use two checks:

### 1. Exact-file duplicate

Calculate SHA-256 before copying.

- Match in the current invoice: skip the import and focus the existing row.
- Match in another invoice: warn with the matching invoice name. Default to Skip, but allow Import anyway.

Build the lookup in memory by scanning invoice.json files when the app starts. No SQLite index is needed at this scale.

### 2. Likely same transaction

After extraction, compare:

~~~text
normalized merchant + date + currency + final total
~~~

A match is only a warning. Show the two rows and let the user Keep both or Remove new copy. Do not auto-delete based on model-extracted fields.

Skip perceptual image hashes, duplicate graphs, and automatic merging in the MVP. SHA-256 verifies identical bytes; item sums and subtotal/tax/total arithmetic validate an extraction. Itemization is useful evidence, but it is not a cryptographic checksum.

## Receipt extraction service

### MVP: OpenAI

Use the OpenAI Responses API with direct image/PDF input and Structured Outputs. OpenAI's PDF input pipeline makes both extracted text and page images available to vision-capable models, which avoids adding a separate OCR service.

Pin gpt-5.6-luna for the first release and set reasoning effort to none for this extraction task. Do not accept an arbitrary model name in Settings: a model change should be allowlisted and re-run against the receipt test set. As of 2026-08-20, OpenAI lists Luna at $0.20 per million input tokens and $1.20 per million output tokens. Actual receipt cost varies with image/PDF size and output length, so record API usage and test a real sample rather than promising a fixed cost.

Use Responses API text.format with type json_schema and strict schema validation. Mark every property as required, use nullable unions for unavailable scalar values, and set additionalProperties to false on every object. The normalized result should resemble:

~~~json
{
  "merchant": "Whole Foods",
  "date": "2026-01-12",
  "currency": "USD",
  "subtotal": "11.00",
  "tax": "0.73",
  "tip": null,
  "adjustments": [
    {
      "description": "Coupon",
      "amount": "-1.00"
    }
  ],
  "total": "10.73",
  "items": [
    {
      "description": "Example item",
      "quantity": "1",
      "unitPrice": "11.00",
      "lineTotal": "11.00"
    }
  ]
}
~~~

Amounts should be decimal strings or null in provider output. Arrays are present even when empty. The app parses monetary values into integer cents. Structured output guarantees the JSON shape, not factual accuracy; validation warnings are calculated by the app rather than invented by the model.

Run deterministic checks after every scan:

- A date and final total were found.
- The date is plausible; warn if it is outside the invoice range.
- Subtotal + tax + tip + signed adjustments approximately equals total when all printed components were captured.
- Item totals approximately equal the subtotal when itemization exists.
- Currency is supported.

Anything missing or inconsistent is highlighted in the table/detail drawer. Manual correction is always allowed, and a failed scan can become a fully manual row.

Treat all receipt text as untrusted data, not as instructions. The extraction request gets no tools or filesystem abilities. Do not log API keys or Base64 file payloads.

Set store: false to avoid Responses application-state storage. This does not mean zero retention: under OpenAI's default API data controls, abuse-monitoring logs may retain customer content for up to 30 days. That tradeoff is acceptable here because the user confirmed the receipts contain no regulated data.

Each debug JSON needs only one normalized extraction record containing provider, model, scan time, fields, items, usage, and app-generated validation warnings.

Official references:

- [OpenAI file inputs](https://developers.openai.com/api/docs/guides/file-inputs)
- [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- [OpenAI Luna model and pricing](https://developers.openai.com/api/docs/models/gpt-5.6-luna)
- [OpenAI API data controls](https://developers.openai.com/api/docs/guides/your-data)

### Future fallback: Claude

Do not build a second provider into the MVP. If the extraction proof fails on difficult receipts, benchmark Anthropic's exact model ID claude-haiku-4-5-20251001 before changing the rest of the architecture. Anthropic currently documents direct image/PDF input, JSON-schema output, and pricing of $1 per million input tokens and $5 per million output tokens. The provider-independent normalized receipt JSON is enough preparation for now.

- [Anthropic model overview and pricing](https://platform.claude.com/docs/en/about-claude/models/overview)
- [Anthropic Structured Outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)

## Copy and export

### Clipboard and files

Provide:

- Copy selected rows as TSV when rows are selected; otherwise copy all rows.
- Include headers in clipboard TSV and include both the component `Total` row and final `Grand Total` row for a whole-invoice copy.
- Continuously generate CSV and TSV files in the invoice folder.
- Reveal the invoice folder in Finder.

TSV/CSV cells should contain spreadsheet-native numbers without dollar signs. Replace embedded tabs/newlines in text. Prefix comments beginning with =, +, -, or @ so scanned merchant text cannot become a spreadsheet formula after paste.

The exported six columns contain values, including Labour Total. Their row sequence exactly matches the current saved/visible grid order, and the PDF uses that same order. Google Sheets integration and formulas are not needed.

### Client ZIP or ordinary folder

Before optional ZIP/folder sharing, build the invoice-local client output:

~~~text
output/
  invoice.pdf
  receipts/
    r_<sha-prefix>__merchant.ext
~~~

TSV/CSV use the documented six-cell component `Total` and `Grand Total` rows. The PDF presents the same groceries, hours, labour, and combined grand-total values in its dedicated summary and totals block rather than forcing those summaries into ordinary table rows. `output/receipts/` includes exactly one attachment for each distinct SHA-256, so duplicate receipt records cannot create duplicate client attachments.

Every build creates the complete output in a temporary sibling location and replaces the old `output/` directory only after the PDF and receipt copies succeed. Rebuilding therefore removes stale PDFs and receipts from earlier builds without risking a half-written client package. A failed rebuild leaves the prior output intact. Any edit, import, rescan, deletion, or restoration clears the UI's ready state so the user is prompted to rebuild before sending. The build reads only the invoice's managed receipt copies and never moves, rewrites, or deletes the original files that were selected from Dropbox or elsewhere.

The live invoice directory is already the unzipped debug-friendly output. Add Export package for sending or copying elsewhere:

Client package by default:

~~~text
invoice-2026-01-01-2026-02-01/
  invoice.tsv
  invoice.csv
  receipts/
~~~

Optional Include debug data adds invoice.json and debug/. Never include .trash, .bak, temporary files, settings, or API keys.

Offer:

- Save as ZIP.
- Export copy to folder.

Before export, verify that managed files exist and still match their recorded hashes. Copy files to a temporary sibling destination and finalize only after the package succeeds, preventing half-written ZIPs/folders.

Do not create an exported ordinary-folder copy inside the configured base folder; otherwise it could be mistaken for another live invoice. A ZIP may sit there safely because invoice discovery only scans directories. The live invoice directory itself is already the unzipped debug copy.

The invoice-local PDF is the client-facing summary; TSV/CSV remain the spreadsheet-ready representations and the managed receipt copies remain the source attachments.

## Technical choices

| Area | Choice | Why |
| --- | --- | --- |
| macOS desktop shell | Electron | Fastest setup for file dialogs, drag/drop, clipboard, Finder, and packaging |
| UI | React + TypeScript + Vite | Quick, familiar editable UI |
| Table | React Data Grid or a comparable editable grid | Built-in editing, selection, keyboard navigation, and clipboard behavior |
| Date selection | Native date inputs initially | Good macOS date picker without another dependency |
| PDF preview | Chromium's native PDF viewer | Local preview without another packaged dependency |
| Image handling | macOS `sips` for HEIC/HEIF; direct upload for JPEG/PNG/WebP | Avoids custom HEIC-enabled native binaries |
| Validation | Strict provider schema plus small runtime validators | Keeps the persisted and provider data formats explicit without another runtime dependency |
| Hashing | Node crypto | Built-in SHA-256; no service needed |
| Storage | Node filesystem + JSON/TSV/CSV | Folder is the database |
| Secret storage | Electron safeStorage + settings JSON | Encrypts the user-entered key with macOS-backed protection |
| ZIP | macOS `/usr/bin/ditto` | Creates a compatible ZIP without another runtime dependency |
| Packaging | electron-builder | Creates the same-Mac, unsigned local `.app` bundle |
| Cloud service | OpenAI only in MVP | One API key and no specialized OCR account |

Keep file and provider operations in the Electron main process. Expose a narrow typed IPC API to the renderer. Prevent arbitrary renderer filesystem access and remote navigation.

No code signing, notarization, updater, or App Store work is needed while the app is built and installed locally on this same Mac. Distributing the app to another Mac would make signing/notarization a separate requirement.

## Build sequence

### Phase 0 — extraction proof (half day)

- Send representative phone photos and PDFs to OpenAI.
- Confirm merchant/date/final-total accuracy and itemization usefulness.
- Save outputs using the intended schema.

### Phase 1 — local shell and invoice folders (1 day)

- Electron/React scaffold.
- Settings and base-folder picker.
- Invoice list and date-range creation.
- Single-instance lock plus serialized, atomic invoice.json save/reload.

### Phase 2 — import, extraction, and dedupe (1–2 days)

- Multi-file drag/drop and picker.
- Copy, SHA-256, and duplicate warnings.
- Sequential OpenAI queue.
- Receipt preview and debug drawer.

### Phase 3 — table and exports (1–2 days)

- CRUD grid and date pickers.
- Decimal-safe totals.
- Autosave and atomic TSV/CSV regeneration on save/open/export.
- Clipboard copy.

### Phase 4 — packaging and polish (1 day)

- Client/debug folder export and ZIP.
- Recovery from failed scans and invalid JSON.
- Package a local macOS .app.
- Test with a realistic batch.

A functional prototype should take roughly 4–6 focused development days after the extraction proof looks acceptable. Budget 6–8 days for the recovery checks, packaging, and realistic-batch polish in this plan.

## Acceptance criteria

- Runs as a local macOS app on this computer.
- Remembers a chosen base folder.
- Creates invoice-START-END folders from date pickers.
- Reconstructs the invoice list entirely from those folders after restart.
- Uses no SQLite, server, Azure, Google API, or watched-folder automation.
- Imports many local images/PDFs and copies them into the active invoice.
- Supports bulk selection for retry, copy, and delete; package export covers the whole invoice.
- Never changes or deletes original source files.
- Skips an exact duplicate in the same invoice and warns across invoices.
- Produces an editable row with date, final receipt total, and merchant.
- Shows itemization/debug data on click when available.
- Marks current receipt imports as Manual while reserving Automation as a future source type.
- Supports manual rows and full row CRUD.
- Sorts all six user columns accessibly, defaults each opened invoice to stable Date-ascending order, keeps blanks last, and saves the visible order for TSV/CSV/PDF.
- Correctly totals groceries, hours, labour, and invoice cost.
- Keeps invoice.json, invoice.tsv, and invoice.csv synchronized.
- Copies valid TSV to the clipboard.
- Exports a clean ZIP or ordinary folder without keys or trash.
- Stores the user-entered OpenAI key only as a safeStorage-encrypted value outside the base folder.
- Allows manual entry when extraction fails.

## Explicit non-goals for the first release

- Windows or Linux.
- Google Sheets API/OAuth.
- Dropbox API or watched folders.
- Azure or another specialized OCR account.
- SQLite or a hidden global database.
- Multiple users or concurrent writers.
- OpenAI/Claude consensus checking.
- Perceptual-image deduplication.
- A general spreadsheet/formula engine.
- A general PDF designer or arbitrary table-layout editor.
- Code signing, notarization, auto-update, or App Store distribution.

## First implementation checkpoint

Before building the full UI, test 20–30 representative receipts:

- Clear phone photos.
- Rotated/dim photos.
- Long grocery receipts.
- Digital PDFs.
- Duplicate copies.
- Receipts with tax, discounts, tips, or no itemization.

Measure date/merchant/total accuracy, arithmetic-warning usefulness, average latency, and actual token cost. If final totals are reliably recoverable and manual correction is comfortable, proceed with the app as specified. If not, the provider-independent normalized receipt schema lets Claude or a receipt-specific service be benchmarked without changing the folder/table design.
