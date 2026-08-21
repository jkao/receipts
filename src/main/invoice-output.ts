import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { BrowserWindow, shell } from "electron";

import {
  calculateInvoiceTotals,
  calculateRowLabourMinor,
  formatMinorUnits,
  normalizeHours,
} from "../shared/finance";
import type { InvoiceDocument, InvoiceOutputResult, ReceiptRecord } from "../shared/types";
import type { InvoiceStore } from "./invoice-store";
import { resolveInside, sha256File } from "./receipt-files";

type OutputStore = Pick<InvoiceStore, "loadInvoice" | "getInvoiceFolder" | "runAtRevision">;

export type InvoicePdfRenderer = (html: string) => Promise<Buffer>;

export interface InvoiceOutputBuilderOptions {
  renderPdf?: InvoicePdfRenderer;
  revealPath?: (folder: string) => Promise<string | undefined>;
  nonce?: () => string;
}

interface VerifiedReceipt {
  receipt: ReceiptRecord;
  sha256: string;
  sourcePath: string;
}

const VALID_SHA256 = /^[0-9a-f]{64}$/;

export class InvoiceOutputBuilder {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly renderPdf: InvoicePdfRenderer;
  private readonly revealPath: (folder: string) => Promise<string | undefined>;
  private readonly nonce: () => string;

  constructor(
    private readonly invoices: OutputStore,
    options: InvoiceOutputBuilderOptions = {}
  ) {
    this.renderPdf = options.renderPdf ?? renderInvoicePdfWithElectron;
    this.revealPath = options.revealPath ?? ((folder) => shell.openPath(folder));
    this.nonce = options.nonce ?? randomUUID;
  }

  async buildInvoiceOutput(invoiceId: string): Promise<InvoiceOutputResult> {
    return this.enqueue(invoiceId, async () => {
      const invoice = await this.invoices.loadInvoice(invoiceId);
      const invoiceFolder = await this.invoices.getInvoiceFolder(invoice.name);
      const verified = await verifyManagedReceipts(invoice, invoiceFolder);
      const winners = firstReceiptForEachHash(verified);
      const html = buildInvoiceHtml(invoice);
      const pdf = await this.renderPdf(html);
      assertPdf(pdf);

      const outputPath = path.join(invoiceFolder, "output");
      const nonce = this.nonce();
      const stagingPath = path.join(invoiceFolder, `.output.tmp-${nonce}`);
      const backupPath = path.join(invoiceFolder, `.output.backup-${nonce}`);

      try {
        await buildStagedOutput(stagingPath, winners, pdf);
        await this.invoices.runAtRevision(
          invoice.id,
          invoice.revision,
          async (_current, lockedFolder) => {
            if (path.resolve(lockedFolder) !== path.resolve(invoiceFolder)) {
              throw new Error("Invoice location changed while output was building.");
            }
            await replaceOutputDirectory(outputPath, stagingPath, backupPath);
          }
        );
      } finally {
        await fs.rm(stagingPath, { recursive: true, force: true }).catch(() => undefined);
      }

      return { outputPath, receiptCount: winners.length };
    });
  }

  async revealOutput(invoiceId: string): Promise<void> {
    return this.enqueue(invoiceId, async () => {
      const invoiceFolder = await this.invoices.getInvoiceFolder(invoiceId);
      const outputPath = path.join(invoiceFolder, "output");
      let metadata: Awaited<ReturnType<typeof fs.lstat>>;
      try {
        metadata = await fs.lstat(outputPath);
      } catch (error) {
        if (isErrno(error, "ENOENT")) {
          throw new Error("Build the invoice output first.");
        }
        throw error;
      }
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new Error("Invoice output is not an ordinary directory.");
      }
      const error = await this.revealPath(outputPath);
      if (typeof error === "string" && error) {
        throw new Error(error);
      }
    });
  }

  private enqueue<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined
    );
    this.queues.set(key, tail);
    return result.finally(() => {
      if (this.queues.get(key) === tail) {
        this.queues.delete(key);
      }
    });
  }
}

