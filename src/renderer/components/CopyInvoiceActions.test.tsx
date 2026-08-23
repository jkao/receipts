import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CopyInvoiceActions, selectedCopyLabel } from "./CopyInvoiceActions";

describe("CopyInvoiceActions", () => {
  it("always identifies the full-invoice action and hides the selected action without a selection", () => {
    const markup = renderToStaticMarkup(
      createElement(CopyInvoiceActions, {
        disabled: false,
        selectedCount: 0,
        onCopyAll: vi.fn(),
        onCopySelected: vi.fn(),
      })
    );

    expect(markup).toContain("Copy Full Invoice");
    expect(markup).not.toContain("Selected");
    expect(markup).toContain("every invoice row with headings and totals");
  });

  it("labels selected-row copying with the exact selection count and scope", () => {
    const markup = renderToStaticMarkup(
      createElement(CopyInvoiceActions, {
        disabled: false,
        selectedCount: 3,
        onCopyAll: vi.fn(),
        onCopySelected: vi.fn(),
      })
    );

    expect(selectedCopyLabel(3)).toBe("Copy 3 Selected");
    expect(markup).toContain("Copy Full Invoice");
    expect(markup).toContain("Copy 3 Selected");
    expect(markup).toContain("only the selected rows, without invoice totals");
  });
});
