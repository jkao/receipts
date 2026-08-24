import { type ReactNode, useEffect, useId, useRef } from "react";

interface ModalFrameProps {
  title: string;
  eyebrow?: string;
  children: ReactNode;
  className?: string;
  headerActions?: ReactNode;
  closeDisabled?: boolean;
  descriptionId?: string;
  onClose: () => void;
  role?: "alertdialog" | "dialog";
  wide?: boolean;
}

export function ModalFrame({
  title,
  eyebrow,
  children,
  className,
  headerActions,
  closeDisabled = false,
  descriptionId,
  onClose,
  role = "dialog",
  wide = false,
}: ModalFrameProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  const closeDisabledRef = useRef(closeDisabled);

  useEffect(() => {
    onCloseRef.current = onClose;
    closeDisabledRef.current = closeDisabled;
  }, [closeDisabled, onClose]);

  useEffect(() => {
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const focusableSelector =
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';
    const focusableElements = () =>
      dialog
        ? Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector)).filter(
            (element) => !element.hasAttribute("disabled") && element.getClientRects().length > 0
          )
        : [];
    const preferred = dialog?.querySelector<HTMLElement>("[data-autofocus]");
    (preferred ?? focusableElements()[0] ?? closeRef.current)?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (!closeDisabledRef.current) onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;

      const elements = focusableElements();
      if (elements.length === 0) {
        event.preventDefault();
        return;
      }
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      previouslyFocused?.focus();
    };
  }, []);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: The backdrop offers pointer dismissal in addition to the dialog's keyboard and button controls.
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (!closeDisabled && event.currentTarget === event.target) onClose();
      }}
    >
      {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: Both permitted roles support aria-modal; the shared frame selects one at runtime. */}
      <section
        ref={dialogRef}
        aria-describedby={descriptionId}
        aria-labelledby={titleId}
        aria-modal="true"
        className={`modal-card${wide ? " modal-card--wide" : ""}${className ? ` ${className}` : ""}`}
        role={role}
      >
        <header className="modal-header">
          <div className="modal-header-copy">
            {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
            <h2 id={titleId}>{title}</h2>
          </div>
          <div className="modal-header-actions">
            {headerActions}
            <button
              ref={closeRef}
              aria-label={`Close ${title}`}
              className="icon-button"
              disabled={closeDisabled}
              type="button"
              onClick={onClose}
            >
              ×
            </button>
          </div>
        </header>
        {children}
      </section>
    </div>
  );
}
