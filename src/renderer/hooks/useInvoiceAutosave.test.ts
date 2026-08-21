import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InvoiceDocument, InvoiceRow } from "../../shared/types";

const reactEffects = vi.hoisted(() => ({ cleanups: [] as Array<() => void> }));

vi.mock("react", () => ({
  useCallback: <T extends (...args: never[]) => unknown>(callback: T) => callback,
  useEffect: (effect: () => unknown) => {
    const cleanup = effect();
    if (typeof cleanup === "function") reactEffects.cleanups.push(cleanup as () => void);
  },
  useRef: <T>(value: T) => ({ current: value }),
  useState: <T>(value: T) => [value, () => undefined],
}));

import { useInvoiceAutosave } from "./useInvoiceAutosave";

function row(id: string): InvoiceRow {
  return {
    id,
    date: "2026-06-15",
    groceriesMinor: null,
    hours: "",
    rateMinor: 4_500,
    comment: id,
    receiptId: null,
  };
}

function invoice(id: string, revision: number, rows: InvoiceRow[]): InvoiceDocument {
  return {
    schemaVersion: 1,
    id,
    name: id,
    period: { startDate: "2026-06-01", endDate: "2026-06-30" },
    defaultRateMinor: 4_500,
    currency: "USD",
    revision,
    rows,
    receipts: [],
    reviewAcknowledgements: [],
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe("useInvoiceAutosave", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    reactEffects.cleanups = [];
  });

  it("drains a new invoice after an older generation's in-flight save fails", async () => {
    const oldSave = deferred<InvoiceDocument>();
    const newSave = deferred<InvoiceDocument>();
    const saveRows = vi
      .fn()
      .mockReturnValueOnce(oldSave.promise)
      .mockReturnValueOnce(newSave.promise);
    vi.stubGlobal("window", { receiptApp: { saveRows } });
    const onError = vi.fn();
    const autosave = useInvoiceAutosave({ onSaved: vi.fn(), onError });

    autosave.reset(invoice("invoice-a", 1, []));
    autosave.stage([row("a")]);
    const oldFlush = autosave.flush();
    const oldFailure = expect(oldFlush).rejects.toThrow("old save failed");
    expect(saveRows).toHaveBeenCalledWith("invoice-a", [row("a")], 1);

    autosave.reset(invoice("invoice-b", 4, []));
    autosave.stage([row("b")]);
    const newFlush = autosave.flush();
    oldSave.reject(new Error("old save failed"));
    await oldFailure;

    await vi.waitFor(() => expect(saveRows).toHaveBeenCalledTimes(2));
    expect(saveRows).toHaveBeenLastCalledWith("invoice-b", [row("b")], 4);
    newSave.resolve(invoice("invoice-b", 5, [row("b")]));
    await expect(newFlush).resolves.toMatchObject({ id: "invoice-b", revision: 5 });
    expect(onError).not.toHaveBeenCalled();
  });

  it("surfaces a current-generation failure and permits an explicit retry", async () => {
    const saveRows = vi
      .fn()
      .mockRejectedValueOnce(new Error("disk unavailable"))
      .mockResolvedValueOnce(invoice("invoice-a", 2, [row("a")]));
    vi.stubGlobal("window", { receiptApp: { saveRows } });
    const onError = vi.fn();
    const autosave = useInvoiceAutosave({ onSaved: vi.fn(), onError });

    autosave.reset(invoice("invoice-a", 1, []));
    autosave.stage([row("a")]);
    await expect(autosave.flush()).rejects.toThrow("disk unavailable");
    expect(onError).toHaveBeenCalledOnce();

    await expect(autosave.flush()).resolves.toMatchObject({ revision: 2 });
    expect(saveRows).toHaveBeenCalledTimes(2);
  });

  it("keeps a revision conflict blocking flushes until the invoice is reset", async () => {
    const conflict = "Invoice changed: expected revision 1, found 2.";
    const saveRows = vi.fn().mockRejectedValue(new Error(conflict));
    vi.stubGlobal("window", { receiptApp: { saveRows } });
    const autosave = useInvoiceAutosave({ onSaved: vi.fn(), onError: vi.fn() });

    autosave.reset(invoice("invoice-a", 1, []));
    autosave.stage([row("a")]);
    await expect(autosave.flush()).rejects.toThrow(conflict);

    // Reverting to the revision-one row snapshot must not claim that the
    // revision-one document is current when revision two exists on disk.
    autosave.stage([]);
    await expect(autosave.flush()).rejects.toThrow(conflict);
    expect(saveRows).toHaveBeenCalledOnce();

    autosave.reset(invoice("invoice-a", 2, []));
    await expect(autosave.flush()).resolves.toBeNull();
  });

  it("does not notify its owner after unmount while a save is in flight", async () => {
    const pendingSave = deferred<InvoiceDocument>();
    vi.stubGlobal("window", {
      receiptApp: { saveRows: vi.fn().mockReturnValue(pendingSave.promise) },
    });
    const onSaved = vi.fn();
    const autosave = useInvoiceAutosave({ onSaved, onError: vi.fn() });

    autosave.reset(invoice("invoice-a", 1, []));
    autosave.stage([row("a")]);
    const flush = autosave.flush();
    for (const cleanup of reactEffects.cleanups) cleanup();

    pendingSave.resolve(invoice("invoice-a", 2, [row("a")]));
    await flush;
    expect(onSaved).not.toHaveBeenCalled();
  });
});
