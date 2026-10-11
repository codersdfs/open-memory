import { useEffect } from 'react';
import type { ReactNode } from 'react';

/**
 * D7 — destructive operations confirm. `body` is rendered verbatim on purpose: the
 * caller passes the real count it is about to prune ("this will prune 7 rows"), and a
 * dialog that reformats the number it is confirming undermines the confirmation.
 */
export function Confirm({
  open,
  title,
  body,
  confirmLabel,
  danger = false,
  onConfirm,
  onCancel,
  disabled,
}: {
  open: boolean;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm(): void;
  onCancel(): void;
  disabled?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onCancel();
        return;
      }
      if (e.key === 'Enter' && !disabled) {
        // preventDefault stops a focused button from firing its own click as well.
        e.preventDefault();
        onConfirm();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, disabled, onCancel, onConfirm]);

  if (!open) return null;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 60,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <div
        onClick={onCancel}
        aria-hidden="true"
        style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,.4)' }}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{
          position: 'relative',
          width: 420,
          maxWidth: '100%',
          padding: 16,
          background: 'var(--panel)',
          border: '1px solid var(--hairline)',
          borderRadius: 'var(--radius)',
          boxShadow: 'var(--shadow)',
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--fg)' }}>{title}</div>
        <div style={{ marginTop: 8, fontSize: 12, lineHeight: 1.6, color: 'var(--dim)' }}>{body}</div>
        <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className={danger ? 'btn' : 'btn btn-primary'}
            onClick={onConfirm}
            disabled={disabled}
            style={{
              ...(danger ? { background: 'var(--danger)', borderColor: 'var(--danger)', color: 'var(--bg)' } : null),
              opacity: disabled ? 0.5 : 1,
              cursor: disabled ? 'not-allowed' : 'pointer',
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
