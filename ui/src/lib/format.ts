/**
 * Pure, locale-fixed formatters. No date library: every number here is a
 * subtraction and a division, and `Intl`/`toLocaleString` would make the output
 * depend on the host locale — a console that renders "1.4 kB" one machine and
 * "1,4 kB" on another is not a console you can screenshot.
 */

/** Below this a timestamp is "now" rather than "0s". */
const NOW_MS = 1000;
const MIN_MS = 60 * 1000;
const HOUR_MS = 60 * MIN_MS;
const DAY_MS = 24 * HOUR_MS;
const MONTH_DAYS = 30;
const YEAR_DAYS = 365;

/** `now`, `12s`, `5m`, `3h`, `4d`, `2mo`, `1y`; `never` for null/0. Floors, so 59s is `59s` and 60s is `1m`. */
export function relTime(ts: number | null, now: number = Date.now()): string {
  if (ts === null || ts === 0) return "never";
  const delta = Math.max(0, now - ts);
  if (delta < NOW_MS) return "now";
  if (delta < MIN_MS) return `${Math.floor(delta / 1000)}s`;
  if (delta < HOUR_MS) return `${Math.floor(delta / MIN_MS)}m`;
  if (delta < DAY_MS) return `${Math.floor(delta / HOUR_MS)}h`;
  const days = delta / DAY_MS;
  if (days < MONTH_DAYS) return `${Math.floor(days)}d`;
  if (days < YEAR_DAYS) return `${Math.floor(days / MONTH_DAYS)}mo`;
  return `${Math.floor(days / YEAR_DAYS)}y`;
}

/** `YYYY-MM-DD HH:MM:SS`, local time; `never` for null/0. */
export function absTime(ts: number | null): string {
  if (ts === null || ts === 0) return "never";
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

/** Three decimals, always: `0.737`. */
export function score3(n: number): string {
  return n.toFixed(3);
}

/** `800 tok` / `1.2k tok`. */
export function tokens(n: number): string {
  return n < 1000 ? `${Math.round(n)} tok` : `${(n / 1000).toFixed(1)}k tok`;
}

/** `512 B` / `1.4 kB` / `3.1 MB`; `—` when the size is unknown (`dbBytes: null`). */
export function bytes(n: number | null): string {
  if (n === null) return "—";
  if (n < 1000) return `${Math.round(n)} B`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)} kB`;
  return `${(n / 1_000_000).toFixed(1)} MB`;
}

/** `72%`. */
export function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

/** One line, at most `n` characters, ellipsis when cut. */
export function truncate(s: string, n: number): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  if (n <= 0) return "";
  if (oneLine.length <= n) return oneLine;
  if (n === 1) return "…";
  return oneLine.slice(0, n - 1) + "…";
}
