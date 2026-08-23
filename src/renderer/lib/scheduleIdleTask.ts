interface IdleTaskScheduler {
  setTimeout(callback: () => void, delayMs: number): number;
  clearTimeout(timeoutId: number): void;
  requestIdleCallback?: (callback: () => void, options: { timeout: number }) => number;
  cancelIdleCallback?: (callbackId: number) => void;
}

interface IdleTaskOptions {
  delayMs?: number;
  timeoutMs?: number;
}

export function scheduleIdleTask(
  task: () => void,
  { delayMs = 250, timeoutMs = 1_000 }: IdleTaskOptions = {},
  scheduler: IdleTaskScheduler = window
): () => void {
  let cancelled = false;
  let idleCallbackId: number | null = null;
  const run = () => {
    if (!cancelled) task();
  };
  const delayId = scheduler.setTimeout(() => {
    if (cancelled) return;
    idleCallbackId = scheduler.requestIdleCallback?.(run, { timeout: timeoutMs }) ?? null;
    if (idleCallbackId === null) run();
  }, delayMs);

  return () => {
    cancelled = true;
    scheduler.clearTimeout(delayId);
    if (idleCallbackId !== null) scheduler.cancelIdleCallback?.(idleCallbackId);
  };
}
