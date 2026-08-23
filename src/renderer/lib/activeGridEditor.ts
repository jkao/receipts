export type ActiveGridEditorCommit = "none" | "committed" | "invalid";

/**
 * Commit the focused React Data Grid editor before an action can replace or
 * lock the grid. Editor blur handlers synchronously hand valid drafts to RDG;
 * invalid drafts remain focused and visible for correction.
 */
export function commitActiveGridEditor(gridContainer: HTMLElement | null): ActiveGridEditorCommit {
  const activeElement = document.activeElement;
  if (!(activeElement instanceof HTMLInputElement) || !gridContainer?.contains(activeElement)) {
    return "none";
  }
  if (activeElement.getAttribute("aria-invalid") === "true" || !activeElement.checkValidity()) {
    activeElement.reportValidity();
    activeElement.focus({ preventScroll: true });
    return "invalid";
  }
  activeElement.blur();
  return "committed";
}
