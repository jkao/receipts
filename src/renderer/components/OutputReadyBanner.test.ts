import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { OutputReadyBanner } from "./OutputReadyBanner";

describe("OutputReadyBanner", () => {
  it("announces unique output semantics without putting buttons in the live region", () => {
    const markup = renderToStaticMarkup(
      createElement(OutputReadyBanner, {
        disabled: false,
        revealing: false,
        result: { outputPath: "/invoices/example/output", receiptCount: 3 },
        onDismiss: vi.fn(),
        onReveal: vi.fn(),
      })
    );

    expect(markup).not.toMatch(/<section[^>]*role="status"/);
    expect(markup).toContain('<p role="status">');
    expect(markup).toContain(
      "Built the invoice PDF and 3 unique receipt files. Any previous output was replaced."
    );
    expect(markup).toContain("Show in Finder");
    expect(markup).toContain('value="/invoices/example/output"');
  });
});
