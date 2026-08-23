// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { commitActiveGridEditor } from "./activeGridEditor";

afterEach(() => {
  document.body.replaceChildren();
});

describe("active grid editor commit", () => {
  it("blurs a valid focused grid input so its editor can commit", () => {
    const grid = document.createElement("section");
    const input = document.createElement("input");
    const blur = vi.fn();
    input.addEventListener("blur", blur);
    grid.append(input);
    document.body.append(grid);
    input.focus();

    expect(commitActiveGridEditor(grid)).toBe("committed");
    expect(blur).toHaveBeenCalledOnce();
  });

  it("keeps an invalid focused draft open", () => {
    const grid = document.createElement("section");
    const input = document.createElement("input");
    input.setAttribute("aria-invalid", "true");
    const blur = vi.fn();
    input.addEventListener("blur", blur);
    grid.append(input);
    document.body.append(grid);
    input.focus();

    expect(commitActiveGridEditor(grid)).toBe("invalid");
    expect(blur).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(input);
  });

  it("ignores focus outside the invoice grid", () => {
    const grid = document.createElement("section");
    const input = document.createElement("input");
    document.body.append(grid, input);
    input.focus();

    expect(commitActiveGridEditor(grid)).toBe("none");
  });
});
