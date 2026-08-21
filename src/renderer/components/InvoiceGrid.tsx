import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  DataGrid,
  Row,
  SelectColumn,
  type Column,
  type DataGridHandle,
  type RenderEditCellProps,
  type Renderers,
  type SortColumn,
} from "react-data-grid";
import type { InvoiceCheckIssue, InvoiceRow, ReceiptRecord } from "../../shared/types";
import { invoiceCheckIssueTitle } from "../lib/invoiceCheck";
import { buildInvoiceSummaryRows, type InvoiceSummaryRow } from "../lib/invoiceSummary";
import {
  calculateTotals,
  formatHours,
  formatMoney,
  formatShortDate,
  labourMinor,
  minorToInput,
  parseMoneyInput,
} from "../lib/format";

const EMPTY_CHECK_ISSUES = new Map<string, readonly InvoiceCheckIssue[]>();
const rowKeyGetter = (row: InvoiceRow) => row.id;

interface InvoiceGridProps {
  rows: InvoiceRow[];
  receipts: ReceiptRecord[];
  disabled?: boolean;
  selectedRows: ReadonlySet<string>;
  activeRowId: string | null;
  focusRowId?: string | null;
  checkIssuesByRow?: ReadonlyMap<string, readonly InvoiceCheckIssue[]>;
  sortColumns: readonly SortColumn[];
  onRowsChange: (rows: InvoiceRow[]) => void;
  onSortColumnsChange: (sortColumns: SortColumn[]) => void;
  onSelectedRowsChange: (rows: Set<string>) => void;
  onOpenRow: (rowId: string) => void;
  onFocusRowHandled?: () => void;
  onDeleteSelected: () => void;
}

function stopGridKeys(event: KeyboardEvent<HTMLInputElement>) {
  if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
    event.stopPropagation();
  }
}

function DateEditor({
  row,
  onRowChange,
  onClose,
}: RenderEditCellProps<InvoiceRow, InvoiceSummaryRow>) {
  return (
    <input
      // biome-ignore lint/a11y/noAutofocus: A grid editor is opened programmatically and must immediately receive cell-editing focus.
      autoFocus
      aria-label="Receipt date"
      className="grid-editor"
      max="9999-12-31"
      type="date"
      value={row.date ?? ""}
      onChange={(event) => onRowChange({ ...row, date: event.target.value || null })}
      onBlur={() => onClose(true)}
      onKeyDown={(event) => {
        stopGridKeys(event);
        if (event.key === "Enter") onClose(true);
        if (event.key === "Escape") onClose(false);
      }}
    />
  );
}

interface MoneyEditorProps extends RenderEditCellProps<InvoiceRow, InvoiceSummaryRow> {
  field: "groceriesMinor" | "rateMinor";
  label: string;
}

function MoneyEditor({ row, onRowChange, onClose, field, label }: MoneyEditorProps) {
  const [value, setValue] = useState(minorToInput(row[field]));

  return (
    <div className="money-editor">
      <span aria-hidden="true">$</span>
      <input
        // biome-ignore lint/a11y/noAutofocus: A grid editor is opened programmatically and must immediately receive cell-editing focus.
        autoFocus
        aria-label={label}
        inputMode="decimal"
        min="0"
        step="0.01"
        type="number"
        value={value}
        onChange={(event) => {
          const nextValue = event.target.value;
          setValue(nextValue);
          onRowChange({ ...row, [field]: parseMoneyInput(nextValue) });
        }}
        onBlur={() => onClose(true)}
        onKeyDown={(event) => {
          stopGridKeys(event);
          if (event.key === "Enter") onClose(true);
          if (event.key === "Escape") onClose(false);
        }}
      />
    </div>
  );
}

function HoursEditor({
  row,
  onRowChange,
  onClose,
}: RenderEditCellProps<InvoiceRow, InvoiceSummaryRow>) {
  return (
    <input
      // biome-ignore lint/a11y/noAutofocus: A grid editor is opened programmatically and must immediately receive cell-editing focus.
      autoFocus
      aria-label="Hours worked"
      className="grid-editor grid-editor--number"
      inputMode="decimal"
      min="0"
      step="0.25"
      type="number"
      value={row.hours}
      onChange={(event) => onRowChange({ ...row, hours: event.target.value })}
      onBlur={() => onClose(true)}
      onKeyDown={(event) => {
        stopGridKeys(event);
        if (event.key === "Enter") onClose(true);
        if (event.key === "Escape") onClose(false);
      }}
    />
  );
}

