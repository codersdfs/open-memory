import { useEffect, useRef, useState } from 'react';
import { BudgetBar } from '../components/BudgetBar';
import { Empty } from '../components/Empty';
import { KeyboardHint } from '../components/KeyboardHint';
import { RangeField } from '../components/RangeField';
import { ScoreBar } from '../components/ScoreBar';
import { Badge } from '../components/Badge';
import { IconChevronDown, IconChevronUp, IconSearch } from '../components/Icons';
import { api } from '../lib/api';
import type { MemoryType, SearchResult, SearchResultItem } from '../lib/api';
import { FLOOR_PRESETS, explainSegments } from '../lib/score';
import { absTime, relTime, score3, truncate } from '../lib/format';
import { useRoute } from '../router';

/**
 * D4 — the explain payload is the interface. Every number on this screen comes from
 * the response (`tokensUsed`, `budgetTokens` on the request, `explain`, `strength`,
 * `lastUsedAt`, `diagnostics`); nothing here is a saving, a latency or a confidence.
 *
 * D10 — the whole view state (query, filters, sliders) lives in the hash, so a refresh
 * restores it. The hash is the single source of truth for the inputs: `setParams` writes
 * it and the `hashchange` the router listens for feeds the value back, which is why no
 * local copy of the query exists to drift.
 *
 * ADR-0043 presentation: one search hero, pill filters, hits as rows in one list, and
 * the gate's rejected candidates folded under a "below floor" ghost — ADR-0037's
 * near-misses are the honest version of "no results".
 */

/** The `/` shortcut target. A stable id is what makes "focus the search field" a one-liner. */
const QUERY_ID = 'recall-query';

const TYPE_OPTIONS: readonly MemoryType[] = ['episodic', 'semantic', 'procedural', 'working'];

