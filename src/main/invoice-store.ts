import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { invoiceToCsv, invoiceToTsv } from "../shared/tabular";
import {
  INVOICE_DELETION_SCHEMA_VERSION,
  INVOICE_SCHEMA_VERSION,
  type InvoiceDeletionSentinel,
  type InvoiceDocument,
  type InvoicePeriod,
  type InvoiceRemovalResult,
  type InvoiceRow,
  type InvoiceSummary,
  type RemoveInvoiceOptions,
} from "../shared/types";
import { atomicWriteFile, fileExists, isErrno, syncDirectory } from "./atomic-file";
import { mapBounded } from "./bounded-operations";
import {
  cloneInvoiceDocument,
  INVOICE_VIEW_STATE_SCHEMA_VERSION,
  InvoiceValidationError,
  type InvoiceViewState,
  invoiceDocumentFingerprint,
  requiredString,
  safeInteger,
  serializeInvoiceDeletionSentinel,
  serializeInvoiceDocument,
  serializeInvoiceViewState,
  validateInvoiceDeletionSentinel,
  validateInvoiceDocument,
  validateInvoiceViewState,
  validatePeriod,
} from "./invoice-codec";
import { KeyedSerialQueue } from "./serial-queue";

export {
  InvoiceValidationError,
  validateInvoiceDeletionSentinel,
  validateInvoiceDocument,
} from "./invoice-codec";

export type BaseFolderGetter = () => string | null | undefined | Promise<string | null | undefined>;

export interface InvoiceStoreOptions {
  getDefaultRateMinor?: () => number | Promise<number>;
  now?: () => Date;
  idFactory?: () => string;
}

export interface InvoiceHashMatch {
  invoiceId: string;
  invoiceName: string;
  receiptId: string;
  relativePath: string;
}

export interface InvoiceViewRepairFailure {
  invoiceId: string;
  invoiceName: string;
  message: string;
}

export interface InvoiceViewRepairReport {
  checked: number;
  repaired: number;
  failures: InvoiceViewRepairFailure[];
}

export type InvoiceMutator = (
  draft: InvoiceDocument
) => undefined | InvoiceDocument | Promise<undefined | InvoiceDocument>;

interface DiscoveredInvoice {
  folder: string;
  invoice: InvoiceDocument;
}

export const INVOICE_VIEW_STATE_FILENAME = ".invoice-views.json";
export const INVOICE_VIEW_REPAIR_CONCURRENCY = 4;
const INVOICE_VIEW_FILENAMES = ["invoice.tsv", "invoice.csv"] as const;

export class RevisionConflictError extends Error {
  readonly invoiceId: string;
  readonly expectedRevision: number;
  readonly actualRevision: number;

  constructor(invoiceId: string, expectedRevision: number, actualRevision: number) {
    super(
      `Invoice ${invoiceId} changed: expected revision ${expectedRevision}, ` +
        `found ${actualRevision}`
    );
    this.name = "RevisionConflictError";
    this.invoiceId = invoiceId;
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

export class InvoiceNotFoundError extends Error {
  constructor(invoiceId: string) {
    super(`Invoice not found: ${invoiceId}`);
    this.name = "InvoiceNotFoundError";
  }
}

export class InvoiceDeletedError extends Error {
  readonly invoiceId: string;
  readonly invoiceName: string;
  readonly deletedAt: string;

  constructor(deletion: InvoiceDeletionSentinel) {
    super(
      deletion.hardDeleteIncomplete
        ? `${deletion.invoiceName} has an incomplete permanent deletion recorded in ` +
            "DELETED.json. Some local files may already be missing; inspect the folder before " +
            "removing the marker."
        : `${deletion.invoiceName} is marked deleted by DELETED.json. ` +
            "Remove DELETED.json from its folder to recover the local invoice files."
    );
    this.name = "InvoiceDeletedError";
    this.invoiceId = deletion.invoiceId;
    this.invoiceName = deletion.invoiceName;
    this.deletedAt = deletion.deletedAt;
  }
}

export class BaseFolderNotConfiguredError extends Error {
  constructor() {
    super("Choose a base folder before working with invoices");
    this.name = "BaseFolderNotConfiguredError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function ensureOrdinaryDirectory(directory: string, label: string): Promise<void> {
  try {
    const metadata = await fs.lstat(directory);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new InvoiceValidationError(`${label} must be an ordinary directory`);
    }
  } catch (error) {
    if (!isErrno(error, "ENOENT")) {
      throw error;
    }
    await fs.mkdir(directory, { recursive: true });
    const metadata = await fs.lstat(directory);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new InvoiceValidationError(`${label} must be an ordinary directory`);
    }
  }
}

function invoiceFolderName(period: InvoicePeriod): string {
  return `invoice-${period.startDate}-${period.endDate}`;
}

function validateRemoveInvoiceOptions(value: unknown): Required<RemoveInvoiceOptions> {
  if (!isRecord(value)) {
    throw new InvoiceValidationError("Invoice removal options must be an object");
  }
  if (value.hardDelete !== undefined && typeof value.hardDelete !== "boolean") {
    throw new InvoiceValidationError("Hard delete must be a boolean");
  }
  return {
    expectedRevision: safeInteger(value.expectedRevision, "Expected revision", 0),
    hardDelete: value.hardDelete ?? false,
  };
}

function deletionWarning(): string {
  return (
    "Permanent deletion could not be completed. Some local files may already be missing; " +
    "anything remaining stays hidden by DELETED.json and can be inspected manually."
  );
}

export class InvoiceStore {
  private readonly invoiceOperations = new KeyedSerialQueue<string>();
  private readonly aliasesByBase = new Map<string, Map<string, string>>();
  private admissionTail: Promise<void> = Promise.resolve();
  private readonly now: () => Date;
  private readonly idFactory: () => string;

