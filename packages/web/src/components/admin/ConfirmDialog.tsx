import type { ReactNode } from 'react';
import { ModalSheet } from './ModalSheet.js';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

/**
 * Danger-operation confirmation. Desktop: centered dialog. Mobile: bottom
 * sheet (inherits .modal-sheet). The confirm button is a separate visual group
 * from the page's primary actions so an irreversible op can never be tapped in
 * the same gesture that triggered it.
 */
export function ConfirmDialog({ open, title, message, confirmLabel = '确认', cancelLabel = '取消', danger = true, busy = false, onConfirm, onClose }: ConfirmDialogProps) {
  return (
    <ModalSheet open={open} title={title} onClose={onClose} testId="confirm">
      <div className="confirm-dialog-body">{message}</div>
      <div className="confirm-dialog-actions">
        <button type="button" className="confirm-cancel" onClick={onClose} disabled={busy}>
          {cancelLabel}
        </button>
        <button
          type="button"
          className={danger ? 'confirm-danger' : 'confirm-primary'}
          onClick={onConfirm}
          disabled={busy}
        >
          {busy ? '处理中…' : confirmLabel}
        </button>
      </div>
    </ModalSheet>
  );
}
