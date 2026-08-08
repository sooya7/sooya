import { useEffect, useRef, type ReactNode } from 'react';

interface ModalSheetProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Optional description read by screen readers under the title. */
  description?: string;
  testId?: string;
}

/**
 * Accessible modal used by the next-phase admin surfaces. Centered dialog on
 * desktop, bottom sheet on small screens (CSS-driven). Handles Esc, backdrop
 * click, focus return, body scroll lock and safe-area padding.
 */
export function ModalSheet({ open, title, onClose, children, description, testId }: ModalSheetProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const dialog = dialogRef.current;
    if (dialog) {
      const focusable = dialog.querySelector<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
      (focusable ?? dialog).focus();
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onClose();
    };
    const onFocus = (event: FocusEvent) => {
      const dialog = dialogRef.current;
      if (!dialog || dialog.contains(event.target as Node)) return;
      const focusable = dialog.querySelector<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
      (focusable ?? dialog).focus();
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('focusin', onFocus);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('focusin', onFocus);
      restoreRef.current?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  const titleId = `modal-title-${testId ?? 'sheet'}`;
  const descriptionId = description ? `modal-desc-${testId ?? 'sheet'}` : undefined;

  return (
    <div className="modal-backdrop" data-testid={`modal-backdrop-${testId ?? 'sheet'}`} onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className="modal-sheet"
        data-testid={testId ? `modal-${testId}` : 'modal-sheet'}
      >
        <header className="modal-sheet-header">
          <h3 id={titleId}>{title}</h3>
          <button type="button" className="modal-sheet-close" aria-label="关闭" onClick={onClose}>✕</button>
        </header>
        {description && <p id={descriptionId} className="modal-sheet-description">{description}</p>}
        <div className="modal-sheet-body">{children}</div>
      </div>
    </div>
  );
}
