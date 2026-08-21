import type { InvoiceRow, InvoiceTotals } from "./types";

interface ExactDecimal {
  coefficient: bigint;
  scale: number;
}

const DECIMAL_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

function powerOfTen(exponent: number): bigint {
  return 10n ** BigInt(exponent);
}

function parseExactDecimal(value: string, label: string): ExactDecimal {
  const normalized = value.trim();
  if (!DECIMAL_PATTERN.test(normalized)) {
    throw new TypeError(`${label} must be a plain decimal number`);
  }

  const negative = normalized.startsWith("-");
  const unsigned = normalized.replace(/^[+-]/, "");
  const [whole = "0", fraction = ""] = unsigned.split(".");
  const digits = `${whole || "0"}${fraction}`.replace(/^0+(?=\d)/, "");
  const coefficient = BigInt(digits || "0") * (negative ? -1n : 1n);

  return { coefficient, scale: fraction.length };
}

function roundRatioHalfAwayFromZero(numerator: bigint, denominator: bigint): bigint {
  const negative = numerator < 0n;
  const absolute = negative ? -numerator : numerator;
  const quotient = absolute / denominator;
  const remainder = absolute % denominator;
  const rounded = remainder * 2n >= denominator ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}

function toSafeInteger(value: bigint, label: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) {
    throw new RangeError(`${label} exceeds JavaScript's safe integer range`);
  }
  return result;
}

function assertMinorUnits(value: number, label: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`${label} must be a safe integer number of cents`);
  }
}

function formatExactDecimal(decimal: ExactDecimal, minimumFractionDigits = 0): string {
  const negative = decimal.coefficient < 0n;
  let absolute = negative ? -decimal.coefficient : decimal.coefficient;
  let scale = decimal.scale;

  while (scale > minimumFractionDigits && absolute % 10n === 0n) {
    absolute /= 10n;
    scale -= 1;
  }

  if (scale < minimumFractionDigits) {
    absolute *= powerOfTen(minimumFractionDigits - scale);
    scale = minimumFractionDigits;
  }

  const digits = absolute.toString().padStart(scale + 1, "0");
  const whole = scale === 0 ? digits : digits.slice(0, -scale) || "0";
  const fraction = scale === 0 ? "" : `.${digits.slice(-scale)}`;
  const sign = negative && absolute !== 0n ? "-" : "";
  return `${sign}${whole}${fraction}`;
}

/**
 * Parse a provider/UI money string into integer cents without using floating point.
 * Empty strings are treated like missing values. Values with precision beyond cents
 * are accepted only when the extra digits are zero.
 */
export function parseMoneyToMinor(value: string | null): number | null {
  if (value === null || value.trim() === "") {
    return null;
  }

  const parsed = parseExactDecimal(value, "Money value");
  let cents: bigint;
  if (parsed.scale <= 2) {
    cents = parsed.coefficient * powerOfTen(2 - parsed.scale);
  } else {
    const divisor = powerOfTen(parsed.scale - 2);
    if (parsed.coefficient % divisor !== 0n) {
      throw new RangeError("Money value cannot contain fractions of a cent");
    }
    cents = parsed.coefficient / divisor;
  }

  return toSafeInteger(cents, "Money value");
}

export function formatMinorUnits(value: number): string {
  assertMinorUnits(value, "Money value");
  const negative = value < 0;
  const absolute = BigInt(value < 0 ? -value : value);
  const whole = absolute / 100n;
  const fraction = (absolute % 100n).toString().padStart(2, "0");
  return `${negative && absolute !== 0n ? "-" : ""}${whole}.${fraction}`;
}

/** Return a canonical spreadsheet-native hours value, retaining needed precision. */
export function normalizeHours(value: string): string {
  if (value.trim() === "") {
    return "";
  }
  return formatExactDecimal(parseExactDecimal(value, "Hours"), 2);
}

/** Multiply decimal hours by an integer cents/hour rate and round to the nearest cent. */
export function calculateLabourMinor(hours: string, rateMinor: number | null): number {
  if (hours.trim() === "" || rateMinor === null) {
    return 0;
  }
  assertMinorUnits(rateMinor, "Rate");
  const parsed = parseExactDecimal(hours, "Hours");
  const cents = roundRatioHalfAwayFromZero(
    parsed.coefficient * BigInt(rateMinor),
    powerOfTen(parsed.scale)
  );
  return toSafeInteger(cents, "Labour total");
}

export function calculateRowLabourMinor(row: InvoiceRow): number {
  return calculateLabourMinor(row.hours, row.rateMinor);
}

function sumHours(rows: readonly InvoiceRow[]): string {
  const values = rows
    .map((row) => row.hours)
    .filter((hours) => hours.trim() !== "")
    .map((hours) => parseExactDecimal(hours, "Hours"));

  if (values.length === 0) {
    return "0.00";
  }

  let scale = 0;
  for (const value of values) {
    scale = Math.max(scale, value.scale);
  }
  const coefficient = values.reduce(
    (total, value) => total + value.coefficient * powerOfTen(scale - value.scale),
    0n
  );
  return formatExactDecimal({ coefficient, scale }, 2);
}

export function calculateInvoiceTotals(rows: readonly InvoiceRow[]): InvoiceTotals {
  let groceries = 0n;
  let labour = 0n;

  for (const row of rows) {
    if (row.groceriesMinor !== null) {
      assertMinorUnits(row.groceriesMinor, "Groceries amount");
      groceries += BigInt(row.groceriesMinor);
    }
    labour += BigInt(calculateRowLabourMinor(row));
  }

  const invoice = groceries + labour;
  return {
    groceriesMinor: toSafeInteger(groceries, "Groceries total"),
    hours: sumHours(rows),
    labourMinor: toSafeInteger(labour, "Labour total"),
    invoiceMinor: toSafeInteger(invoice, "Invoice total"),
  };
}
