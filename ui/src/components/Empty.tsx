import type { ReactNode } from 'react';

/**
 * "Never a blank box" (D4): an empty result is a designed answer, so it gets a mark, a
 * sentence and, when the caller has one, the action that un-empties it. Centred and
 * generously padded, so it reads as content rather than as a render that did not arrive.
 */
export function Empty({ title, body, action }: { title: string; body: ReactNode; action?: ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        textAlign: 'center',
        gap: 10,
        padding: '48px 24px',
        maxWidth: 420,
        margin: '0 auto',
      }}
    >
      <svg
        width={22}
        height={22}
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        aria-hidden="true"
        style={{ color: 'var(--faint)' }}
      >
        <circle cx="8" cy="8" r="6.25" />
        <circle cx="8" cy="8" r="1.5" fill="currentColor" stroke="none" />
      </svg>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg)' }}>{title}</div>
      <div style={{ fontSize: 12, color: 'var(--dim)', lineHeight: 1.6, maxWidth: 420 }}>{body}</div>
      {action ? <div style={{ marginTop: 6, display: 'flex', gap: 8 }}>{action}</div> : null}
    </div>
  );
}
