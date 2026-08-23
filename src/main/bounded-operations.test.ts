import { describe, expect, it, vi } from "vitest";
import { ConcurrencyLimiter, mapBounded, runBounded } from "./bounded-operations";

describe("bounded asynchronous operations", () => {
  it("preserves result order while limiting concurrency", async () => {
    let active = 0;
    let maximumActive = 0;
    const values = await mapBounded([5, 4, 3, 2, 1], 2, async (value) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolve) => setImmediate(resolve));
      active -= 1;
      return value * 2;
    });

    expect(values).toEqual([10, 8, 6, 4, 2]);
    expect(maximumActive).toBe(2);
  });

  it("settles later work before surfacing the first input-ordered failure", async () => {
    const completed: number[] = [];
    const operations = [0, 1, 2].map((index) => async () => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      completed.push(index);
      if (index < 2) throw new Error(`failure-${index}`);
    });

    await expect(runBounded(operations, 2)).rejects.toThrow("failure-0");
    expect(completed.sort()).toEqual([0, 1, 2]);
  });

  it("validates its limit and handles an empty batch", async () => {
    await expect(mapBounded([], 2, async () => undefined)).resolves.toEqual([]);
    await expect(mapBounded([1], 0, async () => undefined)).rejects.toThrow(
      "Concurrency must be a positive safe integer."
    );
    expect(() => new ConcurrencyLimiter(0)).toThrow("Concurrency must be a positive safe integer.");
  });

  it("removes an aborted waiter without leaking the shared permit", async () => {
    const limiter = new ConcurrencyLimiter(1);
    const firstStarted = deferred<void>();
    const releaseFirst = deferred<void>();
    const first = limiter.run(async () => {
      firstStarted.resolve();
      await releaseFirst.promise;
      return "first";
    });
    await firstStarted.promise;

    const controller = new AbortController();
    const cancelledOperation = vi.fn(async () => "cancelled");
    const cancelled = limiter.run(cancelledOperation, controller.signal);
    const cancellation = expect(cancelled).rejects.toThrow("cancelled while waiting");
    const nextOperation = vi.fn(async () => "next");
    const next = limiter.run(nextOperation);

    controller.abort(new Error("cancelled while waiting"));
    await cancellation;
    expect(cancelledOperation).not.toHaveBeenCalled();
    expect(nextOperation).not.toHaveBeenCalled();

    releaseFirst.resolve();
    await expect(first).resolves.toBe("first");
    await expect(next).resolves.toBe("next");
    expect(nextOperation).toHaveBeenCalledTimes(1);
  });
});

function deferred<Value>() {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
