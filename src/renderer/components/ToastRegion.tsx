import { useCallback, useEffect, useRef } from "react";

export type ToastTone = "success" | "error" | "neutral";

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface ToastMessage {
  id: string;
  message: string;
  tone: ToastTone;
  action?: ToastAction;
}

export const ORDINARY_TOAST_DURATION_MS = 5_000;

export function toastAutoDismissDelay(toast: Pick<ToastMessage, "tone" | "action">): number | null {
  return toast.tone === "error" || toast.action ? null : ORDINARY_TOAST_DURATION_MS;
}

function ToastItem({ toast, dismiss }: { toast: ToastMessage; dismiss: (id: string) => void }) {
  const delay = toastAutoDismissDelay(toast);
  const remainingRef = useRef<number | null>(delay);
  const startedAtRef = useRef<number | null>(null);
  const timerRef = useRef<number | null>(null);

  const clearTimer = useCallback((trackElapsed: boolean) => {
    if (timerRef.current === null) return;
    window.clearTimeout(timerRef.current);
    timerRef.current = null;
    if (trackElapsed && remainingRef.current !== null && startedAtRef.current !== null) {
      remainingRef.current = Math.max(
        0,
        remainingRef.current - (Date.now() - startedAtRef.current)
      );
    }
    startedAtRef.current = null;
  }, []);

  const startTimer = useCallback(() => {
    const remaining = remainingRef.current;
    if (remaining === null || timerRef.current !== null) return;
    if (remaining <= 0) {
      dismiss(toast.id);
      return;
    }
    startedAtRef.current = Date.now();
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      startedAtRef.current = null;
      remainingRef.current = 0;
      dismiss(toast.id);
    }, remaining);
  }, [dismiss, toast.id]);

  useEffect(() => {
    remainingRef.current = delay;
    startTimer();
    return () => clearTimer(false);
  }, [clearTimer, delay, startTimer]);

  return (
    <fieldset
      aria-label="Notification"
      className={`toast toast--${toast.tone}`}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) startTimer();
      }}
      onFocus={clearTimer.bind(null, true)}
      onPointerEnter={clearTimer.bind(null, true)}
      onPointerLeave={startTimer}
    >
      <span className="toast-icon" aria-hidden="true">
        {toast.tone === "success" ? "✓" : toast.tone === "error" ? "!" : "i"}
      </span>
      <span role={toast.tone === "error" ? "alert" : "status"}>{toast.message}</span>
      {toast.action ? (
        <button
          className="toast-action"
          type="button"
          onClick={() => {
            dismiss(toast.id);
            toast.action?.run();
          }}
        >
          {toast.action.label}
        </button>
      ) : null}
      <button
        aria-label="Dismiss message"
        className="toast-close"
        type="button"
        onClick={() => dismiss(toast.id)}
      >
        ×
      </button>
    </fieldset>
  );
}

export function ToastRegion({
  toasts,
  dismiss,
}: {
  toasts: ToastMessage[];
  dismiss: (id: string) => void;
}) {
  return (
    <section className="toast-region" aria-label="Notifications">
      {toasts.map((toast) => (
        <ToastItem dismiss={dismiss} key={toast.id} toast={toast} />
      ))}
    </section>
  );
}
