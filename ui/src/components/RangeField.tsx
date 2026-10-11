/**
 * A real range input plus a fixed-width mono readout, so the number does not shift the
 * layout while the thumb moves. The floors in D4 are what this drives: the same query at
 * `0.72` returns nothing and at `0.35` returns several, and that is felt here.
 */
export function RangeField({
  label,
  min,
  max,
  step,
  value,
  onChange,
  format,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange(v: number): void;
  format?: (v: number) => string;
}) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%' }}>
      <span style={{ fontSize: 11, color: 'var(--dim)', whiteSpace: 'nowrap' }}>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        onChange={(e) => onChange(Number(e.currentTarget.value))}
        style={{ flex: '1 1 auto', minWidth: 0, height: 20, accentColor: 'var(--accent)', cursor: 'pointer' }}
      />
      <span
        className="mono"
        style={{ flex: '0 0 auto', minWidth: 54, textAlign: 'right', fontSize: 11, color: 'var(--fg)' }}
      >
        {format ? format(value) : String(value)}
      </span>
    </label>
  );
}
