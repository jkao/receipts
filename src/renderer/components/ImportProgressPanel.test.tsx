// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ImportProgress } from "../../shared/types";
import { ImportProgressPanel, importProgressLabel } from "./ImportProgressPanel";

afterEach(cleanup);

describe("ImportProgressPanel", () => {
  it("shows determinate progress and offers cancellation for an active job", () => {
    const onCancel = vi.fn();
    render(
      <ImportProgressPanel cancelling={false} progress={progress("scanning")} onCancel={onCancel} />
    );

    expect(screen.getByRole("status").textContent).toContain("2 of 4");
    const cancel = screen.getByRole("button", { name: "Cancel scan" });
    fireEvent.click(cancel);
    expect(onCancel).toHaveBeenCalledWith("job-1");
  });

  it("keeps terminal refresh state non-cancelable", () => {
    render(
      <ImportProgressPanel cancelling={false} progress={progress("complete")} onCancel={vi.fn()} />
    );

    expect(screen.getByRole("status").textContent).toContain("Finishing scan");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("uses clear labels for preparatory and terminal states", () => {
    expect(importProgressLabel("copying")).toBe("Copying");
    expect(importProgressLabel("duplicate")).toBe("Checking duplicate");
    expect(importProgressLabel("error")).toBe("Import issue");
    expect(importProgressLabel("queued")).toBe("Waiting to scan");
    expect(importProgressLabel("needs-key")).toBe("Needs OpenAI key");
    expect(importProgressLabel("cancelled")).toBe("Finishing cancellation");
    expect(importProgressLabel("failed")).toBe("Import failed");
    expect(importProgressLabel("ready")).toBe("Receipt scanned");
  });
});

function progress(status: ImportProgress["status"]): ImportProgress {
  return {
    jobId: "job-1",
    invoiceId: "invoice-1",
    current: 2,
    total: 4,
    filename: "receipt.png",
    status,
  };
}