function numParam(params: URLSearchParams, key: string, fallback: number, min: number, max: number): number {
  const raw = params.get(key);
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** An unknown/absent `t` means "all types" — the server's `enumOf` then drops the field. */
function typeParam(raw: string | null): MemoryType | undefined {
  return raw !== null && (TYPE_OPTIONS as readonly string[]).includes(raw) ? (raw as MemoryType) : undefined;
}

/** The API answers `{ error }` and `api.ts` already puts that message on the Error. */
function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Skeletons, never a spinner. Animated with SMIL so the shimmer needs no `<style>` block
 * or CSS keyframes (both banned); `keySplines` repeats `--motion`, so it is not the
 * linear pulse the motion ban targets.
 */
function SkeletonBar({ width, height = 8 }: { width: string; height?: number }) {
  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      aria-hidden="true"
      style={{ display: 'block', color: 'var(--panel-2)' }}
    >
      <rect x="0" y="0" width="100" height="100" fill="currentColor">
        <animate
          attributeName="opacity"
          values="1;.45;1"
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

/** One hit row: the decomposition, the text, then the metadata. The id is last so it never
 *  pushes the badges around, and it is selectable because copying it is the point. */
function Hit({ hit }: { hit: SearchResultItem }) {
  return (
    <div className="hit">
      <div className="hit-head">
        <span className={`tdot ${hit.type}`} aria-hidden="true" />
        <span className="mono" style={{ fontSize: 11, color: 'var(--dim)' }}>
          {hit.type}
        </span>
        {hit.kind ? <span className="chip">{hit.kind}</span> : null}
        {hit.status !== 'active' ? <Badge kind="warn">{hit.status}</Badge> : null}
        {hit.pin === 1 ? <Badge kind="accent">pinned</Badge> : null}
        <span className="spacer" />
        <span className="hit-meta" title={absTime(hit.lastUsedAt)}>
          {relTime(hit.lastUsedAt)}
        </span>
        <span className="hit-score">{score3(hit.score)}</span>
      </div>
      <div className="hit-text" title={hit.text}>
        {truncate(hit.text, 320)}
      </div>
      {hit.explain ? <ScoreBar segments={explainSegments(hit.explain)} total={hit.score} /> : null}
      <div className="legend">
        <span>imp {score3(hit.importance)}</span>
        <span>str {score3(hit.strength)}</span>
        {hit.strength > 0.5 ? <span>reinforced</span> : null}
        <span style={{ marginLeft: 'auto' }}>{hit.id}</span>
      </div>
    </div>
  );
}

/**
 * The floor a search starts at: `agent EN`, not the HTTP 0.72.
 *
 * At 0.72 a first query against a hash store comes back empty often enough that it reads
 * as a broken search rather than a high floor — measured on the demo store, the same
 * query returns 0 hits at 0.72 and 7 at 0.35. The presets are still one click away.
 */
const DEFAULT_FLOOR = FLOOR_PRESETS.find((p) => p.key === 'agent-en')?.value ?? 0.35;

export default function RecallView({ namespace }: { namespace: string }) {
  const { params, setParams } = useRoute();

  const query = params.get('q') ?? '';
  const typeFilter = typeParam(params.get('t'));
  const k = numParam(params, 'k', 5, 1, 20);
  const threshold = numParam(params, 'th', DEFAULT_FLOOR, 0, 1);
  const budget = numParam(params, 'bt', 800, 100, 4000);

  // What was actually searched: typing edits the hash, but only submitting (or a slider
  // move, which changes a dep) re-runs the request. A refresh restores it, because it is
  // seeded from the hash.
  const [submitted, setSubmitted] = useState<string>(() => params.get('q') ?? '');
  const [run, setRun] = useState(0);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showNear, setShowNear] = useState(false);

  // A ref keeps the document-level listener stable without re-registering it per keystroke.
  const submitRef = useRef<() => void>(() => {});
  useEffect(() => {
    submitRef.current = () => {
      setSubmitted(query);
      setRun((r) => r + 1);
    };
  });

  // D6 — `/` focuses the search field, `Cmd`/`Ctrl`+`Enter` submits. Keys typed inside a
  // field belong to that field (`/` is a slash before it is a shortcut).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target instanceof HTMLElement ? e.target : null;
      const typing =
        target !== null &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable);

      if (e.key === '/' && !typing) {
        e.preventDefault();
        const field = document.getElementById(QUERY_ID);
        if (field instanceof HTMLInputElement) {
          field.focus();
          field.select();
        }
        return;
      }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        submitRef.current();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    if (submitted === '') {
      setResult(null);
      setError(null);
      setLoading(false);
      return;
    }
    let live = true;
    setLoading(true);
    setError(null);
    api
      .search({ query: submitted, namespace, type: typeFilter, k, threshold, budgetTokens: budget })
      .then((r) => {
        if (!live) return;
        setResult(r);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (!live) return;
        setError(errText(e));
        setResult(null);
        setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [submitted, run, namespace, typeFilter, k, threshold, budget]);

  const hits = result?.memories ?? [];
  const near = result?.diagnostics?.nearMisses ?? [];
  const nearFloor = result?.diagnostics?.threshold ?? threshold;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div>
        <div style={{ fontSize: 15, fontWeight: 600 }}>Recall</div>
        <div className="mono" style={{ marginTop: 3, fontSize: 11, color: 'var(--faint)' }}>
          hybrid retrieval · bm25 + vector + recency + strength · hard token budget
        </div>
      </div>

      <form
        className="search-hero"
        onSubmit={(e) => {
          e.preventDefault();
          submitRef.current();
        }}
      >
        <IconSearch size={14} />
        <input
          id={QUERY_ID}
          value={query}
          spellCheck={false}
          aria-label="Query"
          placeholder="search memory…"
          onChange={(e) => setParams({ q: e.currentTarget.value === '' ? undefined : e.currentTarget.value })}
        />
        <KeyboardHint keys={['⌘', '↵']} />
      </form>

      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
        <span className="legend">
          <span>type</span>
        </span>
        <button
          type="button"
          className="pill"
          aria-pressed={typeFilter === undefined}
          onClick={() => setParams({ t: undefined, id: undefined })}
        >
          all
        </button>
        {TYPE_OPTIONS.map((t) => (
          <button
            key={t}
            type="button"
            className="pill"
            aria-pressed={typeFilter === t}
            onClick={() => setParams({ t: t, id: undefined })}
          >
            {t}
          </button>
        ))}
        <span className="spacer" style={{ flex: 1 }} />
        <span className="legend">
          <span>floor</span>
        </span>
        {FLOOR_PRESETS.map((p) => (
          <button
            key={p.key}
            type="button"
            className="pill mono"
            aria-pressed={threshold === p.value}
            title={`set the floor to ${score3(p.value)}`}
            onClick={() => setParams({ th: p.value })}
          >
            {p.label} {score3(p.value)}
          </button>
        ))}
      </div>

      <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
        <RangeField label="k" min={1} max={20} step={1} value={k} onChange={(v) => setParams({ k: v })} />
        <RangeField
          label="threshold"
          min={0}
          max={1}
          step={0.02}
          value={threshold}
          onChange={(v) => setParams({ th: v })}
          format={score3}
        />
        <RangeField
          label="budgetTokens"
          min={100}
          max={4000}
          step={100}
          value={budget}
          onChange={(v) => setParams({ bt: v })}
          format={(v) => String(v)}
        />
      </div>

      <div className="row" style={{ gap: 6 }}>
        <KeyboardHint keys={['/']} />
        <span style={{ fontSize: 10, color: 'var(--faint)' }}>focus</span>
      </div>

      {error !== null ? (
        <div
          role="alert"
          className="mono"
          style={{ fontSize: 12, lineHeight: 1.6, color: 'var(--danger)', whiteSpace: 'pre-wrap' }}
        >
          {error}
        </div>
      ) : null}

      {loading ? (
        <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {[0, 1, 2].map((i) => (
            <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
              <SkeletonBar width="72%" />
              <SkeletonBar width="100%" height={6} />
              <SkeletonBar width="34%" height={6} />
            </div>
          ))}
        </div>
      ) : null}

      {!loading && submitted === '' ? (
        <Empty title="nothing searched yet" body="type a query, then press ⌘/Ctrl + Enter." />
      ) : null}

      {!loading && result !== null ? (
        <>
          <div className="row" style={{ gap: 10 }}>
            <span className="mono" style={{ fontSize: 11, color: 'var(--faint)' }}>
              {hits.length} {hits.length === 1 ? 'hit' : 'hits'} for “{truncate(submitted, 40)}”
            </span>
            <BudgetBar used={result.tokensUsed} budget={budget} truncated={result.truncated} summary={result.summary} />
          </div>

          {hits.length === 0 ? (
            <Empty
              title="nothing cleared the floor"
              body="empty is the designed answer, not a failure."
              action={
                <span className="mono" style={{ fontSize: 11, color: 'var(--fg)' }}>
                  floor {score3(threshold)} — try a lower preset above
                </span>
              }
            />
          ) : (
            <div className="list">
              {hits.map((hit) => (
                <Hit key={hit.id} hit={hit} />
              ))}
              {near.length > 0 ? (
                <div style={{ borderTop: '1px solid var(--hairline)', padding: '10px 15px' }}>
                  <button type="button" className="ghost" onClick={() => setShowNear(!showNear)}>
                    {showNear ? <IconChevronUp size={12} /> : <IconChevronDown size={12} />}
                    {near.length} below floor {score3(nearFloor)}
                    {showNear ? ' · hide' : ' · show'}
                  </button>
                  {showNear ? (
                    <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {near.slice(0, 5).map((nm, i) => (
                        <div key={i} className="hit is-dim" style={{ padding: '8px 10px', border: '1px solid var(--hairline)', borderRadius: 'var(--radius-sm)' }}>
                          <div className="hit-head">
                            <span className="hit-meta">relevance {score3(nm.relevance)}</span>
                          </div>
                          <div className="hit-text">{truncate(nm.text, 240)}</div>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}