function CommentEditor({
  row,
  onRowChange,
  onClose,
}: RenderEditCellProps<InvoiceRow, InvoiceSummaryRow>) {
  return (
    <input
      // biome-ignore lint/a11y/noAutofocus: A grid editor is opened programmatically and must immediately receive cell-editing focus.
      autoFocus
      aria-label="Comment"
      className="grid-editor"
      value={row.comment}
      onChange={(event) => onRowChange({ ...row, comment: event.target.value })}
      onBlur={() => onClose(true)}
      onKeyDown={(event) => {
        stopGridKeys(event);
        if (event.key === "Enter") onClose(true);
        if (event.key === "Escape") onClose(false);
      }}
    />
  );
}

export function InvoiceGrid({
  rows,
  receipts,
  disabled = false,
  selectedRows,
  activeRowId,
  focusRowId = null,
  checkIssuesByRow = EMPTY_CHECK_ISSUES,
  sortColumns,
  onRowsChange,
  onSortColumnsChange,
  onSelectedRowsChange,
  onOpenRow,
  onFocusRowHandled,
  onDeleteSelected,
}: InvoiceGridProps) {
  const gridRef = useRef<DataGridHandle>(null);
  const pendingEditedCellRef = useRef<{ rowId: string; columnIdx: number } | null>(null);
  const receiptById = useMemo(
    () => new Map(receipts.map((receipt) => [receipt.id, receipt])),
    [receipts]
  );
  const totals = useMemo(() => calculateTotals(rows), [rows]);
  const summaryRows = useMemo<InvoiceSummaryRow[]>(() => buildInvoiceSummaryRows(totals), [totals]);
  const rowRenderers = useMemo<Renderers<InvoiceRow, InvoiceSummaryRow>>(
    () => ({
      renderRow(key, props) {
        const warningTitle = invoiceCheckIssueTitle(checkIssuesByRow.get(props.row.id) ?? []);
        return <Row key={key} {...props} title={warningTitle} />;
      },
    }),
    [checkIssuesByRow]
  );

  useEffect(() => {
    if (!focusRowId || disabled) return;
    const rowIdx = rows.findIndex((row) => row.id === focusRowId);
    if (rowIdx < 0) return;
    gridRef.current?.scrollToCell({ rowIdx, idx: 2 });
    gridRef.current?.setActivePosition(
      { rowIdx, idx: 2 },
      { enableEditor: true, shouldFocus: true }
    );
    onFocusRowHandled?.();
  }, [disabled, focusRowId, onFocusRowHandled, rows]);

  useEffect(() => {
    const pending = pendingEditedCellRef.current;
    if (!pending || disabled) return;
    const rowIdx = rows.findIndex((row) => row.id === pending.rowId);
    pendingEditedCellRef.current = null;
    if (rowIdx < 0) return;
    gridRef.current?.setActivePosition({ rowIdx, idx: pending.columnIdx }, { shouldFocus: true });
  }, [disabled, rows]);

  const columns = useMemo<Column<InvoiceRow, InvoiceSummaryRow>[]>(
    () => [
      { ...SelectColumn, width: 42, frozen: true },
      {
        key: "date",
        name: "Date",
        width: 128,
        minWidth: 112,
        resizable: true,
        sortable: true,
        editable: !disabled,
        renderCell: ({ row }) => formatShortDate(row.date),
        renderEditCell: DateEditor,
        renderSummaryCell: ({ row }) =>
          row.kind === "grand" ? (
            <strong className="grand-total-marker">Grand Total</strong>
          ) : (
            <strong>Totals</strong>
          ),
        summaryCellClass: "summary-label-cell",
      },
      {
        key: "groceriesMinor",
        name: "Groceries MP",
        width: 172,
        minWidth: 145,
        resizable: true,
        sortable: true,
        editable: !disabled,
        cellClass: "money-cell",
        summaryCellClass: "money-cell",
        renderCell: ({ row }) => formatMoney(row.groceriesMinor),
        renderEditCell: (props) => (
          <MoneyEditor {...props} field="groceriesMinor" label="Groceries amount" />
        ),
        renderSummaryCell: ({ row }) =>
          row.kind === "components" ? <strong>{formatMoney(row.groceriesMinor)}</strong> : null,
      },
      {
        key: "hours",
        name: "Hours Worked",
        width: 148,
        minWidth: 130,
        resizable: true,
        sortable: true,
        editable: !disabled,
        cellClass: "number-cell",
        summaryCellClass: "number-cell",
        renderEditCell: HoursEditor,
        renderSummaryCell: ({ row }) =>
          row.kind === "components" ? <strong>{formatHours(row.hours)}</strong> : null,
      },
      {
        key: "rateMinor",
        name: "Rate",
        width: 116,
        minWidth: 96,
        resizable: true,
        sortable: true,
        editable: !disabled,
        cellClass: "money-cell",
        renderCell: ({ row }) => (row.hours.trim() ? formatMoney(row.rateMinor) : ""),
        renderEditCell: (props) => <MoneyEditor {...props} field="rateMinor" label="Hourly rate" />,
      },
      {
        key: "labourTotal",
        name: "Labour Total",
        width: 158,
        minWidth: 140,
        resizable: true,
        sortable: true,
        cellClass: "money-cell computed-cell",
        summaryCellClass: "money-cell",
        renderCell: ({ row }) => formatMoney(labourMinor(row)),
        renderSummaryCell: ({ row }) =>
          row.kind === "grand" ? (
            <strong>
              <span className="sr-only">Grand total </span>
              {formatMoney(row.invoiceMinor)}
            </strong>
          ) : (
            <strong>{formatMoney(row.labourMinor)}</strong>
          ),
      },
      {
        key: "comment",
        name: "Comment",
        width: "1fr",
        minWidth: 220,
        resizable: true,
        sortable: true,
        editable: !disabled,
        renderCell: ({ row }) => {
          const receipt = row.receiptId ? receiptById.get(row.receiptId) : undefined;
          const checkIssues = checkIssuesByRow.get(row.id) ?? [];
          const checkTitle = invoiceCheckIssueTitle(checkIssues);
          return (
            <span className="comment-cell-content">
              <span className="comment-value">{row.comment}</span>
              <span className="comment-cell-actions">
                {checkIssues.length > 0 ? (
                  <span
                    aria-label={`${checkIssues.length} unresolved review ${checkIssues.length === 1 ? "item" : "items"}: ${checkTitle?.replace(/^Review: /, "") ?? "Review this row."}`}
                    className="invoice-check-badge"
                    role="img"
                    title={checkTitle}
                  >
                    <span aria-hidden="true">!</span>
                    {checkIssues.length}
                  </span>
                ) : null}
                {receipt && receipt.status !== "ready" && receipt.status !== "needs-review" ? (
                  <span className={`receipt-state receipt-state--${receipt.status}`}>
                    {receipt.status === "error"
                      ? "Error"
                      : receipt.status === "needs-key"
                        ? "Needs key"
                        : "Scanning"}
                  </span>
                ) : null}
                {receipt ? (
                  <button
                    aria-label={`View receipt ${receipt.originalFilename}`}
                    className="receipt-open-button"
                    title="View receipt"
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      onOpenRow(row.id);
                    }}
                  >
                    ▧
                  </button>
                ) : null}
              </span>
            </span>
          );
        },
        renderEditCell: CommentEditor,
        renderSummaryCell: ({ row }) =>
          row.kind === "grand" ? <strong>Groceries + Labour</strong> : null,
      },
    ],
    [checkIssuesByRow, disabled, onOpenRow, receiptById]
  );

  return (
    <div
      aria-disabled={disabled || undefined}
      className={`invoice-grid-wrap${disabled ? " invoice-grid-wrap--disabled" : ""}`}
    >
      <DataGrid<InvoiceRow, InvoiceSummaryRow, string>
        ref={gridRef}
        aria-label="Invoice rows"
        bottomSummaryRows={summaryRows}
        className="invoice-grid"
        columns={columns}
        defaultColumnOptions={{ resizable: true }}
        headerRowHeight={44}
        rowHeight={44}
        rows={rows}
        sortColumns={sortColumns}
        renderers={rowRenderers}
        rowKeyGetter={rowKeyGetter}
        isRowSelectionDisabled={() => disabled}
        selectedRows={selectedRows}
        summaryRowHeight={46}
        onCellKeyDown={(args, event) => {
          if (
            !disabled &&
            args.mode === "ACTIVE" &&
            (event.key === "Backspace" || event.key === "Delete") &&
            selectedRows.size > 0
          ) {
            event.preventGridDefault();
            onDeleteSelected();
          }
        }}
        onRowsChange={(nextRows, data) => {
          if (!disabled) {
            const editedRow = nextRows[data.indexes[0] ?? -1];
            if (editedRow) {
              pendingEditedCellRef.current = {
                rowId: editedRow.id,
                columnIdx: data.column.idx,
              };
            }
            onRowsChange(nextRows);
          }
        }}
        onSortColumnsChange={(nextSortColumns) => {
          if (!disabled) onSortColumnsChange(nextSortColumns);
        }}
        onSelectedRowsChange={(nextRows) => {
          if (!disabled) onSelectedRowsChange(nextRows);
        }}
        rowClass={(row) => {
          const receipt = row.receiptId ? receiptById.get(row.receiptId) : undefined;
          return [
            row.id === activeRowId ? "rdg-row--active-detail" : "",
            receipt?.status === "error" ? "rdg-row--attention" : "",
            checkIssuesByRow.has(row.id) ? "rdg-row--check-warning" : "",
          ]
            .filter(Boolean)
            .join(" ");
        }}
      />
    </div>
  );
}
