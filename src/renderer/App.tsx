import {
  type DragEvent,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { SortColumn } from "react-data-grid";
import { appErrorCode } from "../shared/app-error";
import { consolidateInvoiceRows } from "../shared/invoice-row-consolidation";
import type {
  ImportFilesOptions,
  ImportProgress,
  InvoiceCheckResult,
  InvoiceDocument,
  InvoiceOutputResult,
  InvoicePeriod,
  InvoiceRow,
  InvoiceSummary,
  SettingsView,
} from "../shared/types";
import { CopyInvoiceActions } from "./components/CopyInvoiceActions";
import { ImportProgressPanel } from "./components/ImportProgressPanel";
import { InvoiceCheckSummary } from "./components/InvoiceCheckSummary";
import { InvoiceGrid } from "./components/InvoiceGrid";
import {
  EditInvoicePeriodModal,
  ExportModal,
  invoiceRemovalNotification,
  NewInvoiceModal,
  RemoveInvoiceModal,
  SettingsModal,
} from "./components/InvoiceModals";
import { Onboarding } from "./components/Onboarding";
import { OutputReadyBanner } from "./components/OutputReadyBanner";
import { ReceiptDrawer } from "./components/ReceiptDrawer";
import { ReceiptGallery } from "./components/ReceiptGallery";
import { receiptUploadConfirmationMessage } from "./components/ReceiptUploadDisclosure";
import { SaveIndicator } from "./components/SaveIndicator";
import { Sidebar } from "./components/Sidebar";
import {
  type ToastAction,
  type ToastMessage,
  ToastRegion,
  type ToastTone,
} from "./components/ToastRegion";
import { useImportJobs } from "./hooks/useImportJobs";
import { type SaveStatus, useInvoiceAutosave } from "./hooks/useInvoiceAutosave";
import { commitActiveGridEditor } from "./lib/activeGridEditor";
import {
  calculateTotals,
  formatMoney,
  formatPeriod,
  invoiceToSummary,
  messageFromError,
  newRowId,
  todayIso,
} from "./lib/format";
import {
  clearImportRefresh,
  retainImportRefreshForInvoice,
  shouldQueueImportRefresh,
} from "./lib/importRefreshState";
import {
  hasInvoiceCheckAttention,
  indexInvoiceCheckIssuesByRow,
  isReviewIssue,
} from "./lib/invoiceCheck";
import {
  DEFAULT_INVOICE_SORT,
  normalizeInvoiceSort,
  rowsHaveSameOrder,
  rowsNeedResort,
  sortInvoiceRows,
} from "./lib/invoiceSort";
import { startReceiptImportWorkflow } from "./lib/receiptImportWorkflow";
import { scheduleIdleTask } from "./lib/scheduleIdleTask";

export {
  EditInvoicePeriodModal,
  ExportModal,
  invoiceRemovalNotification,
  RemoveInvoiceModal,
  removeInvoiceButtonLabel,
  SettingsModal,
} from "./components/InvoiceModals";
export { Onboarding } from "./components/Onboarding";

interface InvoiceAdoptionOptions {
  checkResult?: InvoiceCheckResult;
  persistSort?: boolean;
  preserveBuiltOutput?: boolean;
  preserveSelection?: boolean;
}

interface InvoiceCheckRefreshOptions {
  force?: boolean;
  reportErrors?: boolean;
}

type BusyAction =
  | "build-output"
  | "check"
  | "copy"
  | "create"
  | "delete"
  | "edit-period"
  | "export"
  | "folder"
  | "import"
  | "load"
  | "remove-invoice"
  | "retry"
  | "reveal-output"
  | "review"
  | "undo";

type WorkspaceViewMode = "table" | "gallery";

function defaultManualRowDate(invoice: InvoiceDocument): string {
  const today = todayIso();
  return today >= invoice.period.startDate && today <= invoice.period.endDate
    ? today
    : invoice.period.endDate;
}

function isDefaultManualRow(row: InvoiceRow, invoice: InvoiceDocument): boolean {
  return (
    row.receiptId === null &&
    row.date === defaultManualRowDate(invoice) &&
    row.groceriesMinor === null &&
    row.hours.trim() === "" &&
    row.rateMinor === invoice.defaultRateMinor &&
    row.comment.trim() === ""
  );
}

export default function App() {
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [invoices, setInvoices] = useState<InvoiceSummary[]>([]);
  const [invoice, setInvoice] = useState<InvoiceDocument | null>(null);
  const [rows, setRows] = useState<InvoiceRow[]>([]);
  const [sortColumns, setSortColumns] = useState<SortColumn[]>(() =>
    normalizeInvoiceSort(DEFAULT_INVOICE_SORT)
  );
  const [selectedRows, setSelectedRows] = useState<ReadonlySet<string>>(new Set());
  const [workspaceViewMode, setWorkspaceViewMode] = useState<WorkspaceViewMode>("table");
  const [detailRowId, setDetailRowId] = useState<string | null>(null);
  const [focusRowId, setFocusRowId] = useState<string | null>(null);
  const [booting, setBooting] = useState(true);
  const [bootError, setBootError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<BusyAction | null>(null);
  const [newInvoiceOpen, setNewInvoiceOpen] = useState(false);
  const [editInvoicePeriodOpen, setEditInvoicePeriodOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [removeInvoiceOpen, setRemoveInvoiceOpen] = useState(false);
  const [removeInvoiceError, setRemoveInvoiceError] = useState<string | null>(null);
  const [removeInvoiceConflict, setRemoveInvoiceConflict] = useState(false);
  const [importProgress, setImportProgress] = useState<ImportProgress | null>(null);
  const [pendingImportRefreshes, setPendingImportRefreshes] = useState<ReadonlySet<string>>(
    new Set()
  );
  const [receiptResourceGenerations, setReceiptResourceGenerations] = useState<
    ReadonlyMap<string, number>
  >(new Map());
  const [invoiceCheckResult, setInvoiceCheckResult] = useState<InvoiceCheckResult | null>(null);
  const [checkSummaryVisible, setCheckSummaryVisible] = useState(true);
  const [updatingReviewFingerprints, setUpdatingReviewFingerprints] = useState<ReadonlySet<string>>(
    new Set()
  );
  const [builtOutput, setBuiltOutput] = useState<{
    invoiceId: string;
    result: InvoiceOutputResult;
  } | null>(null);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const dragDepthRef = useRef(0);
  const receiptUploadAcknowledgedRef = useRef(false);
  const allowCloseRef = useRef(false);
  const closeSaveInFlightRef = useRef(false);
  const saveStatusRef = useRef<SaveStatus>("saved");
  const busyActionRef = useRef<BusyAction | null>(busyAction);
  const currentInvoiceRef = useRef<InvoiceDocument | null>(null);
  const rowsRef = useRef(rows);
  const gridPanelRef = useRef<HTMLElement | null>(null);
  const openingInvoiceIdRef = useRef<string | null>(null);
  const sortColumnsRef = useRef<readonly SortColumn[]>(sortColumns);
  const isInvoiceImportingRef = useRef<(invoiceId: string) => boolean>(() => false);
  const hasActiveImportJobsRef = useRef(false);
  const refreshingImportInvoicesRef = useRef(new Set<string>());
  const checkGenerationRef = useRef(0);
  const checkInFlightRef = useRef<{ key: string } | null>(null);
  const checkRetryAttemptsRef = useRef(new Map<string, number>());
  const checkRetryKeyRef = useRef<string | null>(null);
  const checkRetryTimerRef = useRef<number | null>(null);
  const refreshInvoiceCheckRef = useRef<
    | ((
        invoiceId: string,
        expectedRevision: number,
        options?: InvoiceCheckRefreshOptions
      ) => Promise<InvoiceCheckResult | null>)
    | null
  >(null);
  const reloadInvoiceFromDiskRef = useRef<(() => Promise<void>) | null>(null);
  const dismissedCheckKeyRef = useRef<string | null>(null);
  const invoiceCheckResultRef = useRef<InvoiceCheckResult | null>(invoiceCheckResult);
  currentInvoiceRef.current = invoice;
  rowsRef.current = rows;
  busyActionRef.current = busyAction;
  sortColumnsRef.current = sortColumns;
  invoiceCheckResultRef.current = invoiceCheckResult;

  const clearInvoiceCheck = useCallback(() => {
    checkGenerationRef.current += 1;
    checkInFlightRef.current = null;
    checkRetryAttemptsRef.current.clear();
    checkRetryKeyRef.current = null;
    if (checkRetryTimerRef.current !== null) {
      window.clearTimeout(checkRetryTimerRef.current);
      checkRetryTimerRef.current = null;
    }
    dismissedCheckKeyRef.current = null;
    invoiceCheckResultRef.current = null;
    setInvoiceCheckResult(null);
    setCheckSummaryVisible(true);
  }, []);

  const dismissInvoiceCheck = useCallback(() => {
    const current = currentInvoiceRef.current;
    if (current) dismissedCheckKeyRef.current = `${current.id}:${current.revision}`;
    setCheckSummaryVisible(false);
  }, []);

  const clearBuiltOutput = useCallback(() => setBuiltOutput(null), []);

  const refreshReceiptResources = useCallback((invoiceId: string) => {
    setReceiptResourceGenerations((current) => {
      const next = new Map(current);
      next.set(invoiceId, (next.get(invoiceId) ?? 0) + 1);
      return next;
    });
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const pushToast = useCallback(
    (message: string, tone: ToastTone = "neutral", action?: ToastAction) => {
      const id = newRowId();
      setToasts((current) => [...current.slice(-3), { id, message, tone, action }]);
    },
    []
  );

  const confirmReceiptUpload = useCallback((): boolean => {
    if (!settings?.hasOpenAiKey || receiptUploadAcknowledgedRef.current) return true;
    const confirmed = window.confirm(receiptUploadConfirmationMessage());
    if (confirmed) receiptUploadAcknowledgedRef.current = true;
    return confirmed;
  }, [settings?.hasOpenAiKey]);

  const mergeSummary = useCallback((document: InvoiceDocument) => {
    setInvoices((current) => {
      const next = current.filter((summary) => summary.id !== document.id);
      next.push(invoiceToSummary(document));
      return next.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    });
  }, []);

  const handleSaveError = useCallback(
    (error: unknown) => {
      pushToast(`Changes were not saved: ${messageFromError(error)}`, "error");
    },
    [pushToast]
  );

  const handleSaved = useCallback(
    (document: InvoiceDocument) => {
      if (currentInvoiceRef.current?.id === document.id) currentInvoiceRef.current = document;
      setInvoice((current) => (current?.id === document.id ? document : current));
      mergeSummary(document);
    },
    [mergeSummary]
  );

  const autosave = useInvoiceAutosave({ onSaved: handleSaved, onError: handleSaveError });
  saveStatusRef.current = autosave.status;

  const refreshInvoiceCheck = useCallback(
    async (
      invoiceId: string,
      expectedRevision: number,
      options: InvoiceCheckRefreshOptions = {}
    ): Promise<InvoiceCheckResult | null> => {
      const key = `${invoiceId}:${expectedRevision}`;
      const existing = invoiceCheckResultRef.current;
      if (
        !options.force &&
        existing?.invoiceId === invoiceId &&
        existing.revision === expectedRevision
      ) {
        return existing;
      }
      if (!options.force && dismissedCheckKeyRef.current === key) return null;
      if (!options.force && checkInFlightRef.current?.key === key) return null;
      if (!options.force && checkRetryKeyRef.current === key) return null;
      if (!options.force && (checkRetryAttemptsRef.current.get(key) ?? 0) >= 3) return null;
      if (options.force) {
        checkRetryAttemptsRef.current.delete(key);
        checkRetryKeyRef.current = null;
        if (checkRetryTimerRef.current !== null) {
          window.clearTimeout(checkRetryTimerRef.current);
          checkRetryTimerRef.current = null;
        }
        dismissedCheckKeyRef.current = null;
        setCheckSummaryVisible(true);
      }

      const requestGeneration = checkGenerationRef.current + 1;
      const request = { key };
      checkGenerationRef.current = requestGeneration;
      checkInFlightRef.current = request;
      try {
        const result = await window.receiptApp.checkInvoice(invoiceId);
        const currentDocument = currentInvoiceRef.current;
        if (
          checkGenerationRef.current !== requestGeneration ||
          result.invoiceId !== invoiceId ||
          currentDocument?.id !== invoiceId ||
          currentDocument.revision !== expectedRevision
        ) {
          if (options.reportErrors) {
            pushToast("The invoice changed while it was being checked. Run Check Invoice again.");
          }
          return null;
        }
        if (result.revision !== expectedRevision) {
          pushToast(
            "The invoice changed on disk while it was being checked. Reload the latest version.",
            "error",
            {
              label: "Reload",
              run: () => {
                if (currentInvoiceRef.current?.id !== invoiceId) return;
                if (busyActionRef.current) {
                  pushToast("Wait for the current invoice action to finish.");
                  return;
                }
                void reloadInvoiceFromDiskRef.current?.();
              },
            }
          );
          return null;
        }
        checkRetryAttemptsRef.current.delete(key);
        invoiceCheckResultRef.current = result;
        setCheckSummaryVisible(
          options.force ||
            (dismissedCheckKeyRef.current !== key && hasInvoiceCheckAttention(result.issues))
        );
        setInvoiceCheckResult(result);
        return result;
      } catch (error) {
        if (options.reportErrors) {
          pushToast(`Could not check invoice: ${messageFromError(error)}`, "error");
        } else {
          const currentDocument = currentInvoiceRef.current;
          if (
            checkGenerationRef.current === requestGeneration &&
            currentDocument?.id === invoiceId &&
            currentDocument.revision === expectedRevision
          ) {
            const attempt = (checkRetryAttemptsRef.current.get(key) ?? 0) + 1;
            checkRetryAttemptsRef.current.set(key, attempt);
            if (attempt < 3) {
              checkRetryKeyRef.current = key;
              checkRetryTimerRef.current = window.setTimeout(() => {
                checkRetryTimerRef.current = null;
                checkRetryKeyRef.current = null;
                const current = currentInvoiceRef.current;
                if (
                  current?.id === invoiceId &&
                  current.revision === expectedRevision &&
                  saveStatusRef.current === "saved"
                ) {
                  void refreshInvoiceCheckRef.current?.(invoiceId, expectedRevision);
                }
              }, attempt * 1_000);
            } else {
              pushToast(
                "Invoice review could not refresh. Use Check Invoice to try again.",
                "error"
              );
            }
          }
        }
        return null;
      } finally {
        if (checkInFlightRef.current === request) checkInFlightRef.current = null;
      }
    },
    [pushToast]
  );
  refreshInvoiceCheckRef.current = refreshInvoiceCheck;

  useEffect(() => {
    return () => {
      if (checkRetryTimerRef.current !== null) {
        window.clearTimeout(checkRetryTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (allowCloseRef.current) return;

      const editorCommit = commitActiveGridEditor(gridPanelRef.current);
      if (editorCommit === "invalid") {
        event.preventDefault();
        event.returnValue = "";
        return;
      }

      // Main-process file work cannot be safely interrupted. Let the current
      // action settle, then a subsequent close can proceed normally.
      if (busyActionRef.current || hasActiveImportJobsRef.current) {
        event.preventDefault();
        event.returnValue = "";
        return;
      }
      if (saveStatusRef.current === "saved" && editorCommit === "none") return;

      // Electron silently cancels an unload when returnValue is set. Finish
      // the queued revisioned save, then repeat the close once it is safe.
      event.preventDefault();
      event.returnValue = "";
      if (closeSaveInFlightRef.current) return;
      closeSaveInFlightRef.current = true;
      void autosave
        .flush()
        .then(() => {
          allowCloseRef.current = true;
          window.close();
          window.setTimeout(() => {
            allowCloseRef.current = false;
            closeSaveInFlightRef.current = false;
          }, 1_000);
        })
        .catch(() => {
          closeSaveInFlightRef.current = false;
        });
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [autosave.flush]);

  useEffect(() => {
    if (!invoice || autosave.status !== "saved" || isInvoiceImportingRef.current(invoice.id)) {
      return;
    }
    const invoiceId = invoice.id;
    const revision = invoice.revision;
    return scheduleIdleTask(
      () => {
        void refreshInvoiceCheck(invoiceId, revision);
      },
      { delayMs: 250, timeoutMs: 1_000 }
    );
  }, [autosave.status, invoice, refreshInvoiceCheck]);

  const adoptInvoice = useCallback(
    (document: InvoiceDocument, options: InvoiceAdoptionOptions = {}) => {
      const sameInvoice = currentInvoiceRef.current?.id === document.id;
      const activeSort = sameInvoice
        ? normalizeInvoiceSort(sortColumnsRef.current)
        : normalizeInvoiceSort(DEFAULT_INVOICE_SORT);
      const orderedRows = sortInvoiceRows(document.rows, activeSort);
      const viewDocument = { ...document, rows: orderedRows };

      if (!sameInvoice) {
        sortColumnsRef.current = activeSort;
        setSortColumns(activeSort);
      }
      if (options.checkResult) {
        checkGenerationRef.current += 1;
        dismissedCheckKeyRef.current = null;
        invoiceCheckResultRef.current = options.checkResult;
        setInvoiceCheckResult(options.checkResult);
      } else {
        clearInvoiceCheck();
      }
      if (!options.preserveBuiltOutput) clearBuiltOutput();
      currentInvoiceRef.current = viewDocument;
      setPendingImportRefreshes((current) => retainImportRefreshForInvoice(current, document.id));
      setInvoice(viewDocument);
      setRows(orderedRows);
      const orderedRowIds = new Set(orderedRows.map((row) => row.id));
      setSelectedRows((current) =>
        options.preserveSelection
          ? new Set([...current].filter((id) => orderedRowIds.has(id)))
          : new Set()
      );
      setFocusRowId(null);
      setDetailRowId((current) =>
        current && document.rows.some((row) => row.id === current) ? current : null
      );
      autosave.reset(document);
      if (options.persistSort !== false && !rowsHaveSameOrder(document.rows, orderedRows)) {
        autosave.stage(orderedRows);
      }
      mergeSummary(viewDocument);
    },
    [autosave.reset, autosave.stage, clearBuiltOutput, clearInvoiceCheck, mergeSummary]
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        if (!window.receiptApp)
          throw new Error("The desktop bridge is unavailable. Restart the app.");
        const initialSettings = await window.receiptApp.getSettings();
        if (cancelled) return;
        setSettings(initialSettings);
        if (initialSettings.baseFolder) {
          const list = (await window.receiptApp.listInvoices()).sort((a, b) =>
            b.updatedAt.localeCompare(a.updatedAt)
          );
          if (cancelled) return;
          setInvoices(list);
          if (list[0]) {
            const document = await window.receiptApp.loadInvoice(list[0].id);
            if (!cancelled) adoptInvoice(document);
          }
        }
      } catch (error) {
        if (!cancelled) setBootError(messageFromError(error));
      } finally {
        if (!cancelled) setBooting(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [adoptInvoice]);

  const handleLegacyImportProgress = useCallback((progress: ImportProgress) => {
    if (progress.invoiceId === currentInvoiceRef.current?.id) setImportProgress(progress);
  }, []);

  const handleBackgroundImportTerminal = useCallback(
    (progress: ImportProgress) => {
      if (
        shouldQueueImportRefresh(
          currentInvoiceRef.current?.id ?? null,
          openingInvoiceIdRef.current,
          progress.invoiceId
        )
      ) {
        setPendingImportRefreshes((current) => new Set(current).add(progress.invoiceId));
      }
      pushToast(
        progress.message ??
          (progress.status === "cancelled" ? "Receipt scan cancelled." : "Receipt scan complete."),
        progress.status === "failed" ? "error" : "neutral"
      );
    },
    [pushToast]
  );

  const importJobs = useImportJobs({
    onLegacyProgress: handleLegacyImportProgress,
    onTerminal: handleBackgroundImportTerminal,
  });
  isInvoiceImportingRef.current = (invoiceId) =>
    importJobs.isInvoiceImporting(invoiceId) || pendingImportRefreshes.has(invoiceId);
  hasActiveImportJobsRef.current = importJobs.jobs.size > 0 || pendingImportRefreshes.size > 0;

  const currentImportJob = useMemo(() => {
    if (!invoice) return null;
    const candidates = [...importJobs.jobs.values()].filter(
      (progress) => progress.invoiceId === invoice.id
    );
    return candidates.find((progress) => progress.status !== "queued") ?? candidates[0] ?? null;
  }, [importJobs.jobs, invoice]);
  const importingInvoiceIds = useMemo(
    () => new Set([...importJobs.jobs.values()].map((progress) => progress.invoiceId)),
    [importJobs.jobs]
  );
  const pendingImportProgress: ImportProgress | null =
    invoice && pendingImportRefreshes.has(invoice.id)
      ? {
          invoiceId: invoice.id,
          current: 1,
          total: 1,
          filename: "Updating invoice rows",
          status: "complete",
        }
      : null;
  const displayedImportProgress = currentImportJob ?? importProgress ?? pendingImportProgress;
  const currentInvoiceLocked =
    busyAction !== null ||
    currentImportJob !== null ||
    Boolean(invoice && pendingImportRefreshes.has(invoice.id));

  useEffect(() => {
    if (
      !invoice ||
      busyAction !== null ||
      currentImportJob !== null ||
      !pendingImportRefreshes.has(invoice.id) ||
      autosave.status !== "saved" ||
      refreshingImportInvoicesRef.current.has(invoice.id)
    ) {
      return;
    }
    const invoiceId = invoice.id;
    let cancelled = false;
    refreshingImportInvoicesRef.current.add(invoiceId);
    void window.receiptApp
      .loadInvoice(invoiceId)
      .then((document) => {
        if (!cancelled && currentInvoiceRef.current?.id === invoiceId) {
          refreshReceiptResources(invoiceId);
          adoptInvoice(document);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          pushToast(
            `Could not refresh the completed receipt scan: ${messageFromError(error)}`,
            "error"
          );
        }
      })
      .finally(() => {
        refreshingImportInvoicesRef.current.delete(invoiceId);
        if (!cancelled) {
          setPendingImportRefreshes((current) => {
            const next = new Set(current);
            next.delete(invoiceId);
            return next;
          });
        }
      });
    return () => {
      cancelled = true;
      refreshingImportInvoicesRef.current.delete(invoiceId);
    };
  }, [
    adoptInvoice,
    autosave.status,
    busyAction,
    currentImportJob,
    invoice,
    pendingImportRefreshes,
    pushToast,
    refreshReceiptResources,
  ]);

  const chooseFolder = useCallback(async (): Promise<SettingsView> => {
    if (importJobs.jobs.size > 0 || pendingImportRefreshes.size > 0) {
      throw new Error("Cancel or wait for active receipt scans before changing folders.");
    }
    await autosave.flush();
    const previousFolder = settings?.baseFolder ?? null;
    const next = await window.receiptApp.chooseBaseFolder();
    setSettings(next);
    if (next.baseFolder && next.baseFolder !== previousFolder) {
      // The settings change is already durable at this point. Clear the old
      // workspace before reading the new folder so a read error can never
      // leave an invoice from the previous folder editable on screen.
      setInvoices([]);
      clearInvoiceCheck();
      clearBuiltOutput();
      currentInvoiceRef.current = null;
      setInvoice(null);
      setRows([]);
      setSelectedRows(new Set());
      setFocusRowId(null);
      setDetailRowId(null);
      autosave.reset(null);
      const list = (await window.receiptApp.listInvoices()).sort((a, b) =>
        b.updatedAt.localeCompare(a.updatedAt)
      );
      setInvoices(list);
      if (list[0]) {
        adoptInvoice(await window.receiptApp.loadInvoice(list[0].id));
      }
    }
    return next;
  }, [
    adoptInvoice,
    autosave.flush,
    autosave.reset,
    clearBuiltOutput,
    clearInvoiceCheck,
    importJobs.jobs.size,
    pendingImportRefreshes.size,
    settings?.baseFolder,
  ]);

  const handleOnboardingFolder = async () => {
    setBusyAction("folder");
    setBootError(null);
    try {
      const next = await chooseFolder();
      if (!next.baseFolder) setBootError(null);
    } catch (error) {
      setBootError(messageFromError(error));
    } finally {
      setBusyAction(null);
    }
  };

  const openInvoice = async (invoiceId: string) => {
    if (busyAction || invoice?.id === invoiceId) return;
    const previousInvoiceId = currentInvoiceRef.current?.id;
    if (previousInvoiceId) {
      setPendingImportRefreshes((current) => clearImportRefresh(current, previousInvoiceId));
    }
    openingInvoiceIdRef.current = invoiceId;
    setBusyAction("load");
    try {
      await autosave.flush();
      adoptInvoice(await window.receiptApp.loadInvoice(invoiceId), {
        persistSort: !isInvoiceImportingRef.current(invoiceId),
      });
    } catch (error) {
      pushToast(`Could not open invoice: ${messageFromError(error)}`, "error");
    } finally {
      if (openingInvoiceIdRef.current === invoiceId) openingInvoiceIdRef.current = null;
      if (currentInvoiceRef.current?.id !== invoiceId) {
        setPendingImportRefreshes((current) => clearImportRefresh(current, invoiceId));
      }
      setBusyAction(null);
    }
  };

  const reloadInvoiceFromDisk = async () => {
    if (!invoice || busyAction) return;
    if (isInvoiceImportingRef.current(invoice.id)) {
      pushToast("Cancel or wait for this invoice's receipt scan before reloading it.");
      return;
    }
    if (
      !window.confirm(
        "Reload the latest invoice from disk? Your unsaved table edits will be discarded."
      )
    ) {
      return;
    }
    setBusyAction("load");
    try {
      const document = await window.receiptApp.loadInvoice(invoice.id);
      adoptInvoice(document);
      pushToast("Reloaded the latest invoice from disk.", "success");
    } catch (error) {
      pushToast(`Could not reload invoice: ${messageFromError(error)}`, "error");
    } finally {
      setBusyAction(null);
    }
  };
  reloadInvoiceFromDiskRef.current = reloadInvoiceFromDisk;

  const createInvoice = async (period: InvoicePeriod) => {
    setBusyAction("create");
    try {
      await autosave.flush();
      const document = await window.receiptApp.createInvoice(period);
      adoptInvoice(document);
      setNewInvoiceOpen(false);
      pushToast("Invoice created.", "success");
    } catch (error) {
      pushToast(`Could not create invoice: ${messageFromError(error)}`, "error");
    } finally {
      setBusyAction(null);
    }
  };

  const updateInvoicePeriod = async (period: InvoicePeriod) => {
    const activeInvoice = currentInvoiceRef.current;
    if (!activeInvoice || busyActionRef.current) return;
    if (isInvoiceImportingRef.current(activeInvoice.id)) {
      throw new Error("Cancel or wait for this invoice's receipt scan before changing its dates.");
    }
    if (
      period.startDate === activeInvoice.period.startDate &&
      period.endDate === activeInvoice.period.endDate
    ) {
      setEditInvoicePeriodOpen(false);
      return;
    }

    const invoiceId = activeInvoice.id;
    busyActionRef.current = "edit-period";
    setBusyAction("edit-period");
    try {
      const savedDocument = await autosave.flush();
      const documentToUpdate = savedDocument ?? currentInvoiceRef.current;
      if (!documentToUpdate || documentToUpdate.id !== invoiceId) {
        throw new Error("The open invoice changed before its dates could be updated.");
      }
      const updated = await window.receiptApp.updateInvoicePeriod(
        invoiceId,
        period,
        documentToUpdate.revision
      );
      if (updated.id !== invoiceId) {
        throw new Error("The date update did not match the open invoice.");
      }
      adoptInvoice(updated, { preserveSelection: true });
      setEditInvoicePeriodOpen(false);
      pushToast("Invoice dates updated.", "success");
    } catch (error) {
      const errorMessage = messageFromError(error);
      const revisionConflict = appErrorCode(error) === "REVISION_CONFLICT";
      pushToast(
        `Could not update invoice dates: ${errorMessage}`,
        "error",
        revisionConflict
          ? {
              label: "Reload",
              run: () => {
                if (currentInvoiceRef.current?.id !== invoiceId) return;
                if (busyActionRef.current) {
                  pushToast("Wait for the current invoice action to finish.");
                  return;
                }
                void reloadInvoiceFromDisk();
              },
            }
          : undefined
      );
      throw error;
    } finally {
      if (busyActionRef.current === "edit-period") {
        busyActionRef.current = null;
        setBusyAction(null);
      }
    }
  };

  const removeActiveInvoice = async (hardDelete: boolean) => {
    const activeInvoice = currentInvoiceRef.current;
    if (!activeInvoice || busyActionRef.current) return;
    if (isInvoiceImportingRef.current(activeInvoice.id)) {
      setRemoveInvoiceError(
        "Cancel or wait for the active receipt scan before removing this invoice."
      );
      return;
    }

    const invoiceId = activeInvoice.id;
    busyActionRef.current = "remove-invoice";
    setBusyAction("remove-invoice");
    setRemoveInvoiceError(null);
    setRemoveInvoiceConflict(false);
    try {
      const savedDocument = await autosave.flush();
      const documentToRemove = savedDocument ?? currentInvoiceRef.current;
      if (!documentToRemove || documentToRemove.id !== invoiceId) {
        throw new Error("The open invoice changed before it could be removed.");
      }

      const result = await window.receiptApp.removeInvoice(invoiceId, {
        expectedRevision: documentToRemove.revision,
        hardDelete,
      });
      if (result.invoiceId !== invoiceId) {
        throw new Error("The removal result did not match the open invoice.");
      }

      clearInvoiceCheck();
      clearBuiltOutput();
      currentInvoiceRef.current = null;
      setInvoice(null);
      setRows([]);
      setSelectedRows(new Set());
      setFocusRowId(null);
      setDetailRowId(null);
      setImportProgress(null);
      autosave.reset(null);
      setInvoices((current) => current.filter((summary) => summary.id !== invoiceId));
      setRemoveInvoiceOpen(false);
      setRemoveInvoiceConflict(false);

      const notification = invoiceRemovalNotification(result);
      pushToast(notification.message, notification.tone);

      try {
        const list = (await window.receiptApp.listInvoices()).sort((a, b) =>
          b.updatedAt.localeCompare(a.updatedAt)
        );
        setInvoices(list);
        if (list[0]) {
          try {
            adoptInvoice(await window.receiptApp.loadInvoice(list[0].id));
          } catch (error) {
            pushToast(
              `The invoice was removed, but the next invoice could not open: ${messageFromError(error)}`,
              "error"
            );
          }
        }
      } catch (error) {
        pushToast(
          `The invoice was removed, but the invoice list could not refresh: ${messageFromError(error)}`,
          "error"
        );
      }
    } catch (error) {
      const errorMessage = messageFromError(error);
      const revisionConflict = appErrorCode(error) === "REVISION_CONFLICT";
      setRemoveInvoiceConflict(revisionConflict);
      setRemoveInvoiceError(errorMessage);
      pushToast(`Could not remove invoice: ${errorMessage}`, "error");
    } finally {
      if (busyActionRef.current === "remove-invoice") {
        busyActionRef.current = null;
        setBusyAction(null);
      }
    }
  };

  const updateRows = useCallback(
    (nextRows: InvoiceRow[]) => {
      const activeInvoice = currentInvoiceRef.current;
      const activeInvoiceId = activeInvoice?.id;
      if (activeInvoiceId && isInvoiceImportingRef.current(activeInvoiceId)) return;
      const consolidatedRows = activeInvoice
        ? consolidateInvoiceRows(nextRows, {
            defaultRateMinor: activeInvoice.defaultRateMinor,
            createRowId: newRowId,
          })
        : nextRows;
      const orderedRows = rowsNeedResort(rows, consolidatedRows, sortColumnsRef.current)
        ? sortInvoiceRows(consolidatedRows, sortColumnsRef.current)
        : consolidatedRows;
      clearInvoiceCheck();
      clearBuiltOutput();
      rowsRef.current = orderedRows;
      setRows(orderedRows);
      autosave.stage(orderedRows);
      setSelectedRows((current) => {
        if (current.size === 0) return current;
        const orderedRowIds = new Set(orderedRows.map((row) => row.id));
        if ([...current].every((id) => orderedRowIds.has(id))) return current;
        return new Set([...current].filter((id) => orderedRowIds.has(id)));
      });
    },
    [autosave.stage, clearBuiltOutput, clearInvoiceCheck, rows]
  );

  const handleSortColumnsChange = useCallback(
    (requestedSort: SortColumn[]) => {
      const nextSort = normalizeInvoiceSort(requestedSort);
      sortColumnsRef.current = nextSort;
      setSortColumns(nextSort);

      const orderedRows = sortInvoiceRows(rows, nextSort);
      if (!rowsHaveSameOrder(rows, orderedRows)) {
        updateRows(orderedRows);
      }
    },
    [rows, updateRows]
  );

  const appendManualRow = useCallback((): InvoiceRow | null => {
    const activeInvoice = currentInvoiceRef.current;
    if (!activeInvoice) return null;
    if (isInvoiceImportingRef.current(activeInvoice.id)) {
      pushToast("Cancel or wait for this invoice's receipt scan before editing rows.");
      return null;
    }
    const row: InvoiceRow = {
      id: newRowId(),
      date: defaultManualRowDate(activeInvoice),
      groceriesMinor: null,
      hours: "",
      rateMinor: activeInvoice.defaultRateMinor,
      comment: "",
      receiptId: null,
    };
    updateRows([...rowsRef.current, row]);
    return row;
  }, [pushToast, updateRows]);

  const addManualRow = useCallback(() => {
    if (currentInvoiceLocked) return;
    const row = appendManualRow();
    if (!row) return;
    setFocusRowId(row.id);
  }, [appendManualRow, currentInvoiceLocked]);

  const appendTrailingEmptyRow = useCallback(() => {
    if (currentInvoiceLocked) return null;
    const activeInvoice = currentInvoiceRef.current;
    const lastRow = rowsRef.current.at(-1);
    if (activeInvoice && lastRow && isDefaultManualRow(lastRow, activeInvoice)) {
      return { ...lastRow };
    }
    return appendManualRow();
  }, [appendManualRow, currentInvoiceLocked]);

  const discardTrailingEmptyRow = useCallback(
    (rowId: string) => {
      const nextRows = rowsRef.current.filter((row) => row.id !== rowId);
      if (nextRows.length !== rowsRef.current.length) updateRows(nextRows);
    },
    [updateRows]
  );

  useEffect(() => {
    const handleManualRowShortcut = (event: globalThis.KeyboardEvent) => {
      if (
        event.repeat ||
        event.altKey ||
        !event.shiftKey ||
        (!event.metaKey && !event.ctrlKey) ||
        event.key.toLowerCase() !== "m"
      ) {
        return;
      }
      event.preventDefault();
      addManualRow();
    };
    window.addEventListener("keydown", handleManualRowShortcut);
    return () => window.removeEventListener("keydown", handleManualRowShortcut);
  }, [addManualRow]);

  const retryableSelectedReceiptIds = useMemo(() => {
    if (!invoice) return [];
    const retryable = new Set(
      invoice.receipts.filter((receipt) => receipt.status !== "ready").map((receipt) => receipt.id)
    );
    return rows
      .filter((row) => selectedRows.has(row.id) && row.receiptId && retryable.has(row.receiptId))
      .map((row) => row.receiptId as string);
  }, [invoice, rows, selectedRows]);

  const importPaths = useCallback(
    async (paths: string[], method: NonNullable<ImportFilesOptions["method"]>) => {
      if (!invoice || paths.length === 0) return;
      if (busyAction) {
        pushToast("Wait for the current invoice action to finish.");
        return;
      }
      if (isInvoiceImportingRef.current(invoice.id)) {
        pushToast("Cancel or wait for this invoice's active receipt scan before adding more.");
        return;
      }
      if (!confirmReceiptUpload()) return;
      clearBuiltOutput();
      setBusyAction("import");
      setImportProgress({
        invoiceId: invoice.id,
        current: 0,
        total: paths.length,
        filename:
          paths.length === 1
            ? (paths[0].split("/").pop() ?? "Receipt")
            : `${paths.length} receipts`,
        status: "copying",
      });
      try {
        await autosave.flush();
        const {
          importedCount,
          duplicates: allDuplicates,
          errors: allErrors,
        } = await startReceiptImportWorkflow({
          api: window.receiptApp,
          invoiceId: invoice.id,
          paths,
          method,
          confirmCrossInvoiceDuplicates: (duplicates) =>
            window.confirm(
              `${duplicates.length} receipt${duplicates.length === 1 ? " was" : "s were"} already used in another invoice. Import ${duplicates.length === 1 ? "it" : "them"} here too?`
            ),
          onStarted: (result, startedPaths) => {
            const jobActive = importJobs.registerJob({
              jobId: result.jobId,
              invoiceId: invoice.id,
              total: startedPaths.length,
              filename:
                startedPaths.length === 1
                  ? (startedPaths[0].split("/").pop() ?? "Receipt")
                  : `${startedPaths.length} receipts`,
            });
            if (jobActive && currentInvoiceRef.current?.id === invoice.id) {
              adoptInvoice(result.invoice, { persistSort: false });
            }
          },
        });
        if (importedCount > 0) {
          pushToast(
            settings?.hasOpenAiKey
              ? `${importedCount} receipt${importedCount === 1 ? "" : "s"} added locally; scanning continues in the background.`
              : `${importedCount} receipt${importedCount === 1 ? "" : "s"} added locally. Add an OpenAI key to scan ${importedCount === 1 ? "it" : "them"}.`,
            "success"
          );
        }
        if (allErrors.length > 0) {
          const [firstError] = allErrors;
          const remaining = allErrors.length - 1;
          pushToast(
            `${firstError.filename}: ${firstError.message}${remaining > 0 ? ` (+${remaining} more)` : ""}`,
            "error"
          );
        }
        const skipped = allDuplicates.filter((duplicate) => duplicate.sameInvoice).length;
        if (skipped > 0) {
          pushToast(
            `${skipped} duplicate${skipped === 1 ? " was" : "s were"} already in this invoice.`
          );
        }
      } catch (error) {
        pushToast(`Receipt import failed: ${messageFromError(error)}`, "error");
      } finally {
        setBusyAction(null);
        setImportProgress(null);
      }
    },
    [
      adoptInvoice,
      autosave.flush,
      busyAction,
      clearBuiltOutput,
      confirmReceiptUpload,
      importJobs.registerJob,
      invoice,
      pushToast,
      settings?.hasOpenAiKey,
    ]
  );

  const chooseReceipts = async () => {
    if (!invoice) return;
    try {
      const paths = await window.receiptApp.chooseReceiptFiles();
      await importPaths(paths, "file-picker");
    } catch (error) {
      pushToast(`Could not choose receipts: ${messageFromError(error)}`, "error");
    }
  };

  const dropFiles = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    dragDepthRef.current = 0;
    setDraggingFiles(false);
    if (commitActiveGridEditor(gridPanelRef.current) === "invalid") {
      pushToast("Correct the active invoice cell before adding receipts.", "error");
      return;
    }
    if (!invoice) {
      pushToast("Create or open an invoice before adding receipts.", "error");
      return;
    }
    const paths: string[] = [];
    for (const file of Array.from(event.dataTransfer.files)) {
      try {
        const path = window.receiptApp.pathForFile(file);
        if (path) paths.push(path);
      } catch {
        // The main process performs final validation; inaccessible browser files are simply skipped.
      }
    }
    if (paths.length === 0) {
      pushToast("No local image or PDF files were found in that drop.", "error");
      return;
    }
    void importPaths(paths, "drag-drop");
  };

  const retryReceiptIds = async (receiptIds: string[]) => {
    if (busyAction) {
      pushToast("Wait for the current invoice action to finish.");
      return;
    }
    if (!invoice || receiptIds.length === 0) {
      pushToast("Select one or more receipt rows to retry.");
      return;
    }
    if (isInvoiceImportingRef.current(invoice.id)) {
      pushToast("Cancel or wait for this invoice's active receipt scan before retrying.");
      return;
    }
    if (!confirmReceiptUpload()) return;
    clearBuiltOutput();
    setBusyAction("retry");
    try {
      await autosave.flush();
      const uniqueReceiptIds = [...new Set(receiptIds)];
      const document = await window.receiptApp.retryReceipts(invoice.id, uniqueReceiptIds);
      refreshReceiptResources(document.id);
      adoptInvoice(document);
      const retried = document.receipts.filter((receipt) => uniqueReceiptIds.includes(receipt.id));
      const completedCount = retried.filter(
        (receipt) => receipt.status === "ready" || receipt.status === "needs-review"
      ).length;
      const failedCount = uniqueReceiptIds.length - completedCount;
      const reviewCount = retried.filter((receipt) => receipt.status === "needs-review").length;
      if (failedCount > 0) {
        pushToast(
          `${failedCount} receipt${failedCount === 1 ? "" : "s"} still could not be scanned. Open the receipt details for the error.`,
          "error"
        );
      } else if (reviewCount > 0) {
        pushToast(
          `${reviewCount} receipt${reviewCount === 1 ? " needs" : "s need"} review.`,
          "neutral"
        );
      } else {
        pushToast(
          `${uniqueReceiptIds.length} receipt${uniqueReceiptIds.length === 1 ? "" : "s"} rescanned.`,
          "success"
        );
      }
    } catch (error) {
      pushToast(`Retry failed: ${messageFromError(error)}`, "error");
    } finally {
      setBusyAction(null);
      setImportProgress(null);
    }
  };

  const retrySelected = () => {
    void retryReceiptIds(retryableSelectedReceiptIds);
  };

  const cancelBackgroundImport = async (jobId: string) => {
    try {
      const cancelled = await importJobs.cancelJob(jobId);
      if (!cancelled) pushToast("That receipt scan has already finished.");
    } catch (error) {
      pushToast(`Could not cancel receipt scanning: ${messageFromError(error)}`, "error");
    }
  };

  const copyTsv = async (scope: "all" | "selected") => {
    if (!invoice) return;
    if (scope === "selected" && selectedRows.size === 0) {
      pushToast("Select one or more invoice rows to copy.");
      return;
    }
    setBusyAction("copy");
    try {
      await autosave.flush();
      const selected = scope === "selected" ? [...selectedRows] : null;
      await window.receiptApp.copyTsv(invoice.id, selected, true, scope === "all");
      pushToast(
        selected
          ? `${selected.length} selected row${selected.length === 1 ? "" : "s"} copied.`
          : "Invoice copied for Google Sheets.",
        "success"
      );
    } catch (error) {
      pushToast(`Could not copy rows: ${messageFromError(error)}`, "error");
    } finally {
      setBusyAction(null);
    }
  };

  const deleteSelected = useCallback(async () => {
    if (!invoice || selectedRows.size === 0 || busyAction) return;
    const invoiceId = invoice.id;
    const count = selectedRows.size;
    if (!window.confirm(`Delete ${count} selected row${count === 1 ? "" : "s"}?`)) return;
    clearBuiltOutput();
    setBusyAction("delete");
    try {
      await autosave.flush();
      if (currentInvoiceRef.current?.id !== invoiceId) return;
      const document = await window.receiptApp.deleteRows(invoiceId, [...selectedRows]);
      if (currentInvoiceRef.current?.id !== invoiceId) return;
      adoptInvoice(document);
      pushToast(`${count} row${count === 1 ? "" : "s"} deleted.`, "neutral", {
        label: "Undo",
        run: () => {
          if (currentInvoiceRef.current?.id !== invoiceId) {
            pushToast("Undo is only available while the original invoice is open.");
            return;
          }
          if (busyActionRef.current) {
            pushToast("Wait for the current invoice action to finish.");
            return;
          }
          void (async () => {
            busyActionRef.current = "undo";
            setBusyAction("undo");
            try {
              await autosave.flush();
              if (currentInvoiceRef.current?.id !== invoiceId) return;
              clearBuiltOutput();
              const restored = await window.receiptApp.undoLastDelete(invoiceId);
              if (currentInvoiceRef.current?.id !== invoiceId) return;
              adoptInvoice(restored);
              pushToast("Delete undone.", "success");
            } catch (error) {
              pushToast(`Could not undo: ${messageFromError(error)}`, "error");
            } finally {
              if (busyActionRef.current === "undo") {
                busyActionRef.current = null;
                setBusyAction(null);
              }
            }
          })();
        },
      });
    } catch (error) {
      pushToast(`Could not delete rows: ${messageFromError(error)}`, "error");
    } finally {
      setBusyAction(null);
    }
  }, [
    adoptInvoice,
    autosave.flush,
    busyAction,
    clearBuiltOutput,
    invoice,
    pushToast,
    selectedRows,
  ]);

  const exportInvoice = async (asZip: boolean, includeDebug: boolean) => {
    if (!invoice) return;
    setBusyAction("export");
    try {
      await autosave.flush();
      const result = await window.receiptApp.exportPackage(invoice.id, { asZip, includeDebug });
      if (!result.canceled) {
        setExportOpen(false);
        pushToast(`${asZip ? "ZIP" : "Folder"} exported.`, "success");
      }
    } catch (error) {
      pushToast(`Export failed: ${messageFromError(error)}`, "error");
    } finally {
      setBusyAction(null);
    }
  };

  const revealInvoice = async () => {
    if (!invoice) return;
    try {
      await window.receiptApp.revealInvoice(invoice.id);
    } catch (error) {
      pushToast(`Could not open Finder: ${messageFromError(error)}`, "error");
    }
  };

  const runInvoiceCheck = async () => {
    if (!invoice || busyAction) return;
    const invoiceId = invoice.id;
    setBusyAction("check");
    try {
      const savedDocument = await autosave.flush();
      const documentToCheck = savedDocument ?? currentInvoiceRef.current;
      if (!documentToCheck || documentToCheck.id !== invoiceId) return;
      await refreshInvoiceCheck(invoiceId, documentToCheck.revision, {
        force: true,
        reportErrors: true,
      });
    } catch (error) {
      pushToast(`Could not save before checking: ${messageFromError(error)}`, "error");
    } finally {
      setBusyAction(null);
    }
  };

  const setReviewAcknowledgement = async (fingerprint: string, acknowledged: boolean) => {
    if (!invoice || busyAction) return;
    const invoiceId = invoice.id;
    setUpdatingReviewFingerprints(new Set([fingerprint]));
    setBusyAction("review");
    try {
      const savedDocument = await autosave.flush();
      const documentToUpdate = savedDocument ?? currentInvoiceRef.current;
      if (!documentToUpdate || documentToUpdate.id !== invoiceId) return;

      const result = await window.receiptApp.setReviewAcknowledgement(
        invoiceId,
        fingerprint,
        acknowledged,
        documentToUpdate.revision
      );
      if (
        result.invoice.id !== invoiceId ||
        result.check.invoiceId !== invoiceId ||
        result.check.revision !== result.invoice.revision
      ) {
        throw new Error("The review result did not match the open invoice.");
      }
      adoptInvoice(result.invoice, {
        checkResult: result.check,
        preserveBuiltOutput: true,
        preserveSelection: true,
      });
      pushToast(acknowledged ? "Review item checked off." : "Review item reopened.", "success");
    } catch (error) {
      const errorMessage = messageFromError(error);
      const revisionConflict = appErrorCode(error) === "REVISION_CONFLICT";
      pushToast(
        `Could not update the review checklist: ${errorMessage}`,
        "error",
        revisionConflict
          ? {
              label: "Reload",
              run: () => {
                if (currentInvoiceRef.current?.id !== invoiceId) return;
                if (busyActionRef.current) {
                  pushToast("Wait for the current invoice action to finish.");
                  return;
                }
                void reloadInvoiceFromDisk();
              },
            }
          : undefined
      );
    } finally {
      setUpdatingReviewFingerprints(new Set());
      setBusyAction(null);
    }
  };

  const buildOutput = async () => {
    if (!invoice || busyAction) return;
    const invoiceId = invoice.id;
    setBusyAction("build-output");
    try {
      await autosave.flush();
      if (currentInvoiceRef.current?.id !== invoiceId) return;
      const result = await window.receiptApp.buildInvoiceOutput(invoiceId);
      if (currentInvoiceRef.current?.id !== invoiceId) return;
      setBuiltOutput({ invoiceId, result });
      pushToast(
        `Output built with the PDF, ZIP archive, and ${result.receiptCount} unique receipt file${result.receiptCount === 1 ? "" : "s"}.`,
        "success"
      );
    } catch (error) {
      pushToast(
        `Could not build output. Any previous output was left unchanged: ${messageFromError(error)}`,
        "error"
      );
    } finally {
      setBusyAction(null);
    }
  };

  const revealBuiltOutput = async () => {
    if (!invoice || !builtOutput || builtOutput.invoiceId !== invoice.id || busyAction) return;
    setBusyAction("reveal-output");
    try {
      await window.receiptApp.revealOutput(invoice.id);
    } catch (error) {
      pushToast(`Could not show the output folder: ${messageFromError(error)}`, "error");
    } finally {
      setBusyAction(null);
    }
  };

  const totals = useMemo(() => calculateTotals(rows), [rows]);
  const checkIssuesByRow = useMemo(
    () => indexInvoiceCheckIssuesByRow(invoiceCheckResult?.issues ?? [], rows),
    [invoiceCheckResult, rows]
  );
  const selectedReceiptCount = retryableSelectedReceiptIds.length;
  const receiptRowCount = rows.filter((row) => row.receiptId !== null).length;
  const manualRowCount = rows.length - receiptRowCount;
  const detailRowIndex = detailRowId ? rows.findIndex((row) => row.id === detailRowId) : -1;
  const detailRow = detailRowIndex >= 0 ? (rows[detailRowIndex] ?? null) : null;
  const backgroundInert = detailRow !== null;
  const detailReceipt =
    detailRow?.receiptId && invoice
      ? (invoice.receipts.find((receipt) => receipt.id === detailRow.receiptId) ?? null)
      : null;
  const detailReviewIssues = useMemo(() => {
    if (!detailRow || !invoiceCheckResult) return [];
    return invoiceCheckResult.issues.filter(
      (issue) =>
        isReviewIssue(issue) &&
        (issue.rowIds.includes(detailRow.id) ||
          (detailReceipt !== null && issue.receiptIds.includes(detailReceipt.id)))
    );
  }, [detailReceipt, detailRow, invoiceCheckResult]);

  const handleDragEnter = (event: DragEvent<HTMLElement>) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setDraggingFiles(true);
  };

  const handleDragLeave = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDraggingFiles(false);
  };

  const handleAppMouseDownCapture = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.target instanceof Element && event.target.closest('[aria-modal="true"]')) return;
    if (event.target === document.activeElement) return;
    if (commitActiveGridEditor(gridPanelRef.current) !== "invalid") return;
    event.preventDefault();
    event.stopPropagation();
  };

  if (booting) {
    return (
      <main className="loading-screen" aria-busy="true">
        <span className="loading-mark" aria-hidden="true">
          R
        </span>
        <p>Opening your local workspace…</p>
      </main>
    );
  }

  if (!settings?.baseFolder) {
    return (
      <>
        <Onboarding
          busy={busyAction === "folder"}
          error={bootError}
          onChooseFolder={() => void handleOnboardingFolder()}
        />
        <ToastRegion dismiss={dismissToast} toasts={toasts} />
      </>
    );
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: File drag events are delegated at the application boundary; the file picker remains the keyboard equivalent.
    <div
      className="app-shell"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files")) {
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }
      }}
      onDrop={dropFiles}
      onMouseDownCapture={handleAppMouseDownCapture}
    >
      <Sidebar
        activeInvoiceId={invoice?.id ?? null}
        backgroundInert={backgroundInert}
        busy={busyAction != null}
        importingInvoiceIds={importingInvoiceIds}
        invoices={invoices}
        onNew={() => setNewInvoiceOpen(true)}
        onOpen={(id) => void openInvoice(id)}
        onSettings={() => setSettingsOpen(true)}
      />

      <main
        aria-hidden={backgroundInert || undefined}
        className="workspace"
        inert={backgroundInert || undefined}
      >
        {bootError ? (
          <div className="workspace-error">
            <span aria-hidden="true">!</span>
            <p role="alert">
              <strong>Could not fully open the workspace.</strong> {bootError}
            </p>
            <button className="text-button" type="button" onClick={() => setBootError(null)}>
              Dismiss
            </button>
          </div>
        ) : null}
        {!settings.hasOpenAiKey ? (
          <div className="key-banner">
            <span aria-hidden="true">!</span>
            <p role="status">
              <strong>Add an OpenAI API key to scan receipts.</strong> Scanning sends the receipt
              file to OpenAI for extraction. Manual rows and exports still work locally.
            </p>
            <button className="text-button" type="button" onClick={() => setSettingsOpen(true)}>
              Open Settings
            </button>
          </div>
        ) : null}

        {!invoice ? (
          <section className="empty-workspace">
            <div className="empty-workspace-illustration" aria-hidden="true">
              ＋
            </div>
            <h1>Create your first invoice</h1>
            <p>Choose a billing period, then add receipt images or PDFs in one batch.</p>
            <button
              className="button button--primary button--large"
              type="button"
              onClick={() => setNewInvoiceOpen(true)}
            >
              New Invoice
            </button>
          </section>
        ) : (
          <>
            <header className="workspace-header">
              <div className="workspace-title">
                <p className="eyebrow">Client invoice</p>
                <h1>{invoice.name}</h1>
                <div className="workspace-period">
                  <span>{formatPeriod(invoice.period.startDate, invoice.period.endDate)}</span>
                  <button
                    aria-label="Edit invoice dates"
                    className="text-button workspace-period-edit"
                    disabled={currentInvoiceLocked}
                    type="button"
                    onClick={() => setEditInvoicePeriodOpen(true)}
                  >
                    Edit dates
                  </button>
                </div>
              </div>
              <div className="workspace-summary">
                <div>
                  <span>Groceries</span>
                  <strong>{formatMoney(totals.groceriesMinor)}</strong>
                </div>
                <div>
                  <span>Labour</span>
                  <strong>{formatMoney(totals.labourMinor)}</strong>
                </div>
                <div className="workspace-summary-total">
                  <span>Invoice total</span>
                  <strong>{formatMoney(totals.invoiceMinor)}</strong>
                </div>
              </div>
            </header>

            <div className="toolbar" aria-label="Invoice actions" role="toolbar">
              <div className="toolbar-primary">
                <button
                  className="button button--primary"
                  disabled={currentInvoiceLocked}
                  title="Open the file picker for one or many receipt images or PDFs"
                  type="button"
                  onClick={() => void chooseReceipts()}
                >
                  <span aria-hidden="true">＋</span>
                  {busyAction === "import" ? "Importing…" : "Add Receipts"}
                </button>
                <button
                  className="button button--secondary"
                  disabled={currentInvoiceLocked}
                  title="Add a manual row (⌘⇧M)"
                  type="button"
                  onClick={addManualRow}
                >
                  <span aria-hidden="true">✎</span>
                  Manual Row
                </button>
                <button
                  className="button button--secondary"
                  disabled={currentInvoiceLocked || selectedReceiptCount === 0}
                  title={
                    selectedReceiptCount === 0 ? "Select one or more receipt rows first" : undefined
                  }
                  type="button"
                  onClick={retrySelected}
                >
                  <span aria-hidden="true">↻</span>
                  Retry Selected
                </button>
                <button
                  className="button button--secondary"
                  disabled={currentInvoiceLocked}
                  title="Check for duplicate transactions, incomplete scans, and dates outside the invoice period"
                  type="button"
                  onClick={() => void runInvoiceCheck()}
                >
                  <span aria-hidden="true">✓</span>
                  {busyAction === "check" ? "Checking…" : "Check Invoice"}
                </button>
              </div>
              <div className="toolbar-secondary">
                {selectedRows.size > 0 ? (
                  <button
                    className="button button--danger-quiet"
                    disabled={currentInvoiceLocked}
                    type="button"
                    onClick={() => void deleteSelected()}
                  >
                    Delete {selectedRows.size}
                  </button>
                ) : null}
                <button
                  className="button button--secondary"
                  disabled={currentInvoiceLocked}
                  title="Build the client PDF and unique receipt files, replacing any previous PDF output"
                  type="button"
                  onClick={() => void buildOutput()}
                >
                  <span aria-hidden="true">▣</span>
                  {busyAction === "build-output" ? "Building PDF…" : "Build PDF Output"}
                </button>
                <CopyInvoiceActions
                  disabled={currentInvoiceLocked}
                  selectedCount={selectedRows.size}
                  onCopyAll={() => void copyTsv("all")}
                  onCopySelected={() => void copyTsv("selected")}
                />
                <button
                  className="button button--secondary"
                  disabled={currentInvoiceLocked}
                  type="button"
                  onClick={() => setExportOpen(true)}
                >
                  <span aria-hidden="true">⇧</span>
                  Export Spreadsheet…
                </button>
                <button
                  className="button button--danger-quiet"
                  disabled={currentInvoiceLocked}
                  type="button"
                  onClick={() => {
                    setRemoveInvoiceError(null);
                    setRemoveInvoiceConflict(false);
                    setRemoveInvoiceOpen(true);
                  }}
                >
                  Remove Invoice…
                </button>
                <button
                  aria-label="Reveal invoice in Finder"
                  className="icon-button icon-button--bordered"
                  disabled={currentInvoiceLocked}
                  title="Reveal in Finder"
                  type="button"
                  onClick={() => void revealInvoice()}
                >
                  ⌕
                </button>
              </div>
            </div>

            {invoiceCheckResult && checkSummaryVisible ? (
              <InvoiceCheckSummary
                disabled={currentInvoiceLocked}
                result={invoiceCheckResult}
                updatingFingerprints={updatingReviewFingerprints}
                onDismiss={dismissInvoiceCheck}
                onToggle={(fingerprint, acknowledged) =>
                  void setReviewAcknowledgement(fingerprint, acknowledged)
                }
              />
            ) : null}

            {builtOutput?.invoiceId === invoice.id ? (
              <OutputReadyBanner
                disabled={currentInvoiceLocked}
                revealing={busyAction === "reveal-output"}
                result={builtOutput.result}
                onDismiss={clearBuiltOutput}
                onReveal={() => void revealBuiltOutput()}
              />
            ) : null}

            {displayedImportProgress ? (
              <ImportProgressPanel
                cancelling={Boolean(
                  currentImportJob?.jobId && importJobs.cancellingJobIds.has(currentImportJob.jobId)
                )}
                progress={displayedImportProgress}
                onCancel={(jobId) => void cancelBackgroundImport(jobId)}
              />
            ) : null}

            <section ref={gridPanelRef} className="grid-panel" aria-busy={currentInvoiceLocked}>
              <div className="grid-panel-heading">
                <div>
                  <h2>{workspaceViewMode === "table" ? "Invoice rows" : "Receipt gallery"}</h2>
                  <span>
                    {workspaceViewMode === "table" ? (
                      <>
                        {rows.length} {rows.length === 1 ? "row" : "rows"}
                      </>
                    ) : (
                      <>
                        {receiptRowCount} {receiptRowCount === 1 ? "receipt" : "receipts"}
                        {manualRowCount > 0
                          ? ` · ${manualRowCount} manual ${manualRowCount === 1 ? "row" : "rows"}`
                          : ""}
                      </>
                    )}
                  </span>
                </div>
                <div className="grid-panel-heading-actions">
                  <fieldset className="view-switch">
                    <legend className="sr-only">Invoice row view</legend>
                    <button
                      aria-pressed={workspaceViewMode === "table"}
                      className="view-switch-button"
                      title="Edit invoice rows in a table"
                      type="button"
                      onClick={() => setWorkspaceViewMode("table")}
                    >
                      <span aria-hidden="true" className="view-switch-icon">
                        ☷
                      </span>
                      Table
                    </button>
                    <button
                      aria-pressed={workspaceViewMode === "gallery"}
                      className="view-switch-button"
                      title="Audit receipts as visual cards"
                      type="button"
                      onClick={() => setWorkspaceViewMode("gallery")}
                    >
                      <span aria-hidden="true" className="view-switch-icon">
                        ▦
                      </span>
                      Gallery
                    </button>
                  </fieldset>
                  <SaveIndicator
                    error={autosave.saveError}
                    status={autosave.status}
                    onReload={() => void reloadInvoiceFromDisk()}
                    onRetry={autosave.retry}
                  />
                </div>
              </div>
              {workspaceViewMode === "table" ? (
                <InvoiceGrid
                  activeRowId={detailRowId}
                  checkIssuesByRow={checkIssuesByRow}
                  disabled={currentInvoiceLocked}
                  focusRowId={focusRowId}
                  receipts={invoice.receipts}
                  rows={rows}
                  selectedRows={selectedRows}
                  sortColumns={sortColumns}
                  totals={totals}
                  onDeleteSelected={() => void deleteSelected()}
                  onAppendEmptyRow={appendTrailingEmptyRow}
                  onDiscardEmptyRow={discardTrailingEmptyRow}
                  onFocusRowHandled={() => setFocusRowId(null)}
                  onOpenRow={setDetailRowId}
                  onRowsChange={updateRows}
                  onSelectedRowsChange={setSelectedRows}
                  onSortColumnsChange={handleSortColumnsChange}
                />
              ) : (
                <ReceiptGallery
                  activeRowId={detailRowId}
                  checkIssuesByRow={checkIssuesByRow}
                  disabled={currentInvoiceLocked}
                  invoiceId={invoice.id}
                  receipts={invoice.receipts}
                  resourceGeneration={receiptResourceGenerations.get(invoice.id) ?? 0}
                  rows={rows}
                  selectedRows={selectedRows}
                  onOpenRow={setDetailRowId}
                  onSelectedRowsChange={setSelectedRows}
                />
              )}
              <div className="grid-help-line">
                {workspaceViewMode === "table" ? (
                  <span>
                    Select a cell and press Enter, or double-click, to edit. Press ⌘⇧M to add a
                    manual row. Tab from the final Comment cell to continue onto a new row.
                  </span>
                ) : (
                  <span>
                    Select cards for batch actions. Open a card to inspect its source and scan
                    details; switch to Table to edit values.
                  </span>
                )}
                <span>The file picker and drag-and-drop both accept one file or a batch.</span>
              </div>
            </section>
          </>
        )}
      </main>

      {detailRow && invoice ? (
        <ReceiptDrawer
          invoiceId={invoice.id}
          resourceGeneration={receiptResourceGenerations.get(invoice.id) ?? 0}
          receipt={detailReceipt}
          reviewDisabled={currentInvoiceLocked}
          reviewIssues={detailReviewIssues}
          row={detailRow}
          rowCount={rows.length}
          rowNumber={detailRowIndex + 1}
          updatingFingerprints={updatingReviewFingerprints}
          onClose={() => setDetailRowId(null)}
          onNextRow={
            detailRowIndex < rows.length - 1
              ? () => setDetailRowId(rows[detailRowIndex + 1]?.id ?? null)
              : undefined
          }
          onPreviousRow={
            detailRowIndex > 0
              ? () => setDetailRowId(rows[detailRowIndex - 1]?.id ?? null)
              : undefined
          }
          onRetry={(receiptId) => void retryReceiptIds([receiptId])}
          onRowChange={(nextRow) =>
            updateRows(rows.map((row) => (row.id === nextRow.id ? nextRow : row)))
          }
          onToggleReview={(fingerprint, acknowledged) =>
            void setReviewAcknowledgement(fingerprint, acknowledged)
          }
        />
      ) : null}

      {draggingFiles ? (
        <div className="drop-overlay" aria-hidden="true">
          <div>
            <span>↓</span>
            <strong>Drop one or many receipts to add them</strong>
            <small>A batch of images and PDFs will be copied into this invoice.</small>
          </div>
        </div>
      ) : null}

      {newInvoiceOpen ? (
        <NewInvoiceModal
          busy={busyAction === "create"}
          onClose={() => setNewInvoiceOpen(false)}
          onCreate={createInvoice}
        />
      ) : null}
      {editInvoicePeriodOpen && invoice ? (
        <EditInvoicePeriodModal
          busy={busyAction === "edit-period"}
          period={invoice.period}
          onClose={() => setEditInvoicePeriodOpen(false)}
          onUpdate={updateInvoicePeriod}
        />
      ) : null}
      {settingsOpen ? (
        <SettingsModal
          settings={settings}
          onChooseFolder={chooseFolder}
          onClose={() => setSettingsOpen(false)}
          onSettingsChange={setSettings}
        />
      ) : null}
      {exportOpen ? (
        <ExportModal
          busy={busyAction === "export"}
          onClose={() => setExportOpen(false)}
          onExport={exportInvoice}
        />
      ) : null}
      {removeInvoiceOpen && invoice ? (
        <RemoveInvoiceModal
          busy={busyAction === "remove-invoice"}
          error={removeInvoiceError}
          invoiceName={invoice.name}
          onClose={() => {
            setRemoveInvoiceError(null);
            setRemoveInvoiceConflict(false);
            setRemoveInvoiceOpen(false);
          }}
          onReload={
            removeInvoiceConflict
              ? () => {
                  setRemoveInvoiceError(null);
                  setRemoveInvoiceConflict(false);
                  setRemoveInvoiceOpen(false);
                  void reloadInvoiceFromDisk();
                }
              : undefined
          }
          onRemove={removeActiveInvoice}
        />
      ) : null}
      <ToastRegion dismiss={dismissToast} toasts={toasts} />
    </div>
  );
}
