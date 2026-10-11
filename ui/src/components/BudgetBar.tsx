import { Badge } from './Badge';

/**
 * D4 — the token budget. Three states, and the third one is not an error: a hard budget
 * that overflows is designed behaviour, so the fact is shown (the badge) and the overflow
 * summary is printed rather than hidden.
 */

function fillColor(used: number, budget: number): string {
  if (used > budget) return 'var(--danger)';
  return budget > 0 && used / budget >= 0.8 ? 'var(--warn)' : 'var(--ok)';
}

export function BudgetBar({
  used,
  budget,
  truncated,
  summary,
}: {
  used: number;
  budget: number;
  truncated?: boolean;
  summary?: string | null;
}) {
  const ratio = budget > 0 ? used / budget : used > 0 ? 1 : 0;
  const fill = Math.min(100, Math.max(0, ratio * 100));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div
          style={{
            flex: '1 1 auto',
            minWidth: 80,
            height: 4,
            background: 'var(--panel-2)',
            borderRadius: 'var(--radius-sm)',
            overflow: 'hidden',
          }}
          role="progressbar"
          aria-label="token budget"
          aria-valuenow={used}
          aria-valuemin={0}
          aria-valuemax={budget}
        >
          <div
            style={{
              width: `${fill}%`,
              height: '100%',
              background: fillColor(used, budget),
              transition: 'width var(--motion)',
            }}
          />
        </div>
        <span
          className="mono"
          style={{ flex: '0 0 auto', fontSize: 11, color: 'var(--dim)', whiteSpace: 'nowrap' }}
        >
          {used} / {budget} tok
        </span>
        {truncated ? <Badge kind="warn">truncated</Badge> : null}
      </div>
      {summary ? (
        <div
          className="hairline"
          style={{
            padding: '6px 8px',
            fontSize: 11,
            lineHeight: 1.55,
            color: 'var(--dim)',
            background: 'var(--panel-2)',
            borderRadius: 'var(--radius-sm)',
            whiteSpace: 'pre-wrap',
          }}
        >
          {summary}
        </div>
      ) : null}
    </div>
  );
}
