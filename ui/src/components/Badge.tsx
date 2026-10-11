import type { ReactNode } from 'react';

type Kind = 'neutral' | 'accent' | 'ok' | 'warn' | 'danger';

/** Tinted text only: a badge is never a saturated fill (D2), so `kind` picks the ink,
 *  not the background, and the box stays a 1px hairline on the card surface. */
const TINT: Record<Kind, string> = {
  neutral: 'var(--dim)',
  accent: 'var(--accent)',
  ok: 'var(--ok)',
  warn: 'var(--warn)',
  danger: 'var(--danger)',
};

export function Badge({ kind = 'neutral', children }: { kind?: Kind; children: ReactNode }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '1px 5px',
        fontFamily: 'var(--font-mono)',
        fontSize: 10,
        lineHeight: '14px',
        letterSpacing: '.07em',
        textTransform: 'uppercase',
        color: TINT[kind],
        border: '1px solid var(--hairline)',
        borderRadius: 'var(--radius-sm)',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </span>
  );
}
