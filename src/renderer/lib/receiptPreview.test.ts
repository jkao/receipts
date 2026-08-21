import { describe, expect, it } from "vitest";
import type { ReceiptPreview } from "../../shared/types";
import { receiptPreviewKind } from "./receiptPreview";

function preview(mimeType: string): ReceiptPreview {
  return {
    filename: "receipt",
    mimeType,
    dataUrl: "data:application/octet-stream;base64,AA==",
    managedPath: "/managed/receipt",
  };
}

describe("receipt preview routing", () => {
  it.each(["image/jpeg", "IMAGE/PNG", "image/webp; charset=binary", "image/heic"])(
    "routes %s through the interactive image preview",
    (mimeType) => {
      expect(receiptPreviewKind(preview(mimeType))).toBe("image");
    }
  );

  it("keeps PDFs in the native object viewer", () => {
    expect(receiptPreviewKind(preview("Application/PDF; charset=binary"))).toBe("pdf");
  });

  it("does not send unknown data through an image element", () => {
    expect(receiptPreviewKind(preview("application/octet-stream"))).toBe("unsupported");
  });
});
