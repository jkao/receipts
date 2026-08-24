import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ExportModal, SettingsModal } from "./InvoiceModals";
import { Onboarding } from "./Onboarding";

describe("invoice UX messaging", () => {
  it("distinguishes spreadsheet package export from client PDF output", () => {
    const markup = renderToStaticMarkup(
      createElement(ExportModal, {
        busy: false,
        onClose: vi.fn(),
        onExport: vi.fn(),
      })
    );

    expect(markup).toContain("Export Spreadsheet Package");
    expect(markup).toContain("TSV and CSV");
    expect(markup).toContain("does not include the client PDF");
    expect(markup).toContain("Build PDF Output");
    expect(markup).not.toContain("Export Invoice");
  });

  it("shows the OpenAI receipt-upload disclosure in onboarding and settings", () => {
    const onboarding = renderToStaticMarkup(
      createElement(Onboarding, {
        busy: false,
        error: null,
        onChooseFolder: vi.fn(),
      })
    );
    const settings = renderToStaticMarkup(
      createElement(SettingsModal, {
        settings: {
          baseFolder: "/Invoices",
          hasOpenAiKey: true,
          defaultRateMinor: 4_500,
        },
        onClose: vi.fn(),
        onSettingsChange: vi.fn(),
        onChooseFolder: vi.fn(),
      })
    );

    for (const markup of [onboarding, settings]) {
      expect(markup).toContain("OpenAI receipt upload");
      expect(markup).toContain("sends each receipt image or PDF to OpenAI");
    }
  });

  it("makes the invoice state path visible and changeable", () => {
    const baseFolder = "/Users/example/Library/CloudStorage/Drive/Receipts and Invoices";
    const markup = renderToStaticMarkup(
      createElement(SettingsModal, {
        settings: {
          baseFolder,
          hasOpenAiKey: false,
          defaultRateMinor: 4_500,
        },
        onClose: vi.fn(),
        onSettingsChange: vi.fn(),
        onChooseFolder: vi.fn(),
      })
    );

    expect(markup).toContain(`title="${baseFolder}"`);
    expect(markup).toContain("Invoice state folder");
    expect(markup).toContain("does not move files from the current folder");
    expect(markup).toContain("Show full path");
    expect(markup).toContain("Change…");
    expect(markup).toContain('aria-expanded="false"');
  });
});
