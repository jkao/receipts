import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { invoiceRemovalNotification, RemoveInvoiceModal, removeInvoiceButtonLabel } from "./App";

describe("RemoveInvoiceModal", () => {
  it("defaults to recoverable removal and explains the deletion sentinel", () => {
    const markup = renderToStaticMarkup(
      createElement(RemoveInvoiceModal, {
        busy: false,
        error: null,
        invoiceName: "invoice-2026-08-01-2026-08-31",
        onClose: vi.fn(),
        onRemove: vi.fn(),
      })
    );

    expect(markup).toContain("Remove Invoice?");
    expect(markup).toMatch(/<section[^>]*aria-describedby="[^"]+"[^>]*role="alertdialog"/);
    expect(markup).toContain("invoice-2026-08-01-2026-08-31");
    expect(markup).toContain("DELETED.json");
    expect(markup).toContain("Permanently delete this invoice folder and every local file");
    expect(markup).toMatch(/<input[^>]*type="checkbox"/);
    expect(markup).not.toMatch(/<input[^>]*type="checkbox"[^>]*checked/);
    expect(markup).toMatch(/<button[^>]*data-autofocus="true"[^>]*>Cancel<\/button>/);
    expect(markup).toMatch(/<button[^>]*type="submit"[^>]*>Remove Invoice<\/button>/);
  });

  it("locks every decision control and announces an error while removal is busy", () => {
    const markup = renderToStaticMarkup(
      createElement(RemoveInvoiceModal, {
        busy: true,
        error: "The invoice revision changed.",
        invoiceName: "August invoice",
        onClose: vi.fn(),
        onReload: vi.fn(),
        onRemove: vi.fn(),
      })
    );

    expect(markup.match(/disabled=""/g)).toHaveLength(5);
    expect(markup).toContain('<div class="form-error form-error--action" role="alert">');
    expect(markup).toContain("The invoice revision changed.");
    expect(markup).toContain("Reload Invoice…");
    expect(markup).toContain("Removing…");
  });

  it("uses unambiguous action labels for soft and permanent removal", () => {
    expect(removeInvoiceButtonLabel(false, false)).toBe("Remove Invoice");
    expect(removeInvoiceButtonLabel(false, true)).toBe("Removing…");
    expect(removeInvoiceButtonLabel(true, false)).toBe("Permanently Delete Invoice");
    expect(removeInvoiceButtonLabel(true, true)).toBe("Permanently Deleting…");
  });

  it("does not claim files were kept when permanent deletion only partially succeeds", () => {
    const notification = invoiceRemovalNotification({
      invoiceId: "invoice-1",
      invoiceName: "August invoice",
      mode: "soft",
      deletedAt: "2026-08-21T12:00:00.000Z",
      warning: "Some files could not be removed. The invoice remains hidden.",
    });

    expect(notification).toEqual({
      message:
        "August invoice was removed from the app, but permanent deletion was incomplete: Some files could not be removed. The invoice remains hidden.",
      tone: "error",
    });
    expect(notification.message).not.toContain("files were kept");
  });

  it("reports normal soft and hard removal accurately", () => {
    const base = {
      invoiceId: "invoice-1",
      invoiceName: "August invoice",
      deletedAt: "2026-08-21T12:00:00.000Z",
    } as const;

    expect(invoiceRemovalNotification({ ...base, mode: "soft" })).toEqual({
      message: "Removed August invoice. Its local files were kept.",
      tone: "success",
    });
    expect(invoiceRemovalNotification({ ...base, mode: "hard" })).toEqual({
      message: "Permanently deleted August invoice and its local files.",
      tone: "success",
    });
  });
});