  constructor(
    private readonly getBaseFolderValue: BaseFolderGetter,
    private readonly options: InvoiceStoreOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? (() => `inv_${randomUUID()}`);
  }

  private async baseFolder(): Promise<string> {
    const configured = await this.getBaseFolderValue();
    if (typeof configured !== "string" || configured.trim() === "") {
      throw new BaseFolderNotConfiguredError();
    }
    const resolved = path.resolve(configured);
    let metadata: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      metadata = await fs.lstat(resolved);
    } catch (error) {
      if (isErrno(error, "ENOENT")) {
        throw new InvoiceValidationError(
          "The invoice base folder is unavailable. Reconnect it or choose it again."
        );
      }
      throw error;
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new InvoiceValidationError("The invoice base folder must be an ordinary directory");
    }
    return resolved;
  }

  private aliasesForBase(base: string): Map<string, string> {
    let aliases = this.aliasesByBase.get(base);
    if (!aliases) {
      aliases = new Map();
      this.aliasesByBase.set(base, aliases);
    }
    return aliases;
  }

  private cacheInvoice(base: string, folder: string, invoice: InvoiceDocument): void {
    const resolvedFolder = path.resolve(folder);
    if (path.dirname(resolvedFolder) !== base) return;

    const aliases = this.aliasesForBase(base);
    for (const [alias, cachedFolder] of aliases) {
      if (cachedFolder === resolvedFolder) aliases.delete(alias);
    }
    aliases.set(invoice.id, resolvedFolder);
    aliases.set(invoice.name, resolvedFolder);
  }

  private evictInvoiceFolder(base: string, folder: string): void {
    const aliases = this.aliasesByBase.get(base);
    if (!aliases) return;
    const resolvedFolder = path.resolve(folder);
    for (const [alias, cachedFolder] of aliases) {
      if (cachedFolder === resolvedFolder) aliases.delete(alias);
    }
    if (aliases.size === 0) this.aliasesByBase.delete(base);
  }

  private rebuildAliasCache(base: string, invoices: readonly DiscoveredInvoice[]): void {
    const aliases = new Map<string, string>();
    for (const { folder, invoice } of invoices) {
      aliases.set(invoice.id, folder);
      aliases.set(invoice.name, folder);
    }
    this.aliasesByBase.set(base, aliases);
  }

  private async readCachedInvoice(
    base: string,
    invoiceAlias: string
  ): Promise<DiscoveredInvoice | null> {
    const folder = this.aliasesByBase.get(base)?.get(invoiceAlias);
    if (!folder) return null;
    if (path.dirname(folder) !== base) {
      this.evictInvoiceFolder(base, folder);
      return null;
    }

    try {
      const folderMetadata = await fs.lstat(folder);
      if (folderMetadata.isSymbolicLink() || !folderMetadata.isDirectory()) {
        throw new InvoiceValidationError(`Path must be an ordinary invoice folder: ${folder}`);
      }
      const invoice = await this.readInvoiceFile(folder);
      this.cacheInvoice(base, folder, invoice);
      return invoice.id === invoiceAlias || invoice.name === invoiceAlias
        ? { folder, invoice }
        : null;
    } catch (error) {
      this.evictInvoiceFolder(base, folder);
      if (isErrno(error, "ENOENT")) return null;
      throw error;
    }
  }

