import type { ReceiptPreview } from "../../shared/types";

export type ReceiptPreviewKind = "image" | "pdf" | "unsupported";

export function receiptPreviewKind(preview: ReceiptPreview): ReceiptPreviewKind {
  const mimeType = preview.mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (mimeType === "application/pdf") return "pdf";
  if (mimeType.startsWith("image/")) return "image";
  return "unsupported";
}
