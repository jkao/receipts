import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ImageReceiptPreview } from "./ImageReceiptPreview";

describe("ImageReceiptPreview", () => {
  it("exposes zoom controls and the custom keyboard viewport without a noisy live region", () => {
    const markup = renderToStaticMarkup(
      createElement(ImageReceiptPreview, {
        alt: "Receipt example.png",
        filename: "example.png",
        src: "data:image/png;base64,AA==",
        onError: vi.fn(),
      })
    );

    expect(markup).toContain('role="toolbar"');
    expect(markup).toContain('role="application"');
    expect(markup).toContain('tabindex="0"');
    expect(markup).toContain("zoom 100 percent");
    expect(markup).toContain("Use +/− to");
    expect(markup).not.toContain("aria-live");
  });
});
