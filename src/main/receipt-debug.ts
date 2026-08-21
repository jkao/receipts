import { promises as fs } from "node:fs";

import type {
  ReceiptAdjustment,
  ReceiptDebug,
  ReceiptExtraction,
  ReceiptItem,
  ReceiptUsage,
} from "../shared/types";

/**
 * Debug files are generated from an API response capped at 8,192 output tokens.
 * Two MiB leaves ample headroom for formatted JSON while preventing an edited
 * local file from consuming unbounded memory in the main process.
 */
export const MAX_RECEIPT_DEBUG_BYTES = 2 * 1024 * 1024;

export class ReceiptDebugValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReceiptDebugValidationError";
  }
}

export async function readReceiptDebugFile(
  filename: string,
  expectedReceiptId?: string
): Promise<ReceiptDebug | null> {
  let metadata: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    metadata = await fs.lstat(filename);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return null;
    throw error;
  }

  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error("Receipt scan details must be an ordinary file.");
  }
  if (metadata.size > MAX_RECEIPT_DEBUG_BYTES) {
    throw new ReceiptDebugValidationError(
      `Receipt scan details exceed the ${MAX_RECEIPT_DEBUG_BYTES / (1024 * 1024)} MiB limit.`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(filename, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new ReceiptDebugValidationError(
        `Receipt scan details contain invalid JSON: ${error.message}`
      );
    }
    throw error;
  }

  const debug = validateReceiptDebug(parsed);
  if (expectedReceiptId !== undefined && debug.receiptId !== expectedReceiptId) {
    throw new ReceiptDebugValidationError(
      "Receipt scan details do not belong to the selected receipt."
    );
  }
  return debug;
}

export function validateReceiptDebug(value: unknown): ReceiptDebug {
  const debug = requiredObject(value, "Receipt scan details");
  const provider = requiredString(debug.provider, "Receipt scan provider");
  if (provider !== "openai") {
    throw new ReceiptDebugValidationError("Receipt scan provider must be openai.");
  }

  return {
    receiptId: requiredString(debug.receiptId, "Receipt scan receipt ID"),
    provider,
    model: requiredString(debug.model, "Receipt scan model"),
    scannedAt: canonicalIsoTimestamp(debug.scannedAt, "Receipt scan timestamp"),
    extraction: validateExtraction(debug.extraction),
    validationWarnings: stringArray(debug.validationWarnings, "Receipt scan validation warnings"),
    usage: validateUsage(debug.usage),
  };
}

function validateExtraction(value: unknown): ReceiptExtraction {
  const extraction = requiredObject(value, "Receipt extraction");
  return {
    merchant: nullableString(extraction.merchant, "Receipt merchant"),
    date: nullableString(extraction.date, "Receipt date"),
    currency: nullableString(extraction.currency, "Receipt currency"),
    subtotal: nullableString(extraction.subtotal, "Receipt subtotal"),
    tax: nullableString(extraction.tax, "Receipt tax"),
    tip: nullableString(extraction.tip, "Receipt tip"),
    adjustments: objectArray(extraction.adjustments, "Receipt adjustments", validateAdjustment),
    total: nullableString(extraction.total, "Receipt total"),
    items: objectArray(extraction.items, "Receipt items", validateItem),
  };
}

function validateAdjustment(value: unknown, index: number): ReceiptAdjustment {
  const label = `Receipt adjustment ${index + 1}`;
  const adjustment = requiredObject(value, label);
  return {
    description: nullableString(adjustment.description, `${label} description`),
    amount: nullableString(adjustment.amount, `${label} amount`),
  };
}

function validateItem(value: unknown, index: number): ReceiptItem {
  const label = `Receipt item ${index + 1}`;
  const item = requiredObject(value, label);
  return {
    description: nullableString(item.description, `${label} description`),
    quantity: nullableString(item.quantity, `${label} quantity`),
    unitPrice: nullableString(item.unitPrice, `${label} unit price`),
    lineTotal: nullableString(item.lineTotal, `${label} line total`),
  };
}

function validateUsage(value: unknown): ReceiptUsage {
  const usage = requiredObject(value, "Receipt scan usage");
  return {
    ...optionalTokenCount(usage, "inputTokens"),
    ...optionalTokenCount(usage, "outputTokens"),
    ...optionalTokenCount(usage, "totalTokens"),
  };
}

function optionalTokenCount(
  usage: Record<string, unknown>,
  key: keyof ReceiptUsage
): Partial<ReceiptUsage> {
  const value = usage[key];
  if (value === undefined) return {};
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ReceiptDebugValidationError(
      `Receipt scan usage ${key} must be a non-negative safe integer.`
    );
  }
  return { [key]: value };
}

function objectArray<T>(
  value: unknown,
  label: string,
  validate: (entry: unknown, index: number) => T
): T[] {
  if (!Array.isArray(value)) {
    throw new ReceiptDebugValidationError(`${label} must be an array.`);
  }
  return value.map(validate);
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new ReceiptDebugValidationError(`${label} must be an array of strings.`);
  }
  return [...value];
}

function requiredObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ReceiptDebugValidationError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ReceiptDebugValidationError(`${label} must be a non-empty string.`);
  }
  return value;
}

function nullableString(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new ReceiptDebugValidationError(`${label} must be a string or null.`);
  }
  return value;
}

function canonicalIsoTimestamp(value: unknown, label: string): string {
  const timestamp = requiredString(value, label);
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== timestamp) {
    throw new ReceiptDebugValidationError(`${label} must use canonical ISO-8601 format.`);
  }
  return timestamp;
}

function isErrno(error: unknown, code: string): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === code;
}
