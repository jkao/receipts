import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { InvoiceDocument, InvoiceRow, ReceiptRecord } from "../shared/types";
import type { InvoiceStore } from "./invoice-store";
import { pathExists, resolveInside, writeJsonAtomic } from "./receipt-files";

interface IndexedRow {
  index: number;
  value: InvoiceRow;
}

interface IndexedReceipt {
  index: number;
  value: ReceiptRecord;
}

interface TrashManifest {
  invoiceId: string;
  deletedAt: string;
  rows: IndexedRow[];
  receipts: IndexedReceipt[];
  movedRelativePaths: string[];
}

export class TrashManager {
  constructor(private readonly invoices: InvoiceStore) {}

  async deleteRows(invoiceId: string, rowIds: string[]): Promise<InvoiceDocument> {
    const selected = new Set(rowIds);
    if (selected.size === 0) {
      return this.invoices.loadInvoice(invoiceId);
    }

    const invoice = await this.invoices.loadInvoice(invoiceId);
    const rows = invoice.rows
      .map((value, index) => ({ index, value }))
      .filter(({ value }) => selected.has(value.id));
    if (rows.length === 0) {
      return invoice;
    }

    const remainingRows = invoice.rows.filter((row) => !selected.has(row.id));
    const stillReferenced = new Set(
      remainingRows.map((row) => row.receiptId).filter((id): id is string => Boolean(id))
    );
    const deletedReceiptIds = new Set(
      rows
        .map(({ value }) => value.receiptId)
        .filter((id): id is string => Boolean(id) && !stillReferenced.has(String(id)))
    );
    const receipts = invoice.receipts
      .map((value, index) => ({ index, value }))
      .filter(({ value }) => deletedReceiptIds.has(value.id));

    const invoiceFolder = await this.invoices.getInvoiceFolder(invoice.name);
    const entryName =
      "delete-" +
      new Date().toISOString().replace(/[:.]/g, "-") +
      "-" +
      crypto.randomUUID().slice(0, 8);
    const entryFolder = resolveInside(invoiceFolder, path.join(".trash", entryName));
    await fs.mkdir(entryFolder);

    const plannedRelativePaths: string[] = [];
    for (const { value: receipt } of receipts) {
      for (const relativePath of [receipt.relativePath, receipt.debugPath]) {
        const source = resolveInside(invoiceFolder, relativePath);
        if (await pathExists(source)) {
          plannedRelativePaths.push(relativePath);
        }
      }
    }
    const manifest: TrashManifest = {
      invoiceId: invoice.id,
      deletedAt: new Date().toISOString(),
      rows,
      receipts,
      movedRelativePaths: plannedRelativePaths,
    };
    // Persist the recovery information before moving the first managed file.
    try {
      await writeJsonAtomic(path.join(entryFolder, "manifest.json"), manifest);
    } catch (error) {
      await fs.rm(entryFolder, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }

    const movedRelativePaths: string[] = [];
    try {
      for (const relativePath of plannedRelativePaths) {
        const source = resolveInside(invoiceFolder, relativePath);
        const destination = resolveInside(entryFolder, relativePath);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.rename(source, destination);
        movedRelativePaths.push(relativePath);
      }

      return await this.invoices.mutateInvoice(
        invoice.id,
        (next) => {
          next.rows = next.rows.filter((row) => !selected.has(row.id));
          next.receipts = next.receipts.filter((receipt) => !deletedReceiptIds.has(receipt.id));
        },
        invoice.revision
      );
    } catch (error) {
      await this.restoreFiles(invoiceFolder, entryFolder, movedRelativePaths);
      await fs.rm(entryFolder, { recursive: true, force: true });
      throw error;
    }
  }

  async undoLastDelete(invoiceId: string): Promise<InvoiceDocument> {
    const initial = await this.invoices.loadInvoice(invoiceId);
    const invoiceFolder = await this.invoices.getInvoiceFolder(initial.name);
    const trashFolder = resolveInside(invoiceFolder, ".trash");
    let entries: string[];
    try {
      entries = (await fs.readdir(trashFolder, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && entry.name.startsWith("delete-"))
        .map((entry) => entry.name)
        .sort()
        .reverse();
    } catch (error) {
      if (isMissingFile(error)) {
        return this.invoices.loadInvoice(invoiceId);
      }
      throw error;
    }

    for (const entry of entries) {
      const entryFolder = resolveInside(invoiceFolder, path.join(".trash", entry));
      const manifestPath = path.join(entryFolder, "manifest.json");
      if (!(await pathExists(manifestPath))) {
        continue;
      }
      const manifest = validateTrashManifest(JSON.parse(await fs.readFile(manifestPath, "utf8")));
      if (manifest.invoiceId !== initial.id) {
        continue;
      }

      const current = await this.invoices.loadInvoice(initial.id);
      const currentRowIds = new Set(current.rows.map((row) => row.id));
      const currentReceiptIds = new Set(current.receipts.map((receipt) => receipt.id));
      const allRowsPresent = manifest.rows.every(({ value }) => currentRowIds.has(value.id));
      const allReceiptsPresent = manifest.receipts.every(({ value }) =>
        currentReceiptIds.has(value.id)
      );
      const anyRowsPresent = manifest.rows.some(({ value }) => currentRowIds.has(value.id));
      const anyReceiptsPresent = manifest.receipts.some(({ value }) =>
        currentReceiptIds.has(value.id)
      );
      if (allRowsPresent && allReceiptsPresent) {
        // The app stopped after preparing/moving files but before committing
        // metadata, or cleanup failed after a completed undo. Restore whichever
        // files moved and keep the already-present invoice records.
        await this.restoreFiles(invoiceFolder, entryFolder, manifest.movedRelativePaths, true);
        await fs.rm(entryFolder, { recursive: true, force: true }).catch(() => undefined);
        return current;
      }
      if (anyRowsPresent || anyReceiptsPresent) {
        throw new Error("Cannot restore because one of the deleted IDs is in use.");
      }

      await this.restoreFiles(invoiceFolder, entryFolder, manifest.movedRelativePaths);
      let restored: InvoiceDocument;
      try {
        restored = await this.invoices.mutateInvoice(
          initial.id,
          (next) => {
            next.rows = insertIndexed(next.rows, manifest.rows);
            next.receipts = insertIndexed(next.receipts, manifest.receipts);
          },
          current.revision
        );
      } catch (error) {
        await this.moveFilesToTrash(invoiceFolder, entryFolder, manifest.movedRelativePaths);
        throw error;
      }
      // The metadata commit makes the live files authoritative. Cleanup can be
      // retried later and must never move them away again.
      await fs.rm(entryFolder, { recursive: true, force: true }).catch(() => undefined);
      return restored;
    }

    return this.invoices.loadInvoice(invoiceId);
  }

  private async restoreFiles(
    invoiceFolder: string,
    entryFolder: string,
    relativePaths: string[],
    allowAlreadyRestored = false
  ): Promise<void> {
    const locations = relativePaths.map((relativePath) => ({
      relativePath,
      source: resolveInside(entryFolder, relativePath),
      destination: resolveInside(invoiceFolder, relativePath),
      sourceExists: false,
    }));
    for (const location of locations) {
      const { source, destination, relativePath } = location;
      const sourceExists = await pathExists(source);
      const destinationExists = await pathExists(destination);
      location.sourceExists = sourceExists;
      if (!sourceExists && !(allowAlreadyRestored && destinationExists)) {
        throw new Error(`Cannot restore missing trash file: ${relativePath}`);
      }
      if (sourceExists && destinationExists) {
        throw new Error(`Cannot restore because a managed path is in use: ${relativePath}`);
      }
    }

    const restored: string[] = [];
    try {
      for (const { source, destination, relativePath, sourceExists } of locations) {
        if (!sourceExists) continue;
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.rename(source, destination);
        restored.push(relativePath);
      }
    } catch (error) {
      try {
        await this.moveFilesToTrash(invoiceFolder, entryFolder, restored);
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "Could not restore all files or roll back the partial restore."
        );
      }
      throw error;
    }
  }

  private async moveFilesToTrash(
    invoiceFolder: string,
    entryFolder: string,
    relativePaths: string[]
  ): Promise<void> {
    const locations = relativePaths.map((relativePath) => ({
      relativePath,
      source: resolveInside(invoiceFolder, relativePath),
      destination: resolveInside(entryFolder, relativePath),
    }));
    for (const { source, destination, relativePath } of locations) {
      if (!(await pathExists(source))) {
        throw new Error(`Cannot return missing restored file to trash: ${relativePath}`);
      }
      if (await pathExists(destination)) {
        throw new Error(`Trash path is already occupied: ${relativePath}`);
      }
    }
    for (const { source, destination } of locations) {
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.rename(source, destination);
    }
  }
}

function insertIndexed<T>(current: T[], restored: Array<{ index: number; value: T }>): T[] {
  const next = [...current];
  for (const item of [...restored].sort((a, b) => a.index - b.index)) {
    next.splice(Math.min(item.index, next.length), 0, item.value);
  }
  return next;
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function validateTrashManifest(value: unknown): TrashManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Trash manifest must contain an object.");
  }
  const manifest = value as Partial<TrashManifest>;
  if (
    typeof manifest.invoiceId !== "string" ||
    typeof manifest.deletedAt !== "string" ||
    !Array.isArray(manifest.rows) ||
    !Array.isArray(manifest.receipts) ||
    !Array.isArray(manifest.movedRelativePaths) ||
    !manifest.movedRelativePaths.every((item) => typeof item === "string") ||
    !validIndexedValues(manifest.rows) ||
    !validIndexedValues(manifest.receipts)
  ) {
    throw new Error("Trash manifest is invalid.");
  }
  return manifest as TrashManifest;
}

function validIndexedValues(values: Array<{ index?: unknown; value?: unknown }>): boolean {
  return values.every(
    (item) =>
      typeof item === "object" &&
      item !== null &&
      Number.isSafeInteger(item.index) &&
      Number(item.index) >= 0 &&
      typeof item.value === "object" &&
      item.value !== null &&
      !Array.isArray(item.value)
  );
}
