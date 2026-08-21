# Code Review — 2026-08-21

## Outcome

The macOS MVP passed a full consistency, simplicity, performance, integrity, and lifecycle review.
The review fixed the release-blocking races and unsafe filesystem edges that were found, added
regression coverage for them, and established repeatable lint, format, coverage, type, build, and
packaging checks.

The app remains intentionally local and single-user: Electron + React, JSON files as the database,
sequential receipt scanning, and no hosted service beyond user-authorized OpenAI extraction.

## Material fixes

### Data integrity and concurrency

- Invoice ID and name aliases now serialize through one canonical per-invoice queue.
- TSV/CSV views settle before authoritative JSON commits, so a derived-view failure cannot advance
  the invoice revision.
- PDF/output rendering happens outside the invoice lock, but the final revision check and atomic
  output swap happen inside it. A concurrent edit rejects a stale build and preserves prior output.
- Atomic writes use unpredictable exclusive temporary files and reject symlinked authoritative
  files.
- Interrupted deletes use a prepared trash manifest and can recover safely; failed cleanup after a
  committed undo no longer rolls restored files back.
- Missing or symlinked configured base folders are rejected instead of silently recreated.
- Revision overflow and large-hours aggregation edge cases are guarded.
- Invoice removal is revisioned and queue-safe: recoverable removal uses a portable `DELETED.json`
  sentinel, while optional permanent deletion is constrained to the exact canonical invoice folder
  and records interrupted/partial deletion state before removing files.

### Receipt and IPC boundaries

- Renderer import paths must originate from the native picker or an actual dropped `File`.
- Managed preview paths are derived in the main process and constrained to the invoice folder.
- Preview bytes cross IPC as binary and become a bounded Blob URL rather than a Base64 data URL.
- Receipt processing has a 20 MB per-file limit, bounding the remaining OpenAI Base64/JSON peak.
- Receipt debug JSON is limited to 2 MiB and structurally validated before use.
- Persisted SHA-256 values and timestamps are validated and normalized.
- Copied/exported receipts are hash-verified, and export destinations cannot resolve inside live
  invoice data.
- Failed receipt preparation and incomplete successful-HTTP provider responses become explicit
  scan errors instead of leaving ambiguous state.

### Renderer lifecycle and accessibility

- Active file operations prevent accidental window close and lock grid mutations.
- Stale check, delete, undo, reload, and autosave completions cannot overwrite newer state.
- Revision conflicts persist until the user reloads rather than being cleared by a coincidental row
  snapshot.
- Receipt preview and debug loading are independent, cancellable by identity, and restore drawer
  focus correctly.
- Modal busy states, live regions, grid editors, review controls, and image-preview keyboard
  semantics were tightened.
- Selected-row reconciliation is linear rather than repeatedly scanning rows.

## Automated quality gates

`make check` (or `npm run check`) now runs:

1. Biome lint with warnings treated as failures.
2. Biome format verification.
3. All Vitest tests with V8 coverage and enforced thresholds.
4. TypeScript checking and production builds for both Electron processes.

The current suite contains 181 tests across 25 test files.

Current measured coverage:

| Scope | Statements | Branches | Functions | Lines |
| --- | ---: | ---: | ---: | ---: |
| Whole project | 55.39% | 47.80% | 55.93% | 57.24% |
| Electron main process | 78.77% | 72.06% | 79.65% | 80.11% |
| Shared finance/tabular logic | 98.38% | 92.85% | 100% | 98.33% |

The gate floors are deliberately below the measured values to allow small refactors while still
preventing material regression: whole-project 52/43/52/54, main-process 75/65/75/76, and shared
logic 95/90/95/95 (statements/branches/functions/lines).

## Non-blocking follow-ups

- `src/renderer/App.tsx` remains large. Its pure helpers, autosave hook, and several presentational
  components are tested, but the full application shell and data grid need a future DOM or Electron
  end-to-end harness. This is the largest current maintenance and coverage gap.
- Autosave deliberately clones and signs the row array on edits. That is simple and safe for the
  expected invoice sizes; cache row signatures only if real invoices show measurable latency.
- A preview still requires several binary copies and OpenAI still needs Base64 inside its request.
  The 20 MB limit bounds this cost; streaming/provider-upload redesign is not justified for the MVP.
- Opening an invoice regenerates TSV/CSV. An obstructed derived-view path can therefore prevent
  opening otherwise-valid JSON; separating open from view repair would improve recovery UX.
- Automatic recovery from `invoice.json.bak`, a future settings-schema migration, and bounded row or
  path-array IPC payloads are worthwhile hardening if this grows beyond one trusted local user.
- The dependency audit is clean for production packages. A low-severity esbuild advisory remains in
  dev dependencies and affects Windows development servers, outside this macOS-only release.

These are not known release blockers for the stated single-user macOS scope.
