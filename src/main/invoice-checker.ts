import { createHash } from "node:crypto";
import type {
  InvoiceCheckIssue,
  InvoiceCheckIssueCode,
  InvoiceCheckResult,
  InvoiceDocument,
  InvoiceReviewUpdateResult,
  InvoiceRow,
  ReceiptRecord,
} from "../shared/types";
import type { InvoiceStore } from "./invoice-store";
import { ReceiptDebugValidationError, readReceiptDebugFile } from "./receipt-debug";
import { resolveInside } from "./receipt-files";

type CheckerStore = Pick<
  InvoiceStore,
  "loadInvoice" | "findHashes" | "getInvoiceFolder" | "mutateInvoice"
>;

interface PendingIssue {
  code: InvoiceCheckIssueCode;
  message: string;
  rowIds: string[];
  receiptIds: string[];
  acknowledgeable: boolean;
  evidence: unknown;
}

interface ScanWarningEvidence {
  scannedAt: string | null;
  warnings: string[];
}

export interface InvoiceCheckerOptions {
  now?: () => Date;
}

export class ReviewFindingUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewFindingUnavailableError";
  }
}

export class InvoiceChecker {
  private readonly now: () => Date;

  constructor(
    private readonly invoices: CheckerStore,
    options: InvoiceCheckerOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async checkInvoice(invoiceId: string): Promise<InvoiceCheckResult> {
    return this.buildResult(await this.invoices.loadInvoice(invoiceId));
  }

  async setReviewAcknowledgement(
    invoiceId: string,
    fingerprint: string,
    acknowledged: boolean,
    expectedRevision: number
  ): Promise<InvoiceReviewUpdateResult> {
    if (!/^[0-9a-f]{64}$/.test(fingerprint)) {
      throw new ReviewFindingUnavailableError(
        "Review finding fingerprint is invalid. Run Check Invoice again."
      );
    }

    const invoice = await this.invoices.mutateInvoice(
      invoiceId,
      async (draft) => {
        const current = await this.buildResult(draft);
        const finding = current.issues.find((issue) => issue.fingerprint === fingerprint);
        if (!finding) {
          throw new ReviewFindingUnavailableError(
            "This review finding is no longer current. Run Check Invoice again."
          );
        }
        if (!finding.acknowledgeable) {
          throw new ReviewFindingUnavailableError(
            "This scan state must be fixed or retried and cannot be marked reviewed."
          );
        }

        const activeFingerprints = new Set(
          current.issues.filter((issue) => issue.acknowledgeable).map((issue) => issue.fingerprint)
        );
        const retained = draft.reviewAcknowledgements.filter(
          (item) => item.fingerprint !== fingerprint && activeFingerprints.has(item.fingerprint)
        );
        if (acknowledged) {
          retained.push({
            fingerprint,
            acknowledgedAt: this.now().toISOString(),
          });
        }
        draft.reviewAcknowledgements = retained;
      },
      expectedRevision
    );

    return {
      invoice,
      check: await this.buildResult(invoice),
    };
  }

  private async buildResult(invoice: InvoiceDocument): Promise<InvoiceCheckResult> {
    const pending: PendingIssue[] = [];

    await this.checkExactReceiptDuplicates(invoice, pending);
    this.checkLikelyTransactionDuplicates(invoice, pending);
    await this.checkScanLinkedRows(invoice, pending);
    this.checkDates(invoice, pending);

    const acknowledgements = new Map(
      invoice.reviewAcknowledgements.map((item) => [item.fingerprint, item.acknowledgedAt])
    );
    const issues = pending.map((issue): InvoiceCheckIssue => {
      const fingerprint = fingerprintFor(issue);
      return {
        fingerprint,
        acknowledgeable: issue.acknowledgeable,
        acknowledgedAt: issue.acknowledgeable ? (acknowledgements.get(fingerprint) ?? null) : null,
        code: issue.code,
        message: issue.message,
        rowIds: issue.rowIds,
        receiptIds: issue.receiptIds,
      };
    });

    return {
      invoiceId: invoice.id,
      revision: invoice.revision,
      checkedAt: this.now().toISOString(),
      issues,
    };
  }

  private async checkExactReceiptDuplicates(
    invoice: InvoiceDocument,
    issues: PendingIssue[]
  ): Promise<void> {
    const receiptsByHash = new Map<string, ReceiptRecord[]>();
    for (const receipt of invoice.receipts) {
      const hash = receipt.sha256.trim().toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(hash)) continue;
      const group = receiptsByHash.get(hash);
      if (group) group.push(receipt);
      else receiptsByHash.set(hash, [receipt]);
    }

    const matchesByHash = await this.invoices.findHashes([...receiptsByHash.keys()]);
    for (const [hash, currentReceipts] of receiptsByHash) {
      const matches = matchesByHash.get(hash) ?? [];
      const currentReceiptIds = new Set(currentReceipts.map((receipt) => receipt.id));
      const nonSelfMatches = matches.filter(
        (match) => !(match.invoiceId === invoice.id && currentReceiptIds.has(match.receiptId))
      );
      const externalMatches = nonSelfMatches.filter((match) => match.invoiceId !== invoice.id);
      const duplicateInCurrentInvoice = currentReceipts.length > 1;
      if (!duplicateInCurrentInvoice && externalMatches.length === 0) continue;

      const receiptIds = [...currentReceiptIds];
      const rowIds = invoice.rows
        .filter((row) => row.receiptId !== null && currentReceiptIds.has(row.receiptId))
        .map((row) => row.id);
      const messages: string[] = [];
      if (duplicateInCurrentInvoice) {
        messages.push("Identical receipt file content appears more than once in this invoice.");
      }
      if (externalMatches.length > 0) {
        const invoiceNames = [...new Set(externalMatches.map((match) => match.invoiceName))].sort();
        messages.push(
          `Identical receipt file content also appears in ${formatList(invoiceNames)}.`
        );
      }
      issues.push({
        code: "exact-receipt-duplicate",
        message: messages.join(" "),
        rowIds,
        receiptIds,
        acknowledgeable: true,
        evidence: {
          hash,
          duplicateInCurrentInvoice,
          currentReceiptIds: [...currentReceiptIds].sort(),
          externalMatches: externalMatches
            .map((match) => ({
              invoiceId: match.invoiceId,
              invoiceName: match.invoiceName,
              receiptId: match.receiptId,
            }))
            .sort(compareCanonicalObjects),
        },
      });
    }
  }

