import { normalizeHours } from "../../shared/finance";
import { parseMoneyInput } from "./format";

export interface GridEditorValidation<T> {
  error: string | null;
  value: T;
}

export function validateDateEditorInput(rawValue: string): GridEditorValidation<string | null> {
  const value = rawValue.trim();
  if (value === "") return { error: null, value: null };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return { error: "Receipt date must use YYYY-MM-DD.", value: null };
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (
    Number.isNaN(parsed.valueOf()) ||
    parsed.toISOString().slice(0, 10) !== value ||
    value < "0001-01-01" ||
    value > "9999-12-31"
  ) {
    return { error: "Receipt date must be a valid calendar date.", value: null };
  }
  return { error: null, value };
}

export function validateMoneyEditorInput(
  rawValue: string,
  label: string
): GridEditorValidation<number | null> {
  if (rawValue.trim() === "") return { error: null, value: null };

  const value = parseMoneyInput(rawValue);
  if (value === null) {
    return {
      error: `${label} must be a dollar amount with no more than two decimal places.`,
      value: null,
    };
  }
  if (value < 0) {
    return { error: `${label} cannot be negative.`, value };
  }
  return { error: null, value };
}

export function validateHoursEditorInput(rawValue: string): GridEditorValidation<string> {
  if (rawValue.trim() === "") return { error: null, value: "" };

  try {
    const normalized = normalizeHours(rawValue);
    if (normalized.startsWith("-")) {
      return { error: "Hours worked cannot be negative.", value: rawValue };
    }
    return { error: null, value: rawValue };
  } catch {
    return {
      error: "Hours worked must be a plain decimal number, such as 1.5.",
      value: rawValue,
    };
  }
}
