import { describe, expect, it } from "vitest";
import {
  appErrorCode,
  appErrorMessage,
  appErrorPayload,
  isIpcWireResult,
  ReceiptInvoiceError,
} from "./app-error";

describe("application error contract", () => {
  it.each([
    ["RevisionConflictError", "REVISION_CONFLICT"],
    ["InvoiceDeletedError", "INVOICE_DELETED"],
    ["InvoiceNotFoundError", "INVOICE_NOT_FOUND"],
    ["InvoiceValidationError", "VALIDATION_ERROR"],
  ] as const)("maps %s to %s", (name, code) => {
    const error = Object.assign(new Error("Domain failure."), { name });
    expect(appErrorPayload(error)).toEqual({ code, message: "Domain failure." });
  });

  it("classifies built-in validation failures and safe unknown errors", () => {
    expect(appErrorPayload(new TypeError("Wrong type."))).toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(appErrorPayload(new RangeError("Too large."))).toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(appErrorPayload(new Error("Disk failed."))).toEqual({
      code: "UNKNOWN_ERROR",
      message: "Disk failed.",
    });
    expect(appErrorPayload("not an Error")).toEqual({
      code: "UNKNOWN_ERROR",
      message: "Unexpected application error.",
    });
  });

  it("preserves a machine-readable code after Error serialization", () => {
    const error = new ReceiptInvoiceError("INVOICE_NOT_FOUND", "Invoice not found.");

    expect(appErrorCode(error.message)).toBe("INVOICE_NOT_FOUND");
    expect(appErrorMessage(error)).toBe("Invoice not found.");
    expect(appErrorCode({ code: "INVOICE_DELETED" })).toBe("INVOICE_DELETED");
    expect(appErrorCode("[receipt-invoice-error:MADE_UP] no")).toBeNull();
    expect(appErrorCode(null)).toBeNull();
    expect(appErrorMessage("Plain failure.")).toBe("Plain failure.");
    expect(appErrorMessage(null, "Fallback.")).toBe("Fallback.");
  });

  it("recognizes only complete IPC envelopes", () => {
    expect(isIpcWireResult({ ok: true, value: undefined })).toBe(true);
    expect(isIpcWireResult({ ok: true })).toBe(false);
    expect(
      isIpcWireResult({
        ok: false,
        error: { code: "VALIDATION_ERROR", message: "Invalid date." },
      })
    ).toBe(true);
    expect(isIpcWireResult({ ok: false, error: { message: "Invalid date." } })).toBe(false);
    expect(
      isIpcWireResult({ ok: false, error: { code: "MADE_UP", message: "Invalid date." } })
    ).toBe(false);
    expect(isIpcWireResult(null)).toBe(false);
    expect(isIpcWireResult({ value: 1 })).toBe(false);
    expect(isIpcWireResult({ ok: false })).toBe(false);
    expect(isIpcWireResult({ ok: false, error: null })).toBe(false);
    expect(isIpcWireResult({ ok: false, error: { code: "VALIDATION_ERROR", message: 42 } })).toBe(
      false
    );
  });
});