  private invoiceQueueKey(folder: string): string {
    return `invoice:${path.resolve(folder)}`;
  }

  /**
   * Resolve caller-facing ID/name aliases in invocation order, then hand the
   * operation to the canonical per-folder queue. Only alias resolution is
   * globally serialized; operations for different invoices still run in
   * parallel once admitted.
   */
  private enqueueByInvoiceAlias<T>(
    invoiceId: string,
    operation: (folder: string) => Promise<T>
  ): Promise<T> {
    let queued: Promise<T> | undefined;
    const admission = this.admissionTail
      .catch(() => undefined)
      .then(async () => {
        const { folder } = await this.findInvoice(invoiceId);
        queued = this.invoiceOperations.run(this.invoiceQueueKey(folder), () => operation(folder));
      });
    this.admissionTail = admission.then(
      () => undefined,
      () => undefined
    );
    return admission.then(() => {
      if (!queued) {
        throw new InvoiceNotFoundError(invoiceId);
      }
      return queued;
    });
  }

  private async readDeletionSentinel(folder: string): Promise<InvoiceDeletionSentinel | null> {
    const filename = path.join(folder, "DELETED.json");
    let metadata: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      metadata = await fs.lstat(filename);
    } catch (error) {
      if (isErrno(error, "ENOENT")) {
        return null;
      }
      throw error;
    }
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new InvoiceValidationError(`DELETED.json must be an ordinary file: ${filename}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(await fs.readFile(filename, "utf8"));
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new InvoiceValidationError(`Invalid JSON in ${filename}: ${error.message}`);
      }
      throw error;
    }
    const deletion = validateInvoiceDeletionSentinel(parsed);
    if (deletion.invoiceName !== path.basename(folder)) {
      throw new InvoiceValidationError(
        `DELETED.json invoice name does not match folder ${path.basename(folder)}`
      );
    }
    return deletion;
  }

  private async readInvoiceFile(folder: string): Promise<InvoiceDocument> {
    const deletion = await this.readDeletionSentinel(folder);
    if (deletion) {
      throw new InvoiceDeletedError(deletion);
    }
    const filename = path.join(folder, "invoice.json");
    let parsed: unknown;
    try {
      const metadata = await fs.lstat(filename);
      if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw new InvoiceValidationError(`Invoice JSON must be an ordinary file: ${filename}`);
      }
      parsed = JSON.parse(await fs.readFile(filename, "utf8"));
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new InvoiceValidationError(`Invalid JSON in ${filename}: ${error.message}`);
      }
      throw error;
    }
    const invoice = validateInvoiceDocument(parsed);
    const folderName = path.basename(folder);
    if (invoice.name !== folderName || invoice.name !== invoiceFolderName(invoice.period)) {
      throw new InvoiceValidationError(`Invoice name and period do not match folder ${folderName}`);
    }
    return invoice;
  }

  private async discoverInvoices(baseValue?: string): Promise<DiscoveredInvoice[]> {
    const base = baseValue ?? (await this.baseFolder());
    const entries = await fs.readdir(base, { withFileTypes: true });
    const discovered: DiscoveredInvoice[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const folder = path.join(base, entry.name);
      try {
        if (await this.readDeletionSentinel(folder)) {
          continue;
        }
        if (!(await fileExists(path.join(folder, "invoice.json")))) {
          continue;
        }
        discovered.push({ folder, invoice: await this.readInvoiceFile(folder) });
      } catch (error) {
        // A corrupt or future-version invoice should not hide every healthy
        // invoice from the picker. Loading its folder directly still surfaces it.
        if (!(error instanceof InvoiceValidationError)) {
          throw error;
        }
      }
    }
    this.rebuildAliasCache(base, discovered);
    return discovered;
  }

  private async findInvoice(invoiceId: string): Promise<DiscoveredInvoice> {
    const base = await this.baseFolder();
    const cached = await this.readCachedInvoice(base, invoiceId);
    if (cached) {
      return cached;
    }

    const directFolder = path.join(base, invoiceId);
    if (path.dirname(directFolder) === base) {
      let metadata: Awaited<ReturnType<typeof fs.lstat>> | undefined;
      try {
        metadata = await fs.lstat(directFolder);
      } catch (error) {
        if (!isErrno(error, "ENOENT")) throw error;
      }
      if (metadata) {
        if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
          throw new InvoiceValidationError(
            `Path must be an ordinary invoice folder: ${directFolder}`
          );
        }
        const deletion = await this.readDeletionSentinel(directFolder);
        if (deletion && (deletion.invoiceId === invoiceId || deletion.invoiceName === invoiceId)) {
          throw new InvoiceDeletedError(deletion);
        }
        if (await fileExists(path.join(directFolder, "invoice.json"))) {
          const invoice = await this.readInvoiceFile(directFolder);
          this.cacheInvoice(base, directFolder, invoice);
          if (invoice.id === invoiceId || invoice.name === invoiceId) {
            return { folder: directFolder, invoice };
          }
        }
      }
    }

    const match = (await this.discoverInvoices(base)).find(
      ({ invoice }) => invoice.id === invoiceId || invoice.name === invoiceId
    );
    if (match) {
      return match;
    }

    const entries = await fs.readdir(base, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const deletion = await this.readDeletionSentinel(path.join(base, entry.name));
      if (deletion?.invoiceId === invoiceId || deletion?.invoiceName === invoiceId) {
        throw new InvoiceDeletedError(deletion);
      }
    }
    throw new InvoiceNotFoundError(invoiceId);
  }

  private async writeViews(folder: string, invoice: InvoiceDocument): Promise<void> {
    const exportOptions = { includeHeaders: true, includeTotals: true } as const;
    const writes = [
      atomicWriteFile(
        path.join(folder, INVOICE_VIEW_FILENAMES[0]),
        invoiceToTsv(invoice, exportOptions),
        {
          mode: 0o644,
        }
      ),
      atomicWriteFile(
        path.join(folder, INVOICE_VIEW_FILENAMES[1]),
        invoiceToCsv(invoice, exportOptions),
        {
          mode: 0o644,
        }
      ),
    ];
    const results = await Promise.allSettled(writes);
    const failures = results.flatMap((result, index) => {
      if (result.status === "rejected") return [result.reason];
      return result.value.directorySynced
        ? []
        : [new Error(`Could not durably replace ${INVOICE_VIEW_FILENAMES[index]}`)];
    });
    if (failures.length === 1) {
      throw failures[0];
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, "Could not regenerate invoice views");
    }
  }

  private async writeViewState(
    folder: string,
    invoice: InvoiceDocument,
    state: InvoiceViewState["state"]
  ): Promise<boolean> {
    const result = await atomicWriteFile(
      path.join(folder, INVOICE_VIEW_STATE_FILENAME),
      serializeInvoiceViewState({
        schemaVersion: INVOICE_VIEW_STATE_SCHEMA_VERSION,
        revision: invoice.revision,
        invoiceSha256: invoiceDocumentFingerprint(invoice),
        state,
      }),
      { mode: 0o600 }
    );
    return result.directorySynced;
  }

  private async beginViewWrite(folder: string, invoice: InvoiceDocument): Promise<void> {
    if (!(await this.writeViewState(folder, invoice, "dirty"))) {
      throw new Error("Could not establish a durable invoice view update marker");
    }
  }

  private async writeViewsWithState(folder: string, invoice: InvoiceDocument): Promise<void> {
    await this.beginViewWrite(folder, invoice);
    await this.writeViews(folder, invoice);
    await this.writeViewState(folder, invoice, "clean");
  }

  private async writeInvoice(folder: string, invoice: InvoiceDocument): Promise<void> {
    // invoice.json is authoritative. Write the replaceable views first so a
    // rejected operation always leaves the authoritative revision unchanged.
    await this.beginViewWrite(folder, invoice);
    await this.writeViews(folder, invoice);
    const invoiceWrite = await atomicWriteFile(
      path.join(folder, "invoice.json"),
      serializeInvoiceDocument(invoice),
      {
        mode: 0o600,
        retainBackup: true,
      }
    );
    // The JSON rename above is the authoritative commit point. A failed clean
    // marker must not report the committed mutation as rejected; the dirty
    // marker deliberately makes the next bounded repair retry the views.
    if (invoiceWrite.directorySynced) {
      await this.writeViewState(folder, invoice, "clean").catch(() => undefined);
    }
  }

  private async readViewState(folder: string): Promise<InvoiceViewState | null> {
    const filename = path.join(folder, INVOICE_VIEW_STATE_FILENAME);
    try {
      const metadata = await fs.lstat(filename);
      if (metadata.isSymbolicLink() || !metadata.isFile()) return null;
      return validateInvoiceViewState(JSON.parse(await fs.readFile(filename, "utf8")));
    } catch {
      return null;
    }
  }

  private async hasOrdinaryViews(folder: string): Promise<boolean> {
    const metadata = await Promise.all(
      INVOICE_VIEW_FILENAMES.map(async (filename) => {
        try {
          return await fs.lstat(path.join(folder, filename));
        } catch {
          return null;
        }
      })
    );
    return metadata.every((item) => item !== null && !item.isSymbolicLink() && item.isFile());
  }

  private async viewsAreCurrent(folder: string, invoice: InvoiceDocument): Promise<boolean> {
    const [state, hasViews] = await Promise.all([
      this.readViewState(folder),
      this.hasOrdinaryViews(folder),
    ]);
    return (
      state?.state === "clean" &&
      state.revision === invoice.revision &&
      state.invoiceSha256 === invoiceDocumentFingerprint(invoice) &&
      hasViews
    );
  }

  private async repairViewsInFolder(folder: string): Promise<boolean> {
    const invoice = await this.readInvoiceFile(folder);
    if (await this.viewsAreCurrent(folder, invoice)) return false;

    await this.writeViewsWithState(folder, invoice);
    return true;
  }

  private async repairDiscoveredViews(
    invoices: readonly DiscoveredInvoice[]
  ): Promise<InvoiceViewRepairReport> {
    const outcomes = await mapBounded(
      invoices,
      INVOICE_VIEW_REPAIR_CONCURRENCY,
      async ({ folder, invoice }) => {
        try {
          const repaired = await this.invoiceOperations.run(
            this.invoiceQueueKey(folder),
            async () => {
              // Discovery already validated this authoritative revision. Checking
              // its marker inside the invoice queue avoids a race with mutations
              // without re-reading clean invoice JSON on the normal fast path.
              if (await this.viewsAreCurrent(folder, invoice)) return false;
              return this.repairViewsInFolder(folder);
            }
          );
          return { repaired, invoice, message: null };
        } catch (error) {
          return {
            repaired: false,
            invoice,
            message:
              error instanceof Error ? error.message : "Unexpected invoice view repair error.",
          };
        }
      }
    );
    return {
      checked: outcomes.length,
      repaired: outcomes.filter(({ repaired }) => repaired).length,
      failures: outcomes.flatMap(({ invoice, message }) =>
        message === null ? [] : [{ invoiceId: invoice.id, invoiceName: invoice.name, message }]
      ),
    };
  }

  private async ensureInvoiceDirectories(folder: string): Promise<void> {
    await ensureOrdinaryDirectory(folder, "Invoice folder");
    await Promise.all(
      ["receipts", "debug", ".trash"].map((name) =>
        ensureOrdinaryDirectory(path.join(folder, name), `${name} directory`)
      )
    );
  }

  private async canonicalInvoiceFolderForRemoval(
    folder: string,
    invoice: InvoiceDocument
  ): Promise<{ base: string; folder: string }> {
    const base = await this.baseFolder();
    const resolvedFolder = path.resolve(folder);
    if (
      resolvedFolder === base ||
      path.dirname(resolvedFolder) !== base ||
      path.basename(resolvedFolder) !== invoice.name
    ) {
      throw new InvoiceValidationError("Refusing to remove a path outside the invoice base folder");
    }

    const metadata = await fs.lstat(resolvedFolder);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new InvoiceValidationError("Invoice removal requires an ordinary invoice folder");
    }
    const [canonicalBase, canonicalFolder] = await Promise.all([
      fs.realpath(base),
      fs.realpath(resolvedFolder),
    ]);
    if (
      canonicalFolder === canonicalBase ||
      path.dirname(canonicalFolder) !== canonicalBase ||
      path.basename(canonicalFolder) !== invoice.name
    ) {
      throw new InvoiceValidationError(
        "Refusing to remove a non-canonical invoice folder or symbolic link"
      );
    }

    const rechecked = await fs.lstat(resolvedFolder);
    if (
      rechecked.isSymbolicLink() ||
      !rechecked.isDirectory() ||
      rechecked.dev !== metadata.dev ||
      rechecked.ino !== metadata.ino
    ) {
      throw new InvoiceValidationError("The invoice folder changed during removal");
    }
    return { base: canonicalBase, folder: canonicalFolder };
  }

  private async hardDeleteMarkedFolder(
    canonicalBase: string,
    canonicalFolder: string,
    deletion: InvoiceDeletionSentinel
  ): Promise<boolean> {
    const sentinelPath = path.join(canonicalFolder, "DELETED.json");
    try {
      const metadata = await fs.lstat(canonicalFolder);
      const realFolder = await fs.realpath(canonicalFolder);
      if (
        metadata.isSymbolicLink() ||
        !metadata.isDirectory() ||
        realFolder !== canonicalFolder ||
        path.dirname(realFolder) !== canonicalBase ||
        path.basename(realFolder) !== deletion.invoiceName
      ) {
        return false;
      }

      const entries = await fs.readdir(canonicalFolder);
      const removableEntries = entries.filter(
        (entry) => entry !== "DELETED.json" && entry !== "invoice.json"
      );
      if (entries.includes("invoice.json")) {
        removableEntries.push("invoice.json");
      }

      for (const entry of removableEntries) {
        const child = path.join(canonicalFolder, entry);
        if (path.dirname(child) !== canonicalFolder) {
          throw new InvoiceValidationError("Refusing to remove an unsafe invoice child path");
        }
        const metadata = await fs.lstat(child);
        if (metadata.isSymbolicLink()) {
          await fs.unlink(child);
        } else {
          await fs.rm(child, { recursive: true, force: false });
        }
      }

      await fs.unlink(sentinelPath);
      try {
        await fs.rmdir(canonicalFolder);
      } catch {
        return this.restoreDeletionSentinelOrConfirmRemoved(
          canonicalBase,
          canonicalFolder,
          deletion
        );
      }
      await syncDirectory(canonicalBase).catch(() => undefined);
      return true;
    } catch {
      return this.restoreDeletionSentinelOrConfirmRemoved(canonicalBase, canonicalFolder, deletion);
    }
  }

  private async restoreDeletionSentinelOrConfirmRemoved(
    canonicalBase: string,
    canonicalFolder: string,
    deletion: InvoiceDeletionSentinel
  ): Promise<boolean> {
    let metadata: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      metadata = await fs.lstat(canonicalFolder);
    } catch (error) {
      return isErrno(error, "ENOENT");
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      return false;
    }

    try {
      const realFolder = await fs.realpath(canonicalFolder);
      if (
        realFolder !== canonicalFolder ||
        path.dirname(realFolder) !== canonicalBase ||
        path.basename(realFolder) !== deletion.invoiceName
      ) {
        return false;
      }
      await atomicWriteFile(
        path.join(realFolder, "DELETED.json"),
        serializeInvoiceDeletionSentinel(deletion),
        { mode: 0o600 }
      );
    } catch {
      // Never follow a replacement folder or link merely to restore the marker.
    }
    return false;
  }

  async listInvoices(): Promise<InvoiceSummary[]> {
    const invoices = await this.discoverInvoices();
    await this.repairDiscoveredViews(invoices);
    return invoices
      .map(({ invoice }) => ({
        id: invoice.id,
        name: invoice.name,
        period: { ...invoice.period },
        rowCount: invoice.rows.length,
        receiptCount: invoice.receipts.length,
        updatedAt: invoice.updatedAt,
      }))
      .sort(
        (left, right) =>
          right.period.startDate.localeCompare(left.period.startDate) ||
          right.updatedAt.localeCompare(left.updatedAt) ||
          left.name.localeCompare(right.name)
      );
  }

  async createInvoice(
    periodValue: InvoicePeriod,
    defaultRateMinor?: number
  ): Promise<InvoiceDocument> {
    const period = validatePeriod(periodValue);
    const name = invoiceFolderName(period);
    const base = await this.baseFolder();
    const folder = path.join(base, name);

    return this.invoiceOperations.run(this.invoiceQueueKey(folder), async () => {
      if (await fileExists(folder)) {
        await ensureOrdinaryDirectory(folder, "Invoice folder");
        const deletion = await this.readDeletionSentinel(folder);
        if (deletion) {
          throw new InvoiceDeletedError(deletion);
        }
      }
      const invoiceFilename = path.join(folder, "invoice.json");
      if (await fileExists(invoiceFilename)) {
        const existing = await this.readInvoiceFile(folder);
        if (
          existing.name !== name ||
          existing.period.startDate !== period.startDate ||
          existing.period.endDate !== period.endDate
        ) {
          throw new InvoiceValidationError(`Existing ${name} contains a different invoice period`);
        }
        await this.ensureInvoiceDirectories(folder);
        await this.writeViewsWithState(folder, existing);
        this.cacheInvoice(base, folder, existing);
        return cloneInvoiceDocument(existing);
      }

      if (await fileExists(folder)) {
        const contents = await fs.readdir(folder);
        if (contents.length > 0) {
          throw new InvoiceValidationError(
            `Cannot create ${name}: the folder exists without invoice.json`
          );
        }
      }

      const configuredRate =
        defaultRateMinor ??
        (this.options.getDefaultRateMinor ? await this.options.getDefaultRateMinor() : 4500);
      safeInteger(configuredRate, "Default rate", 0);
      const timestamp = this.now().toISOString();
      const invoice: InvoiceDocument = {
        schemaVersion: INVOICE_SCHEMA_VERSION,
        id: this.idFactory(),
        name,
        period,
        defaultRateMinor: configuredRate,
        currency: "USD",
        revision: 0,
        rows: [],
        receipts: [],
        reviewAcknowledgements: [],
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const validated = validateInvoiceDocument(invoice);

      await fs.mkdir(folder, { recursive: true });
      await this.ensureInvoiceDirectories(folder);
      await this.writeInvoice(folder, validated);
      this.cacheInvoice(base, folder, validated);
      return cloneInvoiceDocument(validated);
    });
  }

  async loadInvoice(invoiceId: string): Promise<InvoiceDocument> {
    return this.enqueueByInvoiceAlias(invoiceId, async (folder) => {
      const current = await this.readInvoiceFile(folder);
      await this.ensureInvoiceDirectories(folder);
      this.cacheInvoice(path.dirname(folder), folder, current);
      return cloneInvoiceDocument(current);
    });
  }

  async removeInvoice(
    invoiceId: string,
    optionsValue: RemoveInvoiceOptions
  ): Promise<InvoiceRemovalResult> {
    const validatedInvoiceId = requiredString(invoiceId, "Invoice id");
    const options = validateRemoveInvoiceOptions(optionsValue);
    return this.enqueueByInvoiceAlias(validatedInvoiceId, async (folder) => {
      const current = await this.readInvoiceFile(folder);
      if (current.revision !== options.expectedRevision) {
        throw new RevisionConflictError(current.id, options.expectedRevision, current.revision);
      }

      const canonical = await this.canonicalInvoiceFolderForRemoval(folder, current);
      const deletion: InvoiceDeletionSentinel = {
        schemaVersion: INVOICE_DELETION_SCHEMA_VERSION,
        invoiceId: current.id,
        invoiceName: current.name,
        lastRevision: current.revision,
        deletedAt: this.now().toISOString(),
        ...(options.hardDelete ? { hardDeleteIncomplete: true } : {}),
      };
      await atomicWriteFile(
        path.join(canonical.folder, "DELETED.json"),
        serializeInvoiceDeletionSentinel(deletion),
        { mode: 0o600 }
      );
      this.evictInvoiceFolder(path.dirname(folder), folder);

      if (!options.hardDelete) {
        return {
          invoiceId: current.id,
          invoiceName: current.name,
          mode: "soft",
          deletedAt: deletion.deletedAt,
        };
      }

      let rechecked: { base: string; folder: string };
      try {
        rechecked = await this.canonicalInvoiceFolderForRemoval(folder, current);
      } catch {
        return {
          invoiceId: current.id,
          invoiceName: current.name,
          mode: "soft",
          deletedAt: deletion.deletedAt,
          warning: deletionWarning(),
        };
      }
      const hardDeleted = await this.hardDeleteMarkedFolder(
        rechecked.base,
        rechecked.folder,
        deletion
      );
      return {
        invoiceId: current.id,
        invoiceName: current.name,
        mode: hardDeleted ? "hard" : "soft",
        deletedAt: deletion.deletedAt,
        ...(hardDeleted ? {} : { warning: deletionWarning() }),
      };
    });
  }

  async saveRows(
    invoiceId: string,
    rows: InvoiceRow[],
    expectedRevision: number
  ): Promise<InvoiceDocument> {
    const rowsSnapshot = structuredClone(rows);
    return this.mutateInvoice(
      invoiceId,
      (draft) => {
        draft.rows = rowsSnapshot;
      },
      expectedRevision
    );
  }

  async mutateInvoice(
    invoiceId: string,
    mutator: InvoiceMutator,
    expectedRevision?: number
  ): Promise<InvoiceDocument> {
    if (expectedRevision !== undefined) {
      safeInteger(expectedRevision, "Expected revision", 0);
    }
    return this.enqueueByInvoiceAlias(invoiceId, async (folder) => {
      const current = await this.readInvoiceFile(folder);
      if (expectedRevision !== undefined && current.revision !== expectedRevision) {
        throw new RevisionConflictError(current.id, expectedRevision, current.revision);
      }

      const draft = cloneInvoiceDocument(current);
      const returned = await mutator(draft);
      const candidate = validateInvoiceDocument(returned ?? draft);
      candidate.schemaVersion = INVOICE_SCHEMA_VERSION;
      candidate.id = current.id;
      candidate.name = current.name;
      candidate.period = { ...current.period };
      candidate.createdAt = current.createdAt;
      candidate.revision = safeInteger(current.revision + 1, "Invoice revision", 0);
      candidate.updatedAt = this.now().toISOString();

      await this.writeInvoice(folder, candidate);
      this.cacheInvoice(path.dirname(folder), folder, candidate);
      return cloneInvoiceDocument(candidate);
    });
  }

  async runAtRevision<T>(
    invoiceId: string,
    expectedRevision: number,
    operation: (invoice: InvoiceDocument, invoiceFolder: string) => T | Promise<T>
  ): Promise<T> {
    safeInteger(expectedRevision, "Expected revision", 0);
    return this.enqueueByInvoiceAlias(invoiceId, async (folder) => {
      const current = await this.readInvoiceFile(folder);
      if (current.revision !== expectedRevision) {
        throw new RevisionConflictError(current.id, expectedRevision, current.revision);
      }
      return operation(cloneInvoiceDocument(current), folder);
    });
  }

  async getInvoiceFolder(invoiceId: string): Promise<string> {
    return (await this.findInvoice(invoiceId)).folder;
  }

  async findHash(sha256: string): Promise<InvoiceHashMatch[]> {
    const normalized = sha256.trim().toLowerCase();
    if (normalized === "") {
      return [];
    }
    return (await this.findHashes([normalized])).get(normalized) ?? [];
  }

  async findHashes(sha256Values: Iterable<string>): Promise<Map<string, InvoiceHashMatch[]>> {
    const normalizedHashes = new Set(
      [...sha256Values]
        .map((sha256) => sha256.trim().toLowerCase())
        .filter((sha256) => sha256 !== "")
    );
    const matchesByHash = new Map<string, InvoiceHashMatch[]>(
      [...normalizedHashes].map((sha256) => [sha256, []])
    );
    if (normalizedHashes.size === 0) {
      return matchesByHash;
    }

    for (const { invoice } of await this.discoverInvoices()) {
      for (const receipt of invoice.receipts) {
        const normalized = receipt.sha256.trim().toLowerCase();
        const matches = matchesByHash.get(normalized);
        if (matches) {
          matches.push({
            invoiceId: invoice.id,
            invoiceName: invoice.name,
            receiptId: receipt.id,
            relativePath: receipt.relativePath,
          });
        }
      }
    }
    for (const matches of matchesByHash.values()) {
      matches.sort(
        (left, right) =>
          left.invoiceName.localeCompare(right.invoiceName) ||
          left.invoiceId.localeCompare(right.invoiceId) ||
          left.receiptId.localeCompare(right.receiptId)
      );
    }
    return matchesByHash;
  }

  async regenerateViews(invoiceOrId: InvoiceDocument | string): Promise<void> {
    const invoiceId = typeof invoiceOrId === "string" ? invoiceOrId : invoiceOrId.id;
    await this.enqueueByInvoiceAlias(invoiceId, async (folder) => {
      // invoice.json is authoritative. Re-read inside the invoice queue so a
      // stale caller object can never roll the generated views backwards.
      const current = await this.readInvoiceFile(folder);
      await this.writeViewsWithState(folder, current);
    });
  }

  /** Explicit maintenance hook; normal startup reuses listInvoices' discovery pass. */
  async repairDerivedViews(): Promise<InvoiceViewRepairReport> {
    return this.repairDiscoveredViews(await this.discoverInvoices());
  }
}
