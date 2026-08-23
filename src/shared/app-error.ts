export type AppErrorCode =
  | "REVISION_CONFLICT"
  | "INVOICE_DELETED"
  | "INVOICE_NOT_FOUND"
  | "VALIDATION_ERROR"
  | "UNKNOWN_ERROR";

export interface AppErrorPayload {
  code: AppErrorCode;
  message: string;
}

export type IpcWireResult<Value> =
  | { ok: true; value: Value }
  | { ok: false; error: AppErrorPayload };

const ERROR_MARKER = "[receipt-invoice-error:";

export class ReceiptInvoiceError extends Error {
  constructor(
    readonly code: AppErrorCode,
    message: string
  ) {
    super(`${ERROR_MARKER}${code}] ${message}`);
    this.name = "ReceiptInvoiceError";
  }
}

export function appErrorPayload(error: unknown): AppErrorPayload {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : "Unexpected application error.";
  const code: AppErrorCode =
    name === "RevisionConflictError"
      ? "REVISION_CONFLICT"
      : name === "InvoiceDeletedError"
        ? "INVOICE_DELETED"
        : name === "InvoiceNotFoundError"
          ? "INVOICE_NOT_FOUND"
          : name === "InvoiceValidationError" ||
              error instanceof TypeError ||
              error instanceof RangeError
            ? "VALIDATION_ERROR"
            : "UNKNOWN_ERROR";
  return { code, message };
}

export function isIpcWireResult(value: unknown): value is IpcWireResult<unknown> {
  if (!value || typeof value !== "object" || !("ok" in value)) return false;
  if (value.ok === true) return "value" in value;
  if (value.ok !== false || !("error" in value)) return false;
  const error = value.error;
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    isAppErrorCode(error.code) &&
    "message" in error &&
    typeof error.message === "string"
  );
}

export function appErrorCode(error: unknown): AppErrorCode | null {
  if (error instanceof ReceiptInvoiceError) return error.code;
  if (error && typeof error === "object" && "code" in error) {
    const code = error.code;
    if (isAppErrorCode(code)) return code;
  }
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const match = message.match(/^\[receipt-invoice-error:([A-Z_]+)\]\s*/);
  return match && isAppErrorCode(match[1]) ? match[1] : null;
}

export function appErrorMessage(error: unknown, fallback = "Something went wrong."): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return message.replace(/^\[receipt-invoice-error:[A-Z_]+\]\s*/, "") || fallback;
}

function isAppErrorCode(value: unknown): value is AppErrorCode {
  return (
    value === "REVISION_CONFLICT" ||
    value === "INVOICE_DELETED" ||
    value === "INVOICE_NOT_FOUND" ||
    value === "VALIDATION_ERROR" ||
    value === "UNKNOWN_ERROR"
  );
}
