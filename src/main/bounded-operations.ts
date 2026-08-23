function assertConcurrency(concurrency: number): void {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new RangeError("Concurrency must be a positive safe integer.");
  }
}

interface PermitWaiter {
  resolve: (release: () => void) => void;
  reject: (reason?: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/**
 * Share a fixed concurrency budget across otherwise independent batches.
 * Waiting callers can be aborted without consuming or leaking a permit.
 */
export class ConcurrencyLimiter {
  private available: number;
  private readonly waiters: PermitWaiter[] = [];

  constructor(concurrency: number) {
    assertConcurrency(concurrency);
    this.available = concurrency;
  }

  async run<Output>(operation: () => Promise<Output>, signal?: AbortSignal): Promise<Output> {
    const release = await this.acquire(signal);
    try {
      signal?.throwIfAborted();
      return await operation();
    } finally {
      release();
    }
  }

  private acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.available > 0) {
      this.available -= 1;
      return Promise.resolve(this.releaseOnce());
    }

    return new Promise((resolve, reject) => {
      const waiter: PermitWaiter = { resolve, reject, signal };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(signal.reason);
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  private releaseOnce(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;

      while (this.waiters.length > 0) {
        const waiter = this.waiters.shift();
        if (!waiter) break;
        if (waiter.signal && waiter.onAbort) {
          waiter.signal.removeEventListener("abort", waiter.onAbort);
        }
        if (waiter.signal?.aborted) {
          waiter.reject(waiter.signal.reason);
          continue;
        }
        waiter.resolve(this.releaseOnce());
        return;
      }
      this.available += 1;
    };
  }
}

/**
 * Map asynchronous work through a fixed-size worker pool while preserving
 * input order. Workers settle the whole batch before surfacing the first
 * input-ordered failure, so callers can safely clean up shared staging areas.
 */
export async function mapBounded<Input, Output>(
  inputs: readonly Input[],
  concurrency: number,
  operation: (input: Input, index: number) => Promise<Output>
): Promise<Output[]> {
  assertConcurrency(concurrency);
  if (inputs.length === 0) return [];

  const results = new Array<PromiseSettledResult<Output>>(inputs.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < inputs.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = {
          status: "fulfilled",
          value: await operation(inputs[index], index),
        };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, inputs.length) }, () => worker()));
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected"
  );
  if (failure) throw failure.reason;
  return results.map((result) => (result as PromiseFulfilledResult<Output>).value);
}

export async function runBounded(
  operations: readonly (() => Promise<void>)[],
  concurrency: number
): Promise<void> {
  await mapBounded(operations, concurrency, (operation) => operation());
}
