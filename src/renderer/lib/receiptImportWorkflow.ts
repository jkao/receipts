import type {
  DesktopApi,
  ImportDuplicate,
  ImportFilesOptions,
  ImportJobStartResult,
} from "../../shared/types";

interface ReceiptImportWorkflowOptions {
  api: Pick<DesktopApi, "startImport">;
  invoiceId: string;
  paths: string[];
  method: NonNullable<ImportFilesOptions["method"]>;
  confirmCrossInvoiceDuplicates: (duplicates: ImportDuplicate[]) => boolean;
  onStarted: (result: ImportJobStartResult, paths: string[]) => void;
}

export interface ReceiptImportWorkflowResult {
  importedCount: number;
  duplicates: ImportDuplicate[];
  errors: Array<{ filename: string; message: string }>;
}

/**
 * Start one durable background batch, then optionally a second batch for
 * cross-invoice duplicates the user explicitly approved.
 */
export async function startReceiptImportWorkflow({
  api,
  invoiceId,
  paths,
  method,
  confirmCrossInvoiceDuplicates,
  onStarted,
}: ReceiptImportWorkflowOptions): Promise<ReceiptImportWorkflowResult> {
  const first = await api.startImport(invoiceId, paths, { method });
  onStarted(first, paths);

  let importedCount = first.importedCount;
  const duplicates = [...first.duplicates];
  const errors = [...first.errors];
  const crossInvoiceDuplicates = first.duplicates.filter((duplicate) => !duplicate.sameInvoice);

  if (crossInvoiceDuplicates.length > 0 && confirmCrossInvoiceDuplicates(crossInvoiceDuplicates)) {
    const duplicatePaths = crossInvoiceDuplicates.map((duplicate) => duplicate.path);
    const approved = await api.startImport(invoiceId, duplicatePaths, {
      method,
      allowCrossInvoiceDuplicates: true,
    });
    onStarted(approved, duplicatePaths);
    importedCount += approved.importedCount;
    duplicates.push(...approved.duplicates);
    errors.push(...approved.errors);
  }

  return { importedCount, duplicates, errors };
}
