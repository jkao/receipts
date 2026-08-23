import { describe, expect, it } from "vitest";

import { INVOICE_SCHEMA_VERSION, type InvoiceDocument } from "../shared/types";
import {
  cloneInvoiceDocument,
  InvoiceValidationError,
  invoiceDocumentFingerprint,
  serializeInvoiceDeletionSentinel,
  serializeInvoiceDocument,
  serializeInvoiceViewState,
  validateInvoiceDocument,
  validateInvoiceViewState,
} from "./invoice-codec";

const INVOICE: InvoiceDocument = {
  schemaVersion: INVOICE_SCHEMA_VERSION,
  id: "inv-1",
  name: "invoice-2026-01-01-2026-01-31",
  period: { startDate: "2026-01-01", endDate: "2026-01-31" },
  defaultRateMinor: 4500,
  currency: "USD",
  revision: 0,
  rows: [],
  receipts: [],
  reviewAcknowledgements: [],
  createdAt: "2026-02-01T00:00:00.000Z",
  updatedAt: "2026-02-01T00:00:00.000Z",
};

describe("invoice codec", () => {
  it("validates into detached data and canonicalizes receipt hashes", () => {
    const candidate = {
      ...INVOICE,
      period: { ...INVOICE.period },
      receipts: [
        {
          id: "receipt-1",
          relativePath: "receipts/receipt-1.jpg",
          debugPath: "debug/receipt-1.json",
          originalFilename: "receipt.jpg",
          mimeType: "image/jpeg",
          sha256: "A".repeat(64),
          source: { kind: "manual", method: "file-picker" },
          status: "ready",
          importedAt: "2026-02-01T00:00:00.000Z",
        },
      ],
    };

    const validated = validateInvoiceDocument(candidate);

    expect(validated).not.toBe(candidate);
    expect(validated.period).not.toBe(candidate.period);
    expect(validated.receipts[0].sha256).toBe("a".repeat(64));
  });

  it("rejects invalid schema data with the stable validation error", () => {
    expect(() => validateInvoiceDocument({ ...INVOICE, revision: -1 })).toThrow(
      InvoiceValidationError
    );
  });

  it("serializes persisted documents as indented newline-terminated JSON", () => {
    const serializedInvoice = serializeInvoiceDocument(INVOICE);
    const serializedDeletion = serializeInvoiceDeletionSentinel({
      schemaVersion: 1,
      invoiceId: INVOICE.id,
      invoiceName: INVOICE.name,
      lastRevision: INVOICE.revision,
      deletedAt: "2026-02-02T00:00:00.000Z",
    });

    expect(serializedInvoice).toBe(`${JSON.stringify(INVOICE, null, 2)}\n`);
    expect(serializedDeletion.endsWith("\n")).toBe(true);
    expect(JSON.parse(serializedDeletion)).toMatchObject({ invoiceId: INVOICE.id });
  });

  it("validates and serializes the derived-view revision marker", () => {
    const state = validateInvoiceViewState({
      schemaVersion: 1,
      revision: 12,
      invoiceSha256: "a".repeat(64),
      state: "dirty",
    });

    expect(state).toEqual({
      schemaVersion: 1,
      revision: 12,
      invoiceSha256: "a".repeat(64),
      state: "dirty",
    });
    expect(serializeInvoiceViewState(state)).toBe(`${JSON.stringify(state, null, 2)}\n`);
    expect(() =>
      validateInvoiceViewState({
        schemaVersion: 1,
        revision: -1,
        invoiceSha256: "a".repeat(64),
        state: "clean",
      })
    ).toThrow(InvoiceValidationError);
    expect(() =>
      validateInvoiceViewState({
        schemaVersion: 1,
        revision: 1,
        invoiceSha256: "a".repeat(64),
        state: "unknown",
      })
    ).toThrow(InvoiceValidationError);
    expect(() =>
      validateInvoiceViewState({
        schemaVersion: 1,
        revision: 1,
        invoiceSha256: "not-a-hash",
        state: "clean",
      })
    ).toThrow(InvoiceValidationError);
    expect(invoiceDocumentFingerprint(INVOICE)).toMatch(/^[0-9a-f]{64}$/);
    expect(invoiceDocumentFingerprint({ ...INVOICE, revision: 1 })).not.toBe(
      invoiceDocumentFingerprint(INVOICE)
    );
  });

  it("deep-clones invoice data", () => {
    const clone = cloneInvoiceDocument(INVOICE);
    clone.period.startDate = "2025-01-01";

    expect(INVOICE.period.startDate).toBe("2026-01-01");
  });
});
