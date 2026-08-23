import { describe, expect, it, vi } from "vitest";
import { scheduleIdleTask } from "./scheduleIdleTask";

function scheduler() {
  let timeoutCallback: (() => void) | null = null;
  let idleCallback: (() => void) | null = null;
  const value = {
    setTimeout: vi.fn((callback: () => void) => {
      timeoutCallback = callback;
      return 11;
    }),
    clearTimeout: vi.fn(),
    requestIdleCallback: vi.fn((callback: () => void) => {
      idleCallback = callback;
      return 22;
    }),
    cancelIdleCallback: vi.fn(),
  };
  return {
    value,
    runDelay: () => timeoutCallback?.(),
    runIdle: () => idleCallback?.(),
  };
}

describe("scheduleIdleTask", () => {
  it("waits for both the debounce and an idle turn", () => {
    const host = scheduler();
    const task = vi.fn();
    scheduleIdleTask(task, { delayMs: 300, timeoutMs: 900 }, host.value);

    expect(host.value.setTimeout).toHaveBeenCalledWith(expect.any(Function), 300);
    expect(task).not.toHaveBeenCalled();
    host.runDelay();
    expect(host.value.requestIdleCallback).toHaveBeenCalledWith(expect.any(Function), {
      timeout: 900,
    });
    expect(task).not.toHaveBeenCalled();
    host.runIdle();
    expect(task).toHaveBeenCalledOnce();
  });

  it("cancels queued work when a newer revision supersedes it", () => {
    const host = scheduler();
    const task = vi.fn();
    const cancel = scheduleIdleTask(task, {}, host.value);
    host.runDelay();
    cancel();
    host.runIdle();

    expect(host.value.clearTimeout).toHaveBeenCalledWith(11);
    expect(host.value.cancelIdleCallback).toHaveBeenCalledWith(22);
    expect(task).not.toHaveBeenCalled();
  });

  it("runs after the debounce when idle callbacks are unavailable", () => {
    const host = scheduler();
    const task = vi.fn();
    scheduleIdleTask(
      task,
      {},
      {
        setTimeout: host.value.setTimeout,
        clearTimeout: host.value.clearTimeout,
      }
    );
    host.runDelay();

    expect(task).toHaveBeenCalledOnce();
  });
});