  private checkLikelyTransactionDuplicates(invoice: InvoiceDocument, issues: PendingIssue[]): void {
    const groups = new Map<string, Array<{ row: InvoiceRow; merchant: string }>>();
    for (const row of invoice.rows) {
      if (!isIsoDate(row.date) || row.groceriesMinor === null) continue;
      const merchant = normalizeMerchantComment(row.comment);
      if (!merchant) continue;

      const key = JSON.stringify([row.date, row.groceriesMinor, merchant]);
      const group = groups.get(key);
      const candidate = { row, merchant };
      if (group) group.push(candidate);
      else groups.set(key, [candidate]);
    }

    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const rows = group.map(({ row }) => row);
      issues.push({
        code: "likely-transaction-duplicate",
        message:
          "These rows may describe the same transaction: merchant/comment, date, and total match.",
        rowIds: rows.map((row) => row.id),
        receiptIds: receiptIdsForRows(rows),
        acknowledgeable: true,
        evidence: {
          rows: group
            .map(({ row, merchant }) => ({
              id: row.id,
              date: row.date,
              groceriesMinor: row.groceriesMinor,
              merchant,
            }))
            .sort(compareCanonicalObjects),
        },
      });
    }
  }

  private async checkScanLinkedRows(
    invoice: InvoiceDocument,
    issues: PendingIssue[]
  ): Promise<void> {
    const rowsByReceiptId = new Map(
      invoice.rows.flatMap((row) => (row.receiptId === null ? [] : [[row.receiptId, row] as const]))
    );
    let invoiceFolder: string | null = null;

    for (const receipt of invoice.receipts) {
      const row = rowsByReceiptId.get(receipt.id);

      if (receipt.status === "needs-review") {
        invoiceFolder ??= await this.invoices.getInvoiceFolder(invoice.name);
        const debug = await readScanWarningEvidence(invoiceFolder, receipt);
        const warnings = debug?.warnings.length
          ? debug.warnings
          : ["The completed scan was flagged for review; open its details and verify the receipt."];
        for (const warning of warnings) {
          issues.push({
            code: "receipt-scan-warning",
            message: warning,
            rowIds: row ? [row.id] : [],
            receiptIds: [receipt.id],
            acknowledgeable: true,
            evidence: {
              receipt: {
                id: receipt.id,
                sha256: normalizeReceiptHash(receipt.sha256),
                debugPath: receipt.debugPath,
              },
              scannedAt: debug?.scannedAt ?? null,
              warning: normalizeWarning(warning),
            },
          });
        }
      } else if (receipt.status !== "ready") {
        issues.push({
          code: "receipt-scan-not-ready",
          message: row
            ? `Linked receipt scan is not ready (status: ${receipt.status}).`
            : `Receipt scan is not ready (status: ${receipt.status}).`,
          rowIds: row ? [row.id] : [],
          receiptIds: [receipt.id],
          acknowledgeable: false,
          evidence: {
            receipt: {
              id: receipt.id,
              sha256: normalizeReceiptHash(receipt.sha256),
              status: receipt.status,
              error: receipt.error ?? null,
            },
          },
        });
      }

      if (!row) {
        issues.push({
          code: "receipt-fields-incomplete",
          message: "Receipt is not linked to an invoice row.",
          rowIds: [],
          receiptIds: [receipt.id],
          acknowledgeable: true,
          evidence: {
            receipt: {
              id: receipt.id,
              sha256: normalizeReceiptHash(receipt.sha256),
            },
            missing: ["invoice row"],
          },
        });
        continue;
      }

      const missing: string[] = [];
      if (row.date === null) missing.push("date");
      if (row.groceriesMinor === null) missing.push("total");
      if (!normalizeMerchantComment(row.comment)) {
        missing.push("merchant/comment");
      }
      if (missing.length > 0) {
        issues.push({
          code: "receipt-fields-incomplete",
          message: `Scan-linked row is missing ${formatList(missing)}.`,
          rowIds: [row.id],
          receiptIds: [receipt.id],
          acknowledgeable: true,
          evidence: {
            rowId: row.id,
            receipt: {
              id: receipt.id,
              sha256: normalizeReceiptHash(receipt.sha256),
            },
            missing: [...missing].sort(),
          },
        });
      }
    }
  }

  private checkDates(invoice: InvoiceDocument, issues: PendingIssue[]): void {
    for (const row of invoice.rows) {
      if (
        row.date === null ||
        (row.date >= invoice.period.startDate && row.date <= invoice.period.endDate)
      ) {
        continue;
      }
      issues.push({
        code: "date-outside-period",
        message: `Row date ${row.date} is outside invoice period ${invoice.period.startDate} to ${invoice.period.endDate}.`,
        rowIds: [row.id],
        receiptIds: row.receiptId === null ? [] : [row.receiptId],
        acknowledgeable: true,
        evidence: {
          row: { id: row.id, date: row.date, receiptId: row.receiptId },
          period: invoice.period,
        },
      });
    }
  }
}

