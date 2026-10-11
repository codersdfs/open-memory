import { useRef } from 'react';
import type { JSX, KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';

export interface Column<T> {
  key: string;
  header: string;
  width?: string;
  align?: 'left' | 'right';
  mono?: boolean;
  render: (row: T) => ReactNode;
}

/** 8px caret: points down for `desc`, flips for `asc`, and stays dim on a sortable column
 *  that is not the current sort, so every sortable header still advertises that it is one. */
function Caret({ dir }: { dir?: 'asc' | 'desc' }) {
  return (
    <svg
      width={8}
      height={8}
      viewBox="0 0 8 8"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{
        flex: '0 0 auto',
        color: dir ? 'var(--accent)' : 'var(--faint)',
        transform: dir === 'asc' ? 'rotate(180deg)' : undefined,
      }}
    >
      <path d="M1.5 3 4 5.5 6.5 3" />
    </svg>
  );
}

/**
 * One 1px bar per skeleton cell. Animated with SMIL rather than CSS keyframes: this
 * directory may not add a stylesheet or a `<style>` block (ticket 03 bans both), and
 * keyframes cannot be written inline. `keySplines` repeats the `--motion` curve, so the
 * shimmer is not the linear pulse the motion ban is aimed at.
 */
function Shimmer({ width }: { width: number }) {
  return (
    <svg
      width={`${width}%`}
      height={1}
      viewBox="0 0 100 1"
      preserveAspectRatio="none"
      aria-hidden="true"
      style={{ display: 'block', color: 'var(--faint)' }}
    >
      <rect x="0" y="0" width="100" height="1" fill="currentColor" opacity="0.25">
        <animate
          attributeName="opacity"
          values="0.25;0.6;0.25"
          keyTimes="0;0.5;1"
          calcMode="spline"
          keySplines=".2 .8 .2 1;.2 .8 .2 1"
          dur="1.6s"
          repeatCount="indefinite"
        />
      </rect>
    </svg>
  );
}

/** Deterministic width per (row, column), so the skeleton does not jump between renders. */
function shimmerWidth(row: number, col: number): number {
  return 45 + ((row * 17 + col * 23) % 40);
}

/**
 * D6 — the table owns `j`/`k`. The container is focusable, and a shortcut goes through
 * the same `onSelect` a click does, so the keyboard and the mouse share one selection
 * path. `Enter` is the only row action, and it only fires on a current selection.
 */
export function DataTable<T>({
  rows,
  columns,
  rowKey,
  selectedKey,
  onSelect,
  onActivate,
  onSort,
  sortKey,
  sortDir,
  empty,
  loading,
}: {
  rows: T[];
  columns: Column<T>[];
  rowKey: (row: T) => string;
  selectedKey?: string | null;
  onSelect?: (key: string) => void;
  onActivate?: (row: T) => void;
  onSort?: (key: string) => void;
  sortKey?: string;
  sortDir?: 'asc' | 'desc';
  empty?: ReactNode;
  loading?: boolean;
}): JSX.Element {
  const body = useRef<HTMLTableSectionElement>(null);
  const count = rows.length;
  const selectedIndex = selectedKey == null ? -1 : rows.findIndex((row) => rowKey(row) === selectedKey);

  /** Select and reveal in one move. The row element is found by index, so the scroll
   *  does not wait for the selection to paint. */
  const move = (delta: number) => {
    if (onSelect === undefined || count === 0) return;
    const next =
      selectedIndex < 0 ? (delta > 0 ? 0 : count - 1) : Math.min(count - 1, Math.max(0, selectedIndex + delta));
    const row = rows[next];
    if (row === undefined) return;
    onSelect(rowKey(row));
    body.current?.rows.item(next)?.scrollIntoView({ block: 'nearest' });
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement | null;
    // A field inside the table keeps its own keys: `j` is a letter before it is a shortcut.
    if (
      target !== null &&
      (target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable)
    ) {
      return;
    }
    if (e.key === 'j' || e.key === 'ArrowDown') {
      e.preventDefault();
      move(1);
      return;
    }
    if (e.key === 'k' || e.key === 'ArrowUp') {
      e.preventDefault();
      move(-1);
      return;
    }
    if (e.key === 'Enter' && onActivate !== undefined) {
      const row = selectedIndex >= 0 ? rows[selectedIndex] : undefined;
      if (row !== undefined) {
        e.preventDefault();
        onActivate(row);
      }
    }
  };

  const skeleton = Array.from({ length: 5 }, (_, r) => (
    <tr key={`skeleton-${r}`} aria-hidden="true">
      {columns.map((col, c) => (
        <td key={col.key} style={{ padding: '13px 10px' }}>
          <Shimmer width={shimmerWidth(r, c)} />
        </td>
      ))}
    </tr>
  ));

  const emptyRow = (
    <tr>
      <td colSpan={columns.length} style={{ padding: 0 }}>
        {empty}
      </td>
    </tr>
  );

  return (
    <div
      tabIndex={0}
      onKeyDown={onKeyDown}
      style={{
        maxHeight: 520,
        overflow: 'auto',
        background: 'var(--panel)',
        border: '1px solid var(--hairline)',
        borderRadius: 'var(--radius)',
      }}
    >
      <table style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 0, fontSize: 13 }}>
        <thead>
          <tr>
            {columns.map((col) => {
              const active = sortKey === col.key;
              return (
                <th
                  key={col.key}
                  scope="col"
                  aria-sort={active ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined}
                  style={{
                    position: 'sticky',
                    top: 0,
                    zIndex: 1,
                    width: col.width,
                    padding: '7px 10px',
                    textAlign: col.align ?? 'left',
                    background: 'var(--panel)',
                    borderBottom: '1px solid var(--hairline)',
                    fontSize: 11,
                    fontWeight: 600,
                    letterSpacing: '.06em',
                    textTransform: 'uppercase',
                    color: 'var(--dim)',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {onSort ? (
                    <button
                      type="button"
                      onClick={() => onSort(col.key)}
                      style={{
                        all: 'unset',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 4,
                        cursor: 'pointer',
                        color: active ? 'var(--fg)' : 'inherit',
                      }}
                    >
                      {col.header}
                      <Caret dir={active ? (sortDir ?? 'desc') : undefined} />
                    </button>
                  ) : (
                    col.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody ref={body}>
          {loading ? (
            skeleton
          ) : count === 0 ? (
            emptyRow
          ) : (
            rows.map((row, r) => {
              const key = rowKey(row);
              const selected = selectedKey != null && key === selectedKey;
              return (
                <tr
                  key={key}
                  aria-selected={selected}
                  onClick={() => onSelect?.(key)}
                  onDoubleClick={() => {
                    onSelect?.(key);
                    onActivate?.(row);
                  }}
                  style={{
                    background: selected ? 'color-mix(in srgb, var(--accent) 12%, transparent)' : 'transparent',
                    cursor: onActivate ? 'pointer' : 'default',
                  }}
                >
                  {columns.map((col) => (
                    <td
                      key={col.key}
                      className={col.mono ? 'mono' : undefined}
                      style={{
                        padding: '7px 10px',
                        // The container already draws the bottom line; the last row does not
                        // repeat it as a second hairline one pixel away.
                        borderBottom: r === count - 1 ? undefined : '1px solid var(--hairline)',
                        textAlign: col.align ?? 'left',
                        verticalAlign: 'middle',
                        color: 'var(--fg)',
                      }}
                    >
                      {col.render(row)}
                    </td>
                  ))}
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}
