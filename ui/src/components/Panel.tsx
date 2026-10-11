import type { ReactNode } from 'react';

/**
 * A surface with an optional header. The card class carries the padding, so it is zeroed
 * here and moved onto the header and the body: that is what lets the header hairline span
 * the full width of the card instead of floating inside its gutter.
 */
export function Panel({
  title,
  subtitle,
  actions,
  children,
  pad = true,
}: {
  title?: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
  pad?: boolean;
}) {
  const hasHeader = title !== undefined || actions !== undefined;

  return (
    <section className="card" style={{ padding: 0 }}>
      {hasHeader ? (
        <header
          className="hairline-bottom"
          style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '11px 14px' }}
        >
          <div style={{ minWidth: 0 }}>
            {title ? <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg)' }}>{title}</div> : null}
            {subtitle ? <div style={{ marginTop: 2, fontSize: 11, color: 'var(--dim)' }}>{subtitle}</div> : null}
          </div>
          {actions ? (
            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>{actions}</div>
          ) : null}
        </header>
      ) : null}
      <div style={{ padding: pad ? 14 : 0 }}>{children}</div>
    </section>
  );
}
