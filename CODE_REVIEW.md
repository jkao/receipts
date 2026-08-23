# Code Review — 2026-08-23

## Outcome

The macOS MVP passed a focused cleanliness, readability, usability, accessibility, performance,
integrity, and lifecycle review. All release-blocking findings found in that review were fixed and
covered by the automated release gate.

The product remains intentionally local and single-user: Electron + React, invoice JSON as the
authoritative database, and no hosted service beyond user-authorized OpenAI receipt extraction.

## Material fixes

### Performance and responsiveness

- Invoice IDs now resolve through a base-folder-scoped alias cache. A synthetic 200-invoice,
  100-rows-per-invoice history measured a warm ID load at about 0.96 ms versus 89 ms cold (about
  93× faster).
- Opening an invoice is a pure JSON read. A small revision-and-SHA-256 marker identifies current
  TSV/CSV views; a bounded startup/list pass repairs only stale or interrupted views.
- Batch import validates and hashes source files once, checks all hashes against invoice history in
  one call, reads the API key once, and commits prepared receipt metadata in one mutation.
- Accepted imports become durable before extraction, then scan in the background. Work is bounded
  globally to two provider preparations/requests across every invoice and retry, with cancellation
  while queued or active.
- Likely-duplicate detection groups pre-normalized date, amount, and merchant keys instead of
  comparing every row pair. A 5,000-candidate diagnostic fell from about 3.1 seconds to 6.9 ms
  (about 453× faster).
- Grid editors keep raw keystrokes locally and publish one validated row at commit. Tab, Enter,
  blur, outside actions, close, and file drop share safe commit behavior; unchanged drafts are true
  no-ops.
- Autosave defers cloning/signature work until debounce or flush, coalesces in-flight saves, and
  suppresses edit-then-revert writes. Rows are re-sorted only when an edit affects the active sort.
- Receipt preview/debug reads share their in-flight invoice lookup. Blob URLs are explicitly
  released, stale drawer resources are hidden immediately, and same-status rescans reload by
  a scan-specific resource generation without reloading on unrelated invoice edits.
- Export, output construction, receipt hashing, copying, and provider preparation use small bounded
  worker pools instead of serial bottlenecks or unbounded fan-out.

### Data integrity and concurrency

- Invoice ID and folder aliases serialize through one canonical per-invoice queue, extracted into a
  reusable keyed serial-queue module.
- Atomic persistence and invoice validation/serialization are isolated in focused modules instead
  of being interleaved with store discovery logic.
- Authoritative JSON commits are atomic and directory-synced. The derived-view marker is written
  dirty before a mutation and clean only after TSV, CSV, and authoritative JSON reach the same
  revision.
- View repair rechecks authoritative state inside the same invoice queue, so repair and mutation
  cannot cross revisions.
- Batch preparation rolls back every copied receipt if its single metadata commit fails.
- Cancellation has an explicit commit point: before invoice commit, the receipt returns to queued
  and newly written debug JSON is removed or the prior bytes are restored; after commit, the
  extracted row wins and is reported as complete.
- Unexpected background-scheduler failures requeue only still-scanning receipts and emit one
  terminal failed state. The renderer refreshes that durable failure state rather than announcing
  completion.
- Per-invoice terminal refreshes survive navigation/open races without leaving global folder or
  close locks stranded.
- Output/export integrity still verifies managed receipt paths, file types, and SHA-256 values.

### Readability and maintainability

- The renderer shell was reduced by extracting onboarding, sidebar, modals, copy actions, save and
  import status, toast presentation, import-job state, import workflow, idle scheduling, and pure
  state-transition helpers.
- The former monolithic stylesheet is split by base, layout, component, grid, preview, modal, and
  responsive concerns.
- IPC channels now have one typed contract and structured success/error envelopes. Expected
  filesystem and validation failures retain user-safe messages through the preload boundary.
- Main-process helpers now isolate atomic writes, bounded operations, invoice codecs, and keyed
  queues, each with direct tests.

### UX and accessibility

- Receipt scanning no longer freezes the whole app. The active invoice is read-only while its scan
  runs, but other invoices remain usable; progress and cancellation stay visible.
- Cancel is shown only after the main process has registered a cancelable job, avoiding a false
  cancel action during hashing/copying.
- Money, hours, rate, comment, and date editors validate local drafts, keep invalid values focused,
  expose accessible error text, and commit correctly on Enter, Tab, blur, navigation, close, and
  receipt drop.
- Responsive drawer mode uses a scrim and removes obscured workspace controls from the keyboard and
  accessibility trees. Modal and drawer focus is restored predictably.
- The hidden-inset macOS title bar has an isolated drag handle in the sidebar's unused top inset,
  clear of the traffic lights and every interactive control.
- Labels, confirmation copy, disclosures, progress states, toasts, empty states, copy/export names,
  and review language were made more explicit and consistent.
- The grid retains virtualized rows, stable row keys, memoized columns/maps/totals, and fixed-height
  rendering, so DOM size remains tied to the viewport.

## Automated quality gates

`make check` (or `npm run check`) runs:

1. Biome lint with warnings treated as failures.
2. Biome format verification.
3. All Vitest tests with V8 coverage and enforced thresholds.
4. TypeScript checking and production builds for both Electron processes.

The current suite contains 286 tests across 43 test files.

Current measured coverage:

| Scope | Statements | Branches | Functions | Lines |
| --- | ---: | ---: | ---: | ---: |
| Whole project | 63.93% | 57.95% | 68.88% | 65.74% |
| Electron main process | 81.67% | 73.48% | 84.63% | 83.37% |
| Shared finance/tabular/error logic | 98.02% | 93.71% | 100% | 98.60% |

The production build is small for a desktop renderer: 320.70 kB JavaScript (98.77 kB gzip) and
46.68 kB CSS (10.10 kB gzip). The compiled Electron main bundle is 177.14 kB and preload is 7.05
kB before app packaging.

## Non-blocking follow-ups

- `src/renderer/App.tsx` is substantially smaller and its extracted state machines are directly
  tested, but an automated packaged-Electron workflow would add confidence across native dialogs,
  React Data Grid, and application close/relaunch as one system.
- Receipt previews still read and transfer the complete bounded file, and OpenAI requests still
  require Base64 payloads. The 20 MB per-file limit bounds this cost; thumbnails or a provider file
  upload path would only be justified by real large-file usage.
- The alias cache removes repeated history scans after discovery, but a workspace with many
  thousands of invoices will still pay one bounded discovery pass on startup or cache invalidation.
- Automatic recovery from `invoice.json.bak` and a future settings-schema migration remain useful
  hardening if the app expands beyond one trusted local user.

These are not known blockers for the stated single-user macOS scope.
