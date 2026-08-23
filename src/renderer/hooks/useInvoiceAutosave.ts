import { useCallback, useEffect, useRef, useState } from "react";
import { appErrorCode } from "../../shared/app-error";
import type { InvoiceDocument, InvoiceRow } from "../../shared/types";

export type SaveStatus = "saved" | "dirty" | "saving" | "error";

interface AutosaveOptions {
  onSaved: (invoice: InvoiceDocument) => void;
  onError: (error: unknown) => void;
}

interface WorkingInvoice {
  invoiceId: string | null;
  revision: number;
  rows: InvoiceRow[];
  changeVersion: number;
  savedVersion: number;
  savedSignature: string;
}

function rowsSignature(rows: readonly InvoiceRow[]): string {
  return JSON.stringify(rows);
}

function isRevisionConflict(message: string | null): boolean {
  return appErrorCode(message) === "REVISION_CONFLICT";
}

export function useInvoiceAutosave({ onSaved, onError }: AutosaveOptions) {
  const [status, setStatus] = useState<SaveStatus>("saved");
  const [saveError, setSaveError] = useState<string | null>(null);
  const saveErrorRef = useRef<string | null>(null);
  const workingRef = useRef<WorkingInvoice>({
    invoiceId: null,
    revision: 0,
    rows: [],
    changeVersion: 0,
    savedVersion: 0,
    savedSignature: "[]",
  });
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightRef = useRef<Promise<InvoiceDocument | null> | null>(null);
  const inFlightGenerationRef = useRef<number | null>(null);
  const generationRef = useRef(0);
  const mountedRef = useRef(true);
  const onSavedRef = useRef(onSaved);
  const onErrorRef = useRef(onError);

  useEffect(() => {
    onSavedRef.current = onSaved;
    onErrorRef.current = onError;
  }, [onError, onSaved]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  const persist = useCallback(async (): Promise<InvoiceDocument | null> => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }

    if (inFlightRef.current) {
      const inFlight = inFlightRef.current;
      const inFlightGeneration = inFlightGenerationRef.current;
      try {
        await inFlight;
      } catch (error) {
        // A reset can adopt a different invoice while an older IPC save is
        // still settling. Its failure belongs to the old generation and must
        // not strand rows already staged for the newly adopted invoice.
        if (inFlightGeneration === generationRef.current) throw error;
      }
      const working = workingRef.current;
      if (working.changeVersion === working.savedVersion) return null;
      return persist();
    }

    const currentSaveError = saveErrorRef.current;
    if (isRevisionConflict(currentSaveError)) {
      // A matching row snapshot does not make a stale invoice current again.
      // Keep every flush blocked until reset() adopts the latest revision.
      throw new Error(currentSaveError ?? "Invoice changed on disk.");
    }

    const working = workingRef.current;
    if (!working.invoiceId || working.changeVersion === working.savedVersion) {
      if (mountedRef.current) setStatus("saved");
      return null;
    }

    const currentSignature = rowsSignature(working.rows);
    if (currentSignature === working.savedSignature) {
      working.savedVersion = working.changeVersion;
      if (mountedRef.current) setStatus("saved");
      return null;
    }

    const generation = generationRef.current;
    const invoiceId = working.invoiceId;
    const revision = working.revision;
    const changeVersion = working.changeVersion;
    const rows = structuredClone(working.rows);
    if (mountedRef.current) {
      setStatus("saving");
      setSaveError(null);
      saveErrorRef.current = null;
    }

    const task = window.receiptApp.saveRows(invoiceId, rows, revision);
    inFlightRef.current = task;
    inFlightGenerationRef.current = generation;

    let savedDocument: InvoiceDocument;
    try {
      savedDocument = await task;
      if (generation === generationRef.current && invoiceId === workingRef.current.invoiceId) {
        workingRef.current.revision = savedDocument.revision;
        workingRef.current.savedVersion = changeVersion;
        workingRef.current.savedSignature = rowsSignature(savedDocument.rows);
        if (mountedRef.current) {
          const hasQueuedRows =
            workingRef.current.changeVersion !== workingRef.current.savedVersion;
          setStatus(hasQueuedRows ? "dirty" : "saved");
          onSavedRef.current(savedDocument);
        }
      }
    } catch (error) {
      if (generation === generationRef.current && mountedRef.current) {
        const message = error instanceof Error ? error.message : "Could not save changes.";
        setStatus("error");
        setSaveError(message);
        saveErrorRef.current = message;
        onErrorRef.current(error);
      }
      throw error;
    } finally {
      if (inFlightRef.current === task) {
        inFlightRef.current = null;
        inFlightGenerationRef.current = null;
      }
      if (
        generation === generationRef.current &&
        workingRef.current.changeVersion !== workingRef.current.savedVersion &&
        mountedRef.current
      ) {
        setStatus((current) => (current === "error" ? current : "dirty"));
      }
    }

    // A row edit or sort can be staged while the prior revision is in flight.
    // `flush` must not resolve until that newer order is durable, otherwise an
    // immediately following copy/export/PDF build could read the old sequence.
    if (
      generation === generationRef.current &&
      invoiceId === workingRef.current.invoiceId &&
      workingRef.current.changeVersion !== workingRef.current.savedVersion
    ) {
      return persist();
    }
    return savedDocument;
  }, []);

  const reset = useCallback((invoice: InvoiceDocument | null) => {
    generationRef.current += 1;
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    workingRef.current = invoice
      ? {
          invoiceId: invoice.id,
          revision: invoice.revision,
          rows: structuredClone(invoice.rows),
          changeVersion: 0,
          savedVersion: 0,
          savedSignature: rowsSignature(invoice.rows),
        }
      : {
          invoiceId: null,
          revision: 0,
          rows: [],
          changeVersion: 0,
          savedVersion: 0,
          savedSignature: "[]",
        };
    setStatus("saved");
    setSaveError(null);
    saveErrorRef.current = null;
  }, []);

  const stage = useCallback(
    (rows: InvoiceRow[]) => {
      // Renderer rows are immutable snapshots. Keep the reference on the hot
      // input path and clone once, when the debounce actually persists it.
      workingRef.current.rows = rows;
      workingRef.current.changeVersion += 1;
      if (isRevisionConflict(saveErrorRef.current)) {
        if (timeoutRef.current) clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
        setStatus("error");
        return;
      }
      saveErrorRef.current = null;
      setSaveError(null);
      setStatus("dirty");
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => {
        void persist().catch(() => undefined);
      }, 650);
    },
    [persist]
  );

  const flush = useCallback(async () => persist(), [persist]);

  const retry = useCallback(() => {
    void persist().catch(() => undefined);
  }, [persist]);

  return { status, saveError, reset, stage, flush, retry };
}
