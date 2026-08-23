import { describe, expect, it } from "vitest";
import {
  clearImportRefresh,
  retainImportRefreshForInvoice,
  shouldQueueImportRefresh,
} from "./importRefreshState";

describe("background import refresh state", () => {
  it("drops a completion for the old invoice when navigation adopts another invoice", () => {
    let pending: ReadonlySet<string> = clearImportRefresh(new Set(["invoice-old"]), "invoice-old");

    // The old job completes after navigation starts but before adoption.
    pending = new Set(pending).add("invoice-old");
    pending = retainImportRefreshForInvoice(pending, "invoice-new");

    expect([...pending]).toEqual([]);
  });

  it("keeps a completion for the invoice currently being opened", () => {
    expect(shouldQueueImportRefresh("invoice-old", "invoice-new", "invoice-new")).toBe(true);
    expect([...retainImportRefreshForInvoice(new Set(["invoice-new"]), "invoice-new")]).toEqual([
      "invoice-new",
    ]);
  });

  it("does not queue unrelated background completions", () => {
    expect(shouldQueueImportRefresh("invoice-a", null, "invoice-b")).toBe(false);
  });
});