async function readScanWarningEvidence(
  invoiceFolder: string,
  receipt: ReceiptRecord
): Promise<ScanWarningEvidence | null> {
  const debugFilename = resolveInside(invoiceFolder, receipt.debugPath);
  try {
    const debug = await readReceiptDebugFile(debugFilename, receipt.id);
    if (debug === null) return null;

    const warningsByNormalizedText = new Map<string, string>();
    for (const warning of debug.validationWarnings) {
      const normalized = normalizeWarning(warning);
      if (normalized && !warningsByNormalizedText.has(normalized)) {
        warningsByNormalizedText.set(normalized, normalized);
      }
    }
    return {
      scannedAt: debug.scannedAt,
      warnings: [...warningsByNormalizedText.values()],
    };
  } catch (error) {
    // A manually edited or stale debug file must not inject arbitrary review
    // text or fingerprints. Keep the receipt reviewable via the generic
    // warning; the details pane reports the precise validation error.
    if (error instanceof ReceiptDebugValidationError) return null;
    throw error;
  }
}

function fingerprintFor(issue: PendingIssue): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        code: issue.code,
        rowIds: [...new Set(issue.rowIds)].sort(),
        receiptIds: [...new Set(issue.receiptIds)].sort(),
        evidence: issue.evidence,
      })
    )
    .digest("hex");
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])])
    );
  }
  return value;
}

function compareCanonicalObjects(left: object, right: object): number {
  const leftJson = canonicalJson(left);
  const rightJson = canonicalJson(right);
  return leftJson < rightJson ? -1 : leftJson > rightJson ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isIsoDate(value: string | null): value is string {
  if (value === null || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function normalizeMerchantComment(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}

function normalizeWarning(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function normalizeReceiptHash(value: string): string {
  return value.trim().toLowerCase();
}

function receiptIdsForRows(rows: InvoiceRow[]): string[] {
  return rows
    .map((row) => row.receiptId)
    .filter((receiptId): receiptId is string => receiptId !== null);
}

function formatList(values: string[]): string {
  if (values.length === 0) return "";
  if (values.length === 1) return values[0];
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, and ${values.at(-1)}`;
}
