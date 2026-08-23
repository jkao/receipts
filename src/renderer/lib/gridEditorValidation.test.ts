import { describe, expect, it } from "vitest";
import {
  validateDateEditorInput,
  validateHoursEditorInput,
  validateMoneyEditorInput,
} from "./gridEditorValidation";

describe("grid editor validation", () => {
  it("accepts blank and real ISO dates while rejecting partial or impossible dates", () => {
    expect(validateDateEditorInput("")).toEqual({ error: null, value: null });
    expect(validateDateEditorInput("2026-08-23")).toEqual({
      error: null,
      value: "2026-08-23",
    });
    expect(validateDateEditorInput("2026-8-23").error).toContain("YYYY-MM-DD");
    expect(validateDateEditorInput("2026-02-30").error).toContain("valid calendar date");
    expect(validateDateEditorInput("0000-01-01").error).toContain("valid calendar date");
  });

  it("accepts blank and cent-precise money values without confusing zero for invalid input", () => {
    expect(validateMoneyEditorInput("", "Rate")).toEqual({ error: null, value: null });
    expect(validateMoneyEditorInput("0", "Rate")).toEqual({ error: null, value: 0 });
    expect(validateMoneyEditorInput("1,234.50", "Rate")).toEqual({
      error: null,
      value: 123_450,
    });
  });

  it("rejects malformed, over-precise, negative, and unsafe money values", () => {
    expect(validateMoneyEditorInput("12.345", "Rate").error).toContain("two decimal places");
    expect(validateMoneyEditorInput("not money", "Rate").error).toContain("dollar amount");
    expect(validateMoneyEditorInput("-1.00", "Rate").error).toBe("Rate cannot be negative.");
    expect(validateMoneyEditorInput("999999999999999999999999", "Rate").error).toContain(
      "dollar amount"
    );
  });

  it("accepts blank and plain decimal hours while rejecting ambiguous raw input", () => {
    expect(validateHoursEditorInput("")).toEqual({ error: null, value: "" });
    expect(validateHoursEditorInput("1.5")).toEqual({ error: null, value: "1.5" });
    expect(validateHoursEditorInput("1e2").error).toContain("plain decimal number");
    expect(validateHoursEditorInput("two").error).toContain("plain decimal number");
    expect(validateHoursEditorInput("-0.25").error).toBe("Hours worked cannot be negative.");
  });
});
