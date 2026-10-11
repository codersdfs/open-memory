/**
 * D4 — the explain payload, as a bar. Three monochrome steps of `--accent` and one
 * neutral, never three hues: the segments are one score decomposed, not three metrics.
 * The legend carries the numbers and `title` carries them exactly, so the bar itself is
 * decorative and stays `aria-hidden`.
 */

/** Monochrome accent steps. `--accent` mixed toward transparent is a step, not a gradient. */
const STEPS = [
  'color-mix(in srgb, var(--accent) 100%, transparent)',
  'color-mix(in srgb, var(--accent) 62%, transparent)',
  'color-mix(in srgb, var(--accent) 34%, transparent)',
];

/** The one neutral step, for a fourth segment (a `total` row, or a residual). */
const NEUTRAL = 'color-mix(in srgb, var(--fg) 22%, transparent)';

function colorAt(i: number): string {
  return STEPS[i] ?? NEUTRAL;
}

/** Three decimals, always — the same rule as `ui/src/lib/format.ts:score3`. Copied rather
 *  than imported because this directory may not reach into `ui/src/lib` (ticket 03). */
function score3(n: number): string {
  return n.toFixed(3);
}

export function ScoreBar({ segments, total }: { segments: { key: string; label: string; value: number }[]; total: number }) {
  // Relative to the absolute sum, not the raw sum: a negative term still gets its width,
  // and an all-zero decomposition falls back to a denominator that cannot divide by zero.
  const denom = Math.max(
    1e-9,
    segments.reduce((acc, s) => acc + Math.abs(s.value), 0),
  );
  const tooltip = `${segments.map((s) => `${s.label} ${score3(s.value)}`).join('  ')}  total ${score3(total)}`;

  return (
    <div title={tooltip} style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
      <div
        aria-hidden="true"
        style={{
          flex: '1 1 140px',
          minWidth: 80,
          display: 'flex',
          height: 6,
          background: 'var(--panel-2)',
          borderRadius: 'var(--radius-sm)',
          overflow: 'hidden',
        }}
      >
        {segments.map((s, i) => (
          <div
            key={s.key}
            style={{
              flex: '0 0 auto',
              width: `${(Math.abs(s.value) / denom) * 100}%`,
              // A zero term keeps a 1px sliver, so "this term contributed nothing" is visible
              // as a shape in the stack instead of as a gap that could mean missing data.
              minWidth: 1,
              background: colorAt(i),
            }}
          />
        ))}
      </div>
      <div style={{ flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 10 }}>
        {segments.map((s, i) => (
          <span
            key={s.key}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              color: 'var(--dim)',
              whiteSpace: 'nowrap',
            }}
          >
            <span style={{ width: 6, height: 6, borderRadius: 1, background: colorAt(i) }} />
            {s.label} {score3(s.value)}
          </span>
        ))}
        <span className="mono" style={{ fontSize: 13, color: 'var(--fg)' }}>
          {score3(total)}
        </span>
      </div>
    </div>
  );
}
