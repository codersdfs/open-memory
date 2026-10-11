/**
 * CSS only, no chart library (D2). One row per bucket, including the empty ones: a
 * zero-count bucket that vanished would change the shape of the distribution, which is
 * the only thing a histogram is for.
 */
export function Histogram({ buckets, label }: { buckets: { label: string; count: number }[]; label?: string }) {
  const max = buckets.reduce((acc, b) => Math.max(acc, b.count), 0);

  return (
    <div>
      {label ? (
        <div
          style={{
            marginBottom: 8,
            fontSize: 10,
            letterSpacing: '.08em',
            textTransform: 'uppercase',
            color: 'var(--faint)',
          }}
        >
          {label}
        </div>
      ) : null}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {buckets.map((b) => (
          <div key={b.label} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span
              style={{
                flex: '0 0 56px',
                width: 56,
                fontFamily: 'var(--font-mono)',
                fontSize: 10,
                color: 'var(--dim)',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {b.label}
            </span>
            <div style={{ flex: '1 1 auto', minWidth: 0, height: 8 }}>
              <div
                style={{
                  width: max > 0 ? `${(b.count / max) * 100}%` : 0,
                  height: 8,
                  borderRadius: 2,
                  background: 'color-mix(in srgb, var(--accent) 40%, transparent)',
                  transition: 'width var(--motion)',
                }}
              />
            </div>
            <span
              className="mono"
              style={{
                flex: '0 0 auto',
                minWidth: 32,
                textAlign: 'right',
                fontSize: 10,
                color: b.count > 0 ? 'var(--fg)' : 'var(--faint)',
              }}
            >
              {b.count > 0 ? b.count : '—'}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