export function buildInvoiceHtml(invoice: InvoiceDocument): string {
  const totals = calculateInvoiceTotals(invoice.rows);
  const tableRows = invoice.rows.length
    ? invoice.rows.map(invoiceRowHtml).join("\n")
    : `<tr class="empty-row"><td colspan="6">No invoice rows</td></tr>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(invoice.name)} - Invoice</title>
  <style>
    @page { size: Letter portrait; margin: 0.48in 0.48in 0.72in; }
    * { box-sizing: border-box; }
    html { color: #17231f; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif; font-size: 10px; }
    body { margin: 0; background: #ffffff; }
    .masthead { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; padding-bottom: 16px; border-bottom: 3px solid #2f6c59; }
    .eyebrow { margin: 0 0 6px; color: #2f6c59; font-size: 9px; font-weight: 800; letter-spacing: 0.14em; text-transform: uppercase; }
    h1 { margin: 0; color: #173f34; font-size: 27px; line-height: 1.05; letter-spacing: -0.02em; }
    .invoice-name { margin: 7px 0 0; color: #5b6863; font-size: 10px; overflow-wrap: anywhere; }
    .period { min-width: 180px; padding: 11px 13px; border: 1px solid #c9d8d2; border-radius: 8px; background: #f2f7f4; }
    .period-label { display: block; margin-bottom: 4px; color: #60706a; font-size: 8px; font-weight: 800; letter-spacing: 0.1em; text-transform: uppercase; }
    .period-value { color: #173f34; font-size: 12px; font-weight: 750; }
    .meta { margin-top: 6px; color: #68756f; font-size: 8px; }
    .summary { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin: 16px 0; }
    .metric { min-height: 62px; padding: 10px 11px; border: 1px solid #d9e2de; border-radius: 8px; background: #fafbf9; break-inside: avoid; }
    .metric.grand { color: #ffffff; border-color: #2f6c59; background: #2f6c59; }
    .metric-label { display: block; margin-bottom: 7px; color: #68756f; font-size: 8px; font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase; }
    .grand .metric-label { color: #dceae4; }
    .metric-value { font-size: 15px; font-weight: 800; white-space: nowrap; }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; }
    col.date { width: 12%; }
    col.groceries { width: 14%; }
    col.hours { width: 12%; }
    col.rate { width: 12%; }
    col.labour { width: 14%; }
    col.comment { width: 36%; }
    thead { display: table-header-group; }
    thead th { padding: 8px 7px; color: #ffffff; background: #2f6c59; border-right: 1px solid #5b8979; font-size: 8px; font-weight: 800; letter-spacing: 0.04em; text-align: left; text-transform: uppercase; }
    thead th:last-child { border-right: 0; }
    tbody tr { break-inside: avoid; page-break-inside: avoid; }
    tbody td { min-height: 28px; padding: 7px; border: 1px solid #dce3e0; vertical-align: top; line-height: 1.3; }
    tbody tr:nth-child(even) td { background: #f7f9f8; }
    td.number { text-align: right; white-space: nowrap; }
    td.comment { overflow-wrap: anywhere; word-break: break-word; white-space: pre-wrap; }
    .empty-row td { padding: 22px; color: #6d7974; text-align: center; }
    .totals-wrap { display: flex; justify-content: flex-end; margin-top: 12px; break-inside: avoid; page-break-inside: avoid; }
    .totals { width: 310px; overflow: hidden; border: 1px solid #cbd8d3; border-radius: 8px; }
    .total-row { display: grid; grid-template-columns: 1fr auto; gap: 20px; padding: 8px 11px; border-bottom: 1px solid #dce3e0; }
    .total-row:last-child { border-bottom: 0; }
    .total-label { color: #52615b; font-weight: 700; }
    .total-value { font-weight: 800; white-space: nowrap; }
    .total-row.grand-total { color: #ffffff; background: #173f34; }
    .grand-total .total-label { color: #dceae4; }
    .note { margin: 14px 0 0; color: #71807a; font-size: 8px; text-align: right; }
  </style>
</head>
<body>
  <header class="masthead">
    <div>
      <p class="eyebrow">Receipt invoice</p>
      <h1>Invoice summary</h1>
      <p class="invoice-name">${escapeHtml(invoice.name)}</p>
    </div>
    <div class="period">
      <span class="period-label">Billing period</span>
      <span class="period-value">${escapeHtml(formatDate(invoice.period.startDate))} - ${escapeHtml(formatDate(invoice.period.endDate))}</span>
      <div class="meta">Revision ${invoice.revision} | ${invoice.rows.length} row${invoice.rows.length === 1 ? "" : "s"} | ${invoice.receipts.length} receipt${invoice.receipts.length === 1 ? "" : "s"}</div>
    </div>
  </header>

  <section class="summary" aria-label="Invoice totals">
    ${metricHtml("Groceries", formatMoney(totals.groceriesMinor))}
    ${metricHtml("Hours", totals.hours)}
    ${metricHtml("Labour", formatMoney(totals.labourMinor))}
    ${metricHtml("Grand total", formatMoney(totals.invoiceMinor), true)}
  </section>

  <table>
    <colgroup>
      <col class="date"><col class="groceries"><col class="hours"><col class="rate"><col class="labour"><col class="comment">
    </colgroup>
    <thead>
      <tr><th>Date</th><th>Groceries MP</th><th>Hours worked</th><th>Rate</th><th>Labour total</th><th>Comment</th></tr>
    </thead>
    <tbody>
      ${tableRows}
    </tbody>
  </table>

  <section class="totals-wrap" aria-label="Totals">
    <div class="totals">
      ${totalRowHtml("Groceries total", formatMoney(totals.groceriesMinor))}
      ${totalRowHtml("Hours total", totals.hours)}
      ${totalRowHtml("Labour total", formatMoney(totals.labourMinor))}
      ${totalRowHtml("Grand total", formatMoney(totals.invoiceMinor), true)}
    </div>
  </section>
  <p class="note">Grand total includes groceries and labour.</p>
</body>
</html>`;
}

