export const RECEIPT_UPLOAD_DISCLOSURE =
  "Automatic scanning sends each receipt image or PDF to OpenAI for extraction. Manual invoice rows are not uploaded.";

export function receiptUploadConfirmationMessage(): string {
  return `Scan receipt files with OpenAI?\n\n${RECEIPT_UPLOAD_DISCLOSURE}\n\nContinue with this scan?`;
}

export function ReceiptUploadDisclosure({ compact = false }: { compact?: boolean }) {
  return (
    <p
      className={`receipt-upload-disclosure${compact ? " receipt-upload-disclosure--compact" : ""}`}
    >
      <strong>OpenAI receipt upload.</strong> {RECEIPT_UPLOAD_DISCLOSURE}
    </p>
  );
}
