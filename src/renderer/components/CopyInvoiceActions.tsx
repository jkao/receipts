interface CopyInvoiceActionsProps {
  disabled: boolean;
  selectedCount: number;
  onCopyAll: () => void;
  onCopySelected: () => void;
}

export function selectedCopyLabel(selectedCount: number): string {
  return `Copy ${selectedCount} Selected`;
}

export function CopyInvoiceActions({
  disabled,
  selectedCount,
  onCopyAll,
  onCopySelected,
}: CopyInvoiceActionsProps) {
  return (
    <fieldset className="copy-invoice-actions" aria-label="Copy invoice rows">
      <button
        className="button button--secondary"
        disabled={disabled}
        title="Copy every invoice row with headings and totals for a spreadsheet"
        type="button"
        onClick={onCopyAll}
      >
        <span aria-hidden="true">⧉</span>
        Copy Full Invoice
      </button>
      {selectedCount > 0 ? (
        <button
          className="button button--secondary"
          disabled={disabled}
          title="Copy only the selected rows, without invoice totals"
          type="button"
          onClick={onCopySelected}
        >
          <span aria-hidden="true">⧉</span>
          {selectedCopyLabel(selectedCount)}
        </button>
      ) : null}
    </fieldset>
  );
}
