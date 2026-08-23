// @vitest-environment happy-dom

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ORDINARY_TOAST_DURATION_MS,
  type ToastMessage,
  ToastRegion,
  toastAutoDismissDelay,
} from "./ToastRegion";

afterEach(() => {
  vi.useRealTimers();
});

describe("ToastRegion", () => {
  it("keeps errors and action notifications persistent", () => {
    expect(toastAutoDismissDelay({ tone: "error" })).toBeNull();
    expect(
      toastAutoDismissDelay({ tone: "neutral", action: { label: "Undo", run: vi.fn() } })
    ).toBeNull();
    expect(toastAutoDismissDelay({ tone: "success" })).toBe(ORDINARY_TOAST_DURATION_MS);
  });

  it("pauses an ordinary notification while the pointer is over it", () => {
    vi.useFakeTimers();
    const dismiss = vi.fn();
    const toast: ToastMessage = { id: "toast-1", message: "Saved", tone: "success" };
    const { container } = render(<ToastRegion dismiss={dismiss} toasts={[toast]} />);
    const toastElement = container.querySelector(".toast");
    if (!toastElement) throw new Error("Expected toast element");

    act(() => vi.advanceTimersByTime(2_000));
    fireEvent.pointerEnter(toastElement);
    act(() => vi.advanceTimersByTime(20_000));
    expect(dismiss).not.toHaveBeenCalled();

    fireEvent.pointerLeave(toastElement);
    act(() => vi.advanceTimersByTime(2_999));
    expect(dismiss).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(dismiss).toHaveBeenCalledWith("toast-1");
  });

  it("pauses while focused and runs an action only after explicit activation", () => {
    vi.useFakeTimers();
    const dismiss = vi.fn();
    const run = vi.fn();
    const toast: ToastMessage = {
      id: "toast-2",
      message: "Rows deleted",
      tone: "neutral",
      action: { label: "Undo", run },
    };
    render(<ToastRegion dismiss={dismiss} toasts={[toast]} />);

    const undo = screen.getByRole("button", { name: "Undo" });
    fireEvent.focus(undo);
    act(() => vi.advanceTimersByTime(60_000));
    expect(dismiss).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();

    fireEvent.click(undo);
    expect(dismiss).toHaveBeenCalledWith("toast-2");
    expect(run).toHaveBeenCalledOnce();
  });
});
