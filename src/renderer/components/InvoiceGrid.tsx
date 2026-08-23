import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
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
import type {
  InvoiceCheckIssue,
  InvoiceRow,
  InvoiceTotals,
  ReceiptRecord,
} from "../../shared/types";
import { normalizeHours } from "../../shared/finance";
import { invoiceCheckIssueTitle } from "../lib/invoiceCheck";
import { buildInvoiceSummaryRows, type InvoiceSummaryRow } from "../lib/invoiceSummary";
import {
  validateDateEditorInput,
  validateHoursEditorInput,
  validateMoneyEditorInput,
} from "../lib/gridEditorValidation";
import {
  formatHours,
  formatMoney,
  formatShortDate,
  labourMinor,
  minorToInput,
} from "../lib/format";

const EMPTY_CHECK_ISSUES = new Map<string, readonly InvoiceCheckIssue[]>();
const rowKeyGetter = (row: InvoiceRow) => row.id;

interface InvoiceGridProps {
  rows: InvoiceRow[];
  receipts: ReceiptRecord[];
  totals: InvoiceTotals;
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

function keepInvalidEditorOpen(input: HTMLInputElement): void {
  input.reportValidity();
  window.setTimeout(() => {
    if (input.isConnected) input.focus({ preventScroll: true });
  });
}

export function DateEditor({
  row,
  onRowChange,
  onClose,
}: RenderEditCellProps<InvoiceRow, InvoiceSummaryRow>) {
  const [value, setValue] = useState(row.date ?? "");
  const [nativeError, setNativeError] = useState<string | null>(null);
  const errorId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const committedRef = useRef(false);
  const validation = validateDateEditorInput(value);
  const error = validation.error ?? nativeError;

  useEffect(() => {
    inputRef.current?.setCustomValidity(error ?? "");
  }, [error]);

  const commit = () => {
    const input = inputRef.current;
    const browserError = input && !input.validity.valid ? "Enter a complete, valid date." : null;
    if (validation.error || browserError) {
      setNativeError(browserError);
      return false;
    }
    if (!committedRef.current) {
      committedRef.current = true;
      if (validation.value === row.date) onClose(false);
      else onRowChange({ ...row, date: validation.value }, true);
    }
    return true;
  };

  return (
    <div
      className={`grid-editor-container${error ? " grid-editor-container--invalid" : ""}`}
      title={error ?? undefined}
    >
      <input
        ref={inputRef}
        // biome-ignore lint/a11y/noAutofocus: A grid editor is opened programmatically and must immediately receive cell-editing focus.
        autoFocus
        aria-describedby={error ? errorId : undefined}
        aria-errormessage={error ? errorId : undefined}
        aria-invalid={error ? "true" : undefined}
        aria-label="Receipt date"
        className="grid-editor"
        max="9999-12-31"
        min="0001-01-01"
        type="date"
        value={value}
        onChange={(event) => {
          setNativeError(null);
          setValue(event.target.value);
        }}
        onBlur={(event) => {
          if (!commit()) keepInvalidEditorOpen(event.currentTarget);
        }}
        onKeyDown={(event) => {
          stopGridKeys(event);
          if (event.key === "Enter" || event.key === "Tab") {
            if (event.key === "Enter") event.preventDefault();
            if (!commit()) {
              event.preventDefault();
              event.stopPropagation();
              keepInvalidEditorOpen(event.currentTarget);
            }
          }
          if (event.key === "Escape") onClose(false);
        }}
      />
      {error ? (
        <span className="sr-only" id={errorId} role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}

interface MoneyEditorProps extends RenderEditCellProps<InvoiceRow, InvoiceSummaryRow> {
  field: "groceriesMinor" | "rateMinor";
  label: string;
}

export function MoneyEditor({ row, onRowChange, onClose, field, label }: MoneyEditorProps) {
  const [value, setValue] = useState(minorToInput(row[field]));
  const errorId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const committedRef = useRef(false);
  const validation = validateMoneyEditorInput(value, label);

  useEffect(() => {
    inputRef.current?.setCustomValidity(validation.error ?? "");
  }, [validation.error]);

  const commit = () => {
    if (validation.error) return false;
    if (!committedRef.current) {
      committedRef.current = true;
      if (validation.value === row[field]) onClose(false);
      else onRowChange({ ...row, [field]: validation.value }, true);
    }
    return true;
  };

  return (
    <div
      className={`money-editor${validation.error ? " grid-editor-container--invalid" : ""}`}
      title={validation.error ?? undefined}
    >
      <span aria-hidden="true">$</span>
      <input
        ref={inputRef}
        // biome-ignore lint/a11y/noAutofocus: A grid editor is opened programmatically and must immediately receive cell-editing focus.
        autoFocus
        aria-describedby={validation.error ? errorId : undefined}
        aria-errormessage={validation.error ? errorId : undefined}
        aria-invalid={validation.error ? "true" : undefined}
        aria-label={label}
        inputMode="decimal"
        type="text"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onBlur={(event) => {
          if (!commit()) {
            keepInvalidEditorOpen(event.currentTarget);
            return;
          }
        }}
        onKeyDown={(event) => {
          stopGridKeys(event);
          if (event.key === "Enter" || event.key === "Tab") {
            if (event.key === "Enter") event.preventDefault();
            if (!commit()) {
              event.preventDefault();
              event.stopPropagation();
              keepInvalidEditorOpen(event.currentTarget);
            }
          }
          if (event.key === "Escape") onClose(false);
        }}
      />
      {validation.error ? (
        <span className="sr-only" id={errorId} role="alert">
          {validation.error}
        </span>
      ) : null}
    </div>
  );
}

export function HoursEditor({
  row,
  onRowChange,
  onClose,
}: RenderEditCellProps<InvoiceRow, InvoiceSummaryRow>) {
  const [value, setValue] = useState(row.hours);
  const errorId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const committedRef = useRef(false);
  const validation = validateHoursEditorInput(value);

  useEffect(() => {
    inputRef.current?.setCustomValidity(validation.error ?? "");
  }, [validation.error]);

  const commit = () => {
    if (validation.error) return false;
    if (!committedRef.current) {
      committedRef.current = true;
      const currentValue = normalizeHours(row.hours);
      const nextValue = normalizeHours(validation.value);
      if (currentValue === nextValue) onClose(false);
      else onRowChange({ ...row, hours: validation.value }, true);
    }
    return true;
  };

  return (
    <div
      className={`grid-editor-container${validation.error ? " grid-editor-container--invalid" : ""}`}
      title={validation.error ?? undefined}
    >
      <input
        ref={inputRef}
        // biome-ignore lint/a11y/noAutofocus: A grid editor is opened programmatically and must immediately receive cell-editing focus.
        autoFocus
        aria-describedby={validation.error ? errorId : undefined}
        aria-errormessage={validation.error ? errorId : undefined}
        aria-invalid={validation.error ? "true" : undefined}
        aria-label="Hours worked"
        className="grid-editor grid-editor--number"
        inputMode="decimal"
        type="text"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onBlur={(event) => {
          if (!commit()) {
            keepInvalidEditorOpen(event.currentTarget);
            return;
          }
        }}
        onKeyDown={(event) => {
          stopGridKeys(event);
          if (event.key === "Enter" || event.key === "Tab") {
            if (event.key === "Enter") event.preventDefault();
            if (!commit()) {
              event.preventDefault();
              event.stopPropagation();
              keepInvalidEditorOpen(event.currentTarget);
            }
          }
          if (event.key === "Escape") onClose(false);
        }}
      />
      {validation.error ? (
        <span className="sr-only" id={errorId} role="alert">
          {validation.error}
        </span>
      ) : null}
    </div>
  );
}

export function CommentEditor({
  row,
  onRowChange,
  onClose,
}: RenderEditCellProps<InvoiceRow, InvoiceSummaryRow>) {
  const [value, setValue] = useState(row.comment);
  const committedRef = useRef(false);

  const commit = () => {
    if (!committedRef.current) {
      committedRef.current = true;
      if (value === row.comment) onClose(false);
      else onRowChange({ ...row, comment: value }, true);
    }
  };

  return (
    <input
      // biome-ignore lint/a11y/noAutofocus: A grid editor is opened programmatically and must immediately receive cell-editing focus.
      autoFocus
      aria-label="Comment"
      className="grid-editor"
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => {
        commit();
      }}
      onKeyDown={(event) => {
        stopGridKeys(event);
        if (event.key === "Enter" || event.key === "Tab") {
          if (event.key === "Enter") event.preventDefault();
          commit();
        }
        if (event.key === "Escape") onClose(false);
      }}
    />
  );
}

export function InvoiceGrid({
  rows,
  receipts,
  totals,
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
        editorOptions: { commitOnOutsideClick: false },
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
        editorOptions: { commitOnOutsideClick: false },
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
        editorOptions: { commitOnOutsideClick: false },
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
        editorOptions: { commitOnOutsideClick: false },
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
        editorOptions: { commitOnOutsideClick: false },
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
                    title={`Open receipt details for ${receipt.originalFilename}`}
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      onOpenRow(row.id);
                    }}
                  >
                    <span aria-hidden="true">▧</span>
                    <span>Receipt</span>
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
