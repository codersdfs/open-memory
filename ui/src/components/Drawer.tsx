import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { IconClose } from './Icons';

/**
 * D6 — `Esc` closes it. Focus moves into the drawer on open and back to whatever had it
 * on close, so the keyboard is never dropped on the floor by opening a detail pane.
 */
export function Drawer({
  open,
  title,
  subtitle,
  onClose,
  children,
  footer,
}: {
  open: boolean;
  title: string;
  subtitle?: string;
  onClose(): void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panel.current?.focus();
    return () => {
      returnTo.current?.focus();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 50 }}>
      <div
        onClick={onClose}
        aria-hidden="true"
        style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,.4)' }}
      />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        style={{
          position: 'absolute',
          top: 0,
          right: 0,
          bottom: 0,
          width: 420,
          maxWidth: '100%',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--panel)',
          borderLeft: '1px solid var(--hairline)',
          boxShadow: 'var(--shadow)',
          outline: 'none',
        }}
      >
        <header
          className="hairline-bottom"
          style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '12px 14px' }}
        >
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg)' }}>{title}</div>
            {subtitle ? <div style={{ marginTop: 2, fontSize: 11, color: 'var(--dim)' }}>{subtitle}</div> : null}
          </div>
          <button
            type="button"
            className="btn"
            onClick={onClose}
            aria-label="Close"
            style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', padding: '4px 6px' }}
          >
            <IconClose />
          </button>
        </header>
        <div style={{ flex: '1 1 auto', overflow: 'auto', padding: 14 }}>{children}</div>
        {footer ? (
          <footer
            className="hairline-top"
            style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px' }}
          >
            {footer}
          </footer>
        ) : null}
      </div>
    </div>
  );
}
