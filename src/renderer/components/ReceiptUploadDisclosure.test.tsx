import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  RECEIPT_UPLOAD_DISCLOSURE,
  ReceiptUploadDisclosure,
  receiptUploadConfirmationMessage,
} from "./ReceiptUploadDisclosure";

describe("ReceiptUploadDisclosure", () => {
  it("explicitly identifies which files leave the Mac and why", () => {
    const markup = renderToStaticMarkup(createElement(ReceiptUploadDisclosure));

    expect(RECEIPT_UPLOAD_DISCLOSURE).toContain("receipt image or PDF");
    expect(RECEIPT_UPLOAD_DISCLOSURE).toContain("OpenAI");
    expect(RECEIPT_UPLOAD_DISCLOSURE).toContain("extraction");
    expect(RECEIPT_UPLOAD_DISCLOSURE).toContain("Manual invoice rows are not uploaded");
    expect(markup).toContain("OpenAI receipt upload");
  });

  it("uses the same disclosure immediately before scan confirmation", () => {
    const message = receiptUploadConfirmationMessage();
    expect(message).toContain(RECEIPT_UPLOAD_DISCLOSURE);
    expect(message).toContain("Continue with this scan?");
  });
});
