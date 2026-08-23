// @vitest-environment happy-dom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopApi, ImportProgress } from "../../shared/types";
import { isTerminalImportProgress, useImportJobs } from "./useImportJobs";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("useImportJobs", () => {
  it("keeps a terminal job locked until its owner finishes refreshing", async () => {
    let progressListener: (progress: ImportProgress) => void = () => undefined;
    const unsubscribe = vi.fn();
    Object.defineProperty(window, "receiptApp", {
      configurable: true,
      value: {
        onImportProgress: vi.fn((listener) => {
          progressListener = listener;
          return unsubscribe;
        }),
      } as Partial<DesktopApi>,
    });
    let finishRefresh: () => void = () => undefined;
    const refresh = new Promise<void>((resolve) => {
      finishRefresh = resolve;
    });
    const onTerminal = vi.fn(() => refresh);
    const { result, unmount } = renderHook(() =>
      useImportJobs({ onLegacyProgress: vi.fn(), onTerminal })
    );

    act(() => {
      result.current.registerJob({ jobId: "job-1", invoiceId: "invoice-1", total: 1 });
      progressListener(progress("scanning"));
    });
    expect(result.current.jobs.get("job-1")?.status).toBe("scanning");
    expect(result.current.isInvoiceImporting("invoice-1")).toBe(true);

    const completed = progress("complete");
    act(() => {
      progressListener(completed);
    });
    expect(result.current.jobs.get("job-1")?.status).toBe("complete");
    expect(onTerminal).toHaveBeenCalledOnce();
    expect(onTerminal).toHaveBeenCalledWith(completed, {
      hasOtherJobsForInvoice: false,
      wasRegistered: true,
    });

    await act(async () => {
      finishRefresh();
      await refresh;
    });
    await waitFor(() => expect(result.current.jobs.size).toBe(0));

    let registered = true;
    act(() => {
      registered = result.current.registerJob({
        jobId: "job-1",
        invoiceId: "invoice-1",
        total: 1,
      });
    });
    expect(registered).toBe(false);
    expect(result.current.jobs.size).toBe(0);
    unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("cancels a registered job and forwards legacy progress", async () => {
    let progressListener: (progress: ImportProgress) => void = () => undefined;
    const cancelImport = vi.fn().mockResolvedValue({ jobId: "job-1", cancelled: true });
    const onLegacyProgress = vi.fn();
    Object.defineProperty(window, "receiptApp", {
      configurable: true,
      value: {
        cancelImport,
        onImportProgress: vi.fn((listener) => {
          progressListener = listener;
          return () => undefined;
        }),
      } as Partial<DesktopApi>,
    });
    const { result } = renderHook(() => useImportJobs({ onLegacyProgress, onTerminal: vi.fn() }));

    act(() => {
      result.current.registerJob({ jobId: "job-1", invoiceId: "invoice-1", total: 2 });
      progressListener({
        invoiceId: "invoice-1",
        current: 1,
        total: 2,
        filename: "legacy.png",
        status: "ready",
      });
    });
    await expect(result.current.cancelJob("job-1")).resolves.toBe(true);
    expect(cancelImport).toHaveBeenCalledWith("job-1");
    expect(onLegacyProgress).toHaveBeenCalledOnce();
  });

  it("tells terminal refreshes when another job still owns the invoice", async () => {
    let progressListener: (progress: ImportProgress) => void = () => undefined;
    const onTerminal = vi.fn();
    Object.defineProperty(window, "receiptApp", {
      configurable: true,
      value: {
        onImportProgress: vi.fn((listener) => {
          progressListener = listener;
          return () => undefined;
        }),
      } as Partial<DesktopApi>,
    });
    const { result } = renderHook(() => useImportJobs({ onLegacyProgress: vi.fn(), onTerminal }));

    act(() => {
      result.current.registerJob({ jobId: "job-1", invoiceId: "invoice-1", total: 1 });
      result.current.registerJob({ jobId: "job-2", invoiceId: "invoice-1", total: 1 });
      progressListener(progress("scanning"));
      progressListener({ ...progress("queued"), jobId: "job-2" });
      progressListener(progress("complete"));
    });

    expect(onTerminal).toHaveBeenCalledWith(expect.anything(), {
      hasOtherJobsForInvoice: true,
      wasRegistered: true,
    });
    await waitFor(() => expect(result.current.jobs.has("job-1")).toBe(false));
    expect(result.current.jobs.has("job-2")).toBe(true);
  });

  it("recognizes only explicit terminal statuses", () => {
    expect(isTerminalImportProgress(progress("complete"))).toBe(true);
    expect(isTerminalImportProgress(progress("cancelled"))).toBe(true);
    expect(isTerminalImportProgress(progress("failed"))).toBe(true);
    expect(isTerminalImportProgress(progress("error"))).toBe(false);
  });

  it("does not expose an unregistered preparation job as cancelable", async () => {
    let progressListener: (progress: ImportProgress) => void = () => undefined;
    const cancelImport = vi.fn();
    const onTerminal = vi.fn();
    const onLegacyProgress = vi.fn();
    Object.defineProperty(window, "receiptApp", {
      configurable: true,
      value: {
        cancelImport,
        onImportProgress: vi.fn((listener) => {
          progressListener = listener;
          return () => undefined;
        }),
      } as Partial<DesktopApi>,
    });
    const { result } = renderHook(() => useImportJobs({ onLegacyProgress, onTerminal }));

    act(() => {
      progressListener({ ...progress("copying"), current: 0 });
    });
    expect(result.current.jobs.size).toBe(0);
    expect(onLegacyProgress).toHaveBeenCalledWith({
      invoiceId: "invoice-1",
      current: 0,
      total: 1,
      filename: "receipt.png",
      status: "copying",
    });
    await expect(result.current.cancelJob("job-1")).resolves.toBe(false);
    expect(cancelImport).not.toHaveBeenCalled();

    const failed = progress("failed");
    act(() => progressListener(failed));
    expect(onTerminal).toHaveBeenCalledWith(failed, {
      hasOtherJobsForInvoice: false,
      wasRegistered: false,
    });
    expect(result.current.registerJob({ jobId: "job-1", invoiceId: "invoice-1", total: 1 })).toBe(
      false
    );
  });
});

function progress(status: ImportProgress["status"]): ImportProgress {
  return {
    jobId: "job-1",
    invoiceId: "invoice-1",
    current: 1,
    total: 1,
    filename: "receipt.png",
    status,
  };
}