export async function renderInvoicePdfWithElectron(html: string): Promise<Buffer> {
  const window = new BrowserWindow({
    show: false,
    width: 1024,
    height: 1325,
    backgroundColor: "#ffffff",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      javascript: false,
      webSecurity: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  try {
    const dataUrl = `data:text/html;base64,${Buffer.from(html, "utf8").toString("base64")}`;
    await window.loadURL(dataUrl);
    return await window.webContents.printToPDF({
      pageSize: "Letter",
      landscape: false,
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: true,
      headerTemplate: "<div></div>",
      footerTemplate:
        '<div style="box-sizing:border-box;width:100%;padding:0 0.48in;color:#71807a;font-family:Arial,sans-serif;font-size:8px;text-align:right">Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>',
      generateTaggedPDF: true,
      generateDocumentOutline: true,
    });
  } finally {
    if (!window.isDestroyed()) {
      window.destroy();
    }
  }
}

async function verifyManagedReceipts(
  invoice: InvoiceDocument,
  invoiceFolder: string
): Promise<VerifiedReceipt[]> {
  const verified: VerifiedReceipt[] = [];
  for (const receipt of invoice.receipts) {
    const expected = receipt.sha256.trim().toLowerCase();
    if (!VALID_SHA256.test(expected)) {
      throw new Error(`Receipt ${receipt.originalFilename} has an invalid SHA-256 value.`);
    }
    const sourcePath = resolveInside(invoiceFolder, receipt.relativePath);
    let metadata: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      metadata = await fs.lstat(sourcePath);
    } catch (error) {
      if (isErrno(error, "ENOENT")) {
        throw new Error(`Missing receipt file: ${receipt.originalFilename}`);
      }
      throw error;
    }
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error(`Receipt ${receipt.originalFilename} is not an ordinary file.`);
    }
    const actual = await sha256File(sourcePath);
    if (actual !== expected) {
      throw new Error(`Receipt ${receipt.originalFilename} does not match its saved SHA-256.`);
    }
    verified.push({ receipt, sha256: expected, sourcePath });
  }
  return verified;
}

function firstReceiptForEachHash(receipts: VerifiedReceipt[]): VerifiedReceipt[] {
  const seen = new Set<string>();
  return receipts.filter((receipt) => {
    if (seen.has(receipt.sha256)) return false;
    seen.add(receipt.sha256);
    return true;
  });
}

async function buildStagedOutput(
  stagingPath: string,
  receipts: VerifiedReceipt[],
  pdf: Buffer
): Promise<void> {
  await fs.mkdir(stagingPath, { recursive: false, mode: 0o700 });
  const receiptFolder = path.join(stagingPath, "receipts");
  await fs.mkdir(receiptFolder, { mode: 0o700 });
  await fs.writeFile(path.join(stagingPath, "invoice.pdf"), pdf, {
    flag: "wx",
    mode: 0o600,
  });

  const usedNames = new Set<string>();
  for (const receipt of receipts) {
    const filename = availableReceiptName(
      path.basename(receipt.receipt.relativePath),
      receipt.sha256,
      usedNames
    );
    const destination = path.join(receiptFolder, filename);
    const sourceMetadata = await fs.lstat(receipt.sourcePath);
    if (sourceMetadata.isSymbolicLink() || !sourceMetadata.isFile()) {
      throw new Error(`Receipt ${receipt.receipt.originalFilename} is not an ordinary file.`);
    }
    await fs.copyFile(receipt.sourcePath, destination, fsConstants.COPYFILE_EXCL);
    if ((await sha256File(destination)) !== receipt.sha256) {
      throw new Error(
        `Receipt ${receipt.receipt.originalFilename} changed while output was being built.`
      );
    }
  }
}

