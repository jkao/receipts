import { describe, expect, it, vi } from "vitest";
import type { ImportJobStartResult, InvoiceDocument } from "../../shared/types";
import { startReceiptImportWorkflow } from "./receiptImportWorkflow";

describe("receipt import workflow", () => {
  it("starts an explicitly approved cross-invoice duplicate batch", async () => {
    const first = result("job-1", 1, [
      {
        path: "/receipts/duplicate.png",
        filename: "duplicate.png",
        matchInvoiceName: "invoice-old",
        sameInvoice: false,
      },
    ]);
    const second = result("job-2", 1, []);
    const startImport = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const onStarted = vi.fn();

    const outcome = await startReceiptImportWorkflow({
      api: { startImport },
      invoiceId: "invoice-1",
      paths: ["/receipts/new.png", "/receipts/duplicate.png"],
      method: "drag-drop",
      confirmCrossInvoiceDuplicates: () => true,
      onStarted,
    });

    expect(startImport).toHaveBeenNthCalledWith(2, "invoice-1", ["/receipts/duplicate.png"], {
      method: "drag-drop",
      allowCrossInvoiceDuplicates: true,
    });
    expect(onStarted).toHaveBeenCalledTimes(2);
    expect(outcome.importedCount).toBe(2);
  });

  it("leaves an unapproved duplicate out of the second batch", async () => {
    const duplicate = {
      path: "/receipts/duplicate.png",
      filename: "duplicate.png",
      matchInvoiceName: "invoice-old",
      sameInvoice: false,
    };
    const startImport = vi.fn().mockResolvedValue(result("job-1", 0, [duplicate]));

    const outcome = await startReceiptImportWorkflow({
      api: { startImport },
      invoiceId: "invoice-1",
      paths: [duplicate.path],
      method: "file-picker",
      confirmCrossInvoiceDuplicates: () => false,
      onStarted: vi.fn(),
    });

    expect(startImport).toHaveBeenCalledOnce();
    expect(outcome.duplicates).toEqual([duplicate]);
  });
});

function result(
  jobId: string,
  importedCount: number,
  duplicates: ImportJobStartResult["duplicates"]
): ImportJobStartResult {
  return {
    jobId,
    invoice: { id: "invoice-1", name: "invoice-1" } as InvoiceDocument,
    importedCount,
    duplicates,
    errors: [],
  };
}
