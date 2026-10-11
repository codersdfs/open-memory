import type { ReactNode } from 'react';

export function StatCard({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  accent?: boolean;
}) {
  return (
    <div className="card" style={{ padding: '12px 14px' }}>
      <div
        className="mono"
        style={{ fontSize: 20, fontWeight: 600, lineHeight: '26px', color: accent ? 'var(--accent)' : 'var(--fg)' }}
      >
        {value}
      </div>
      <div
        style={{
          marginTop: 6,
          fontSize: 10,
          letterSpacing: '.08em',
          textTransform: 'uppercase',
          color: 'var(--faint)',
        }}
      >
        {label}
      </div>
      {sub ? <div style={{ marginTop: 4, fontSize: 11, color: 'var(--dim)', lineHeight: 1.5 }}>{sub}</div> : null}
    </div>
  );
}