async function replaceOutputDirectory(
  outputPath: string,
  stagingPath: string,
  backupPath: string
): Promise<void> {
  let previousMoved = false;
  const metadata = await lstatIfExists(outputPath);
  if (metadata) {
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error("Invoice output is not an ordinary directory.");
    }
    await fs.rename(outputPath, backupPath);
    previousMoved = true;
  }

  try {
    await fs.rename(stagingPath, outputPath);
  } catch (error) {
    if (previousMoved) {
      try {
        await fs.rename(backupPath, outputPath);
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "Could not install the new output or restore the previous output."
        );
      }
    }
    throw error;
  }

  if (previousMoved) {
    // The new output is committed once staging is renamed. Backup cleanup is
    // best-effort so a cleanup-only failure cannot report a failed build after
    // the caller-visible output has already changed.
    await fs.rm(backupPath, { recursive: true, force: true }).catch(() => undefined);
  }
}

function availableReceiptName(preferred: string, sha256: string, usedNames: Set<string>): string {
  const normalizedPreferred = preferred.toLowerCase();
  if (!usedNames.has(normalizedPreferred)) {
    usedNames.add(normalizedPreferred);
    return preferred;
  }

  const extension = path.extname(preferred);
  const stem = path.basename(preferred, extension) || "receipt";
  const base = `${stem}-${sha256.slice(0, 12)}`;
  for (let suffix = 1; ; suffix += 1) {
    const candidate = `${base}${suffix === 1 ? "" : `-${suffix}`}${extension}`;
    const normalized = candidate.toLowerCase();
    if (!usedNames.has(normalized)) {
      usedNames.add(normalized);
      return candidate;
    }
  }
}

function assertPdf(pdf: Buffer): void {
  if (!Buffer.isBuffer(pdf) || pdf.length < 5 || pdf.subarray(0, 5).toString() !== "%PDF-") {
    throw new Error("PDF renderer did not return a valid PDF document.");
  }
}

function invoiceRowHtml(row: InvoiceDocument["rows"][number]): string {
  const hours = normalizeHours(row.hours);
  return `<tr>
        <td>${escapeHtml(row.date === null ? "-" : formatDate(row.date))}</td>
        <td class="number">${row.groceriesMinor === null ? "-" : escapeHtml(formatMoney(row.groceriesMinor))}</td>
        <td class="number">${escapeHtml(hours || "-")}</td>
        <td class="number">${row.rateMinor === null || hours === "" ? "-" : escapeHtml(formatMoney(row.rateMinor))}</td>
        <td class="number">${escapeHtml(formatMoney(calculateRowLabourMinor(row)))}</td>
        <td class="comment">${escapeHtml(row.comment || "-")}</td>
      </tr>`;
}

function metricHtml(label: string, value: string, grand = false): string {
  return `<div class="metric${grand ? " grand" : ""}"><span class="metric-label">${escapeHtml(label)}</span><span class="metric-value">${escapeHtml(value)}</span></div>`;
}

function totalRowHtml(label: string, value: string, grand = false): string {
  return `<div class="total-row${grand ? " grand-total" : ""}"><span class="total-label">${escapeHtml(label)}</span><span class="total-value">${escapeHtml(value)}</span></div>`;
}

function formatDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return match ? `${match[2]}/${match[3]}/${match[1]}` : value;
}

function formatMoney(value: number): string {
  const exact = formatMinorUnits(value);
  const negative = exact.startsWith("-");
  const unsigned = negative ? exact.slice(1) : exact;
  const [whole, fraction] = unsigned.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-$" : "$"}${grouped}.${fraction}`;
}

function escapeHtml(value: string | number): string {
  return String(value).replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

async function lstatIfExists(
  filename: string
): Promise<Awaited<ReturnType<typeof fs.lstat>> | null> {
  try {
    return await fs.lstat(filename);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return null;
    throw error;
  }
}
