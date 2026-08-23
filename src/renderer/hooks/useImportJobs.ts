import { useCallback, useEffect, useRef, useState } from "react";
import type { ImportProgress } from "../../shared/types";

interface ImportJobRegistration {
  jobId: string;
  invoiceId: string;
  total: number;
  filename?: string;
}

interface ImportJobOptions {
  onLegacyProgress: (progress: ImportProgress) => void;
  onTerminal: (
    progress: ImportProgress,
    context: { hasOtherJobsForInvoice: boolean; wasRegistered: boolean }
  ) => Promise<void> | void;
}

export function isTerminalImportProgress(progress: ImportProgress): boolean {
  return (
    progress.status === "complete" ||
    progress.status === "cancelled" ||
    progress.status === "failed"
  );
}

export function useImportJobs({ onLegacyProgress, onTerminal }: ImportJobOptions) {
  const [jobs, setJobs] = useState<ReadonlyMap<string, ImportProgress>>(new Map());
  const [cancellingJobIds, setCancellingJobIds] = useState<ReadonlySet<string>>(new Set());
  const jobsRef = useRef(jobs);
  const registeredJobIdsRef = useRef(new Set<string>());
  const finishedJobIdsRef = useRef(new Set<string>());
  const onLegacyProgressRef = useRef(onLegacyProgress);
  const onTerminalRef = useRef(onTerminal);

  useEffect(() => {
    onLegacyProgressRef.current = onLegacyProgress;
    onTerminalRef.current = onTerminal;
  }, [onLegacyProgress, onTerminal]);

  const replaceJobs = useCallback(
    (update: (current: ReadonlyMap<string, ImportProgress>) => Map<string, ImportProgress>) => {
      const next = update(jobsRef.current);
      jobsRef.current = next;
      setJobs(next);
    },
    []
  );

  useEffect(() => {
    return window.receiptApp.onImportProgress((progress) => {
      if (!progress.jobId) {
        onLegacyProgressRef.current(progress);
        return;
      }
      const jobId = progress.jobId;

      if (isTerminalImportProgress(progress)) {
        if (finishedJobIdsRef.current.has(jobId)) return;
        finishedJobIdsRef.current.add(jobId);
        const wasRegistered = registeredJobIdsRef.current.has(jobId);
        const hasOtherJobsForInvoice = [...jobsRef.current.entries()].some(
          ([candidateId, candidate]) =>
            candidateId !== jobId && candidate.invoiceId === progress.invoiceId
        );
        replaceJobs((current) => new Map(current).set(jobId, progress));
        setCancellingJobIds((current) => {
          if (!current.has(jobId)) return current;
          const next = new Set(current);
          next.delete(jobId);
          return next;
        });
        void Promise.resolve(
          onTerminalRef.current(progress, { hasOtherJobsForInvoice, wasRegistered })
        )
          .catch(() => undefined)
          .finally(() => {
            registeredJobIdsRef.current.delete(jobId);
            replaceJobs((current) => {
              const next = new Map(current);
              next.delete(jobId);
              return next;
            });
          });
        return;
      }

      // Main may report hashing/copying before startImport has returned and
      // registered the job. App already presents its local preparation state;
      // ignoring these early events prevents offering cancellation for a job
      // that ImportManager cannot cancel yet.
      if (finishedJobIdsRef.current.has(jobId) || !registeredJobIdsRef.current.has(jobId)) {
        const { jobId: _jobId, ...preparationProgress } = progress;
        onLegacyProgressRef.current(preparationProgress);
        return;
      }
      replaceJobs((current) => new Map(current).set(jobId, progress));
    });
  }, [replaceJobs]);

  const registerJob = useCallback(
    ({ jobId, invoiceId, total, filename = "Receipt import" }: ImportJobRegistration) => {
      if (finishedJobIdsRef.current.has(jobId)) return false;
      registeredJobIdsRef.current.add(jobId);
      replaceJobs((current) => {
        if (current.has(jobId)) return new Map(current);
        return new Map(current).set(jobId, {
          jobId,
          invoiceId,
          current: 0,
          total,
          filename,
          status: "queued",
          message: "Waiting to scan.",
        });
      });
      return true;
    },
    [replaceJobs]
  );

  const cancelJob = useCallback(async (jobId: string): Promise<boolean> => {
    if (!registeredJobIdsRef.current.has(jobId)) return false;
    setCancellingJobIds((current) => new Set(current).add(jobId));
    try {
      const result = await window.receiptApp.cancelImport(jobId);
      if (result.cancelled) return true;
      setCancellingJobIds((current) => {
        const next = new Set(current);
        next.delete(jobId);
        return next;
      });
      return false;
    } catch (error) {
      setCancellingJobIds((current) => {
        const next = new Set(current);
        next.delete(jobId);
        return next;
      });
      throw error;
    }
  }, []);

  const isInvoiceImporting = useCallback(
    (invoiceId: string) =>
      [...jobsRef.current.values()].some((progress) => progress.invoiceId === invoiceId),
    []
  );

  return { cancelJob, cancellingJobIds, isInvoiceImporting, jobs, registerJob };
}
