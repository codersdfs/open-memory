import { useEffect, useRef, useState } from 'react';
import { Badge } from '../components/Badge';
import { BudgetBar } from '../components/BudgetBar';
import { Empty } from '../components/Empty';
import { KeyboardHint } from '../components/KeyboardHint';
import { Panel } from '../components/Panel';
import { RangeField } from '../components/RangeField';
import { ScoreBar } from '../components/ScoreBar';
import { api } from '../lib/api';
import type { MemoryType, SearchResult, SearchResultItem } from '../lib/api';
import { FLOOR_PRESETS, explainSegments } from '../lib/score';
import { absTime, relTime, score3, truncate } from '../lib/format';
import { useRoute } from '../router';

/**
 * D4 — the explain payload is the interface. Every number on this screen comes from
 * the response (`tokensUsed`, `tokensUsed`/`budgetTokens` on the request, `explain`,
 * `strength`, `lastUsedAt`); nothing here is a saving, a latency or a confidence.
 *
 * D10 — the whole view state (query, filters, sliders) lives in the hash, so a refresh
 * restores it. The hash is the single source of truth for the inputs: `setParams` writes
 * it and the `hashchange` the router listens for feeds the value back, which is why no
 * local copy of the query exists to drift.
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

/** One hit: the decomposition, the text, then the metadata row. The id is last so it never
 *  pushes the badges around, and it is selectable because copying it is the point. */
function Hit({ hit }: { hit: SearchResultItem }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 9, padding: '12px 14px' }}>
      {hit.explain ? (
        <ScoreBar segments={explainSegments(hit.explain)} total={hit.score} />
      ) : (
        // The server only omits `explain` if it was not asked for; the score is still real.
        <div className="mono" style={{ fontSize: 13, color: 'var(--fg)' }}>
          {score3(hit.score)}
        </div>
      )}

      <div style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--fg)' }} title={hit.text}>
        {truncate(hit.text, 260)}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <Badge>{hit.type}</Badge>
        {hit.status !== 'active' ? <Badge kind="warn">{hit.status}</Badge> : null}
        {hit.pin ? <Badge kind="accent">pinned</Badge> : null}
        <span className="mono" style={{ fontSize: 10, color: 'var(--dim)' }}>
          imp {score3(hit.importance)}
        </span>
        <span className="mono" style={{ fontSize: 10, color: 'var(--dim)' }}>
          str {score3(hit.strength)}
        </span>
        <span title={absTime(hit.lastUsedAt)} style={{ fontSize: 11, color: 'var(--dim)' }}>
          {relTime(hit.lastUsedAt)}
        </span>
        {hit.strength > 0.5 ? (
          <span style={{ fontSize: 10, color: 'var(--faint)' }}>reinforced</span>
        ) : null}
        <span
          className="mono"
          title={hit.id}
          style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--faint)' }}
        >
          {hit.id}
        </span>
      </div>
    </div>
  );
}

export default function RecallView({ namespace }: { namespace: string }) {
  const { params, setParams } = useRoute();

  const query = params.get('q') ?? '';
  const typeFilter = typeParam(params.get('t'));
  const k = numParam(params, 'k', 5, 1, 20);
  const threshold = numParam(params, 'th', 0.72, 0, 1);
  const budget = numParam(params, 'bt', 800, 100, 4000);

  // What was actually searched: typing edits the hash, but only submitting (or a slider
  // move, which changes a dep) re-runs the request. A refresh restores it, because it is
  // seeded from the hash.
  const [submitted, setSubmitted] = useState<string>(() => params.get('q') ?? '');
  const [run, setRun] = useState(0);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

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

  const lowerPresets = FLOOR_PRESETS.filter((p) => p.value < threshold);
  const hits = result?.memories ?? [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Panel title="recall" subtitle={namespace}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div className="field" style={{ flex: '1 1 320px' }}>
              <span>query</span>
              <input
                id={QUERY_ID}
                value={query}
                spellCheck={false}
                aria-label="Query"
                placeholder="what did we decide about…"
                onChange={(e) => setParams({ q: e.currentTarget.value === '' ? undefined : e.currentTarget.value })}
              />
            </div>

            <div className="field">
              <span>type</span>
              <select
                value={typeFilter ?? ''}
                aria-label="Type"
                onChange={(e) => setParams({ t: e.currentTarget.value === '' ? undefined : e.currentTarget.value })}
              >
                <option value="">all types</option>
                {TYPE_OPTIONS.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>

            <button type="button" className="btn btn-primary" onClick={() => submitRef.current()}>
              search
            </button>

            <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
              <KeyboardHint keys={['/']} />
              <span style={{ fontSize: 10, color: 'var(--faint)' }}>focus</span>
              <KeyboardHint keys={['⌘', '↵']} />
              <span style={{ fontSize: 10, color: 'var(--faint)' }}>search</span>
            </div>
          </div>

          <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))' }}>
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

          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 10, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--faint)' }}>
              floor presets
            </span>
            {FLOOR_PRESETS.map((p) => (
              <button
                key={p.key}
                type="button"
                className="btn"
                aria-pressed={threshold === p.value}
                title={`set the floor to ${score3(p.value)}`}
                onClick={() => setParams({ th: p.value })}
              >
                {p.label} {score3(p.value)}
              </button>
            ))}
          </div>
        </div>
      </Panel>

      {error !== null ? (
        <Panel title="search failed">
          <div className="mono" style={{ fontSize: 12, lineHeight: 1.6, color: 'var(--danger)', whiteSpace: 'pre-wrap' }}>
            {error}
          </div>
        </Panel>
      ) : null}

      {loading ? (
        <Panel title="hits" subtitle={`searching “${truncate(submitted, 40)}”`}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {[0, 1, 2].map((i) => (
              <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
                <SkeletonBar width="72%" />
                <SkeletonBar width="100%" height={6} />
                <SkeletonBar width="34%" height={6} />
              </div>
            ))}
          </div>
        </Panel>
      ) : null}

      {!loading && submitted === '' ? (
        <Empty title="nothing searched yet" body="type a query, then press ⌘/Ctrl + Enter." />
      ) : null}

      {!loading && result !== null ? (
        <Panel
          title="budget"
          subtitle={`${hits.length} ${hits.length === 1 ? 'hit' : 'hits'} for “${truncate(submitted, 40)}”`}
        >
          {/* `budgetTokens` is a request field — the response carries `tokensUsed`, not the
              budget it was measured against — so the budget shown is the one that was sent. */}
          <BudgetBar used={result.tokensUsed} budget={budget} truncated={result.truncated} summary={result.summary} />
        </Panel>
      ) : null}

      {!loading && result !== null && hits.length === 0 ? (
        <Empty
          title="nothing cleared the floor"
          body="empty is the designed answer, not a failure."
          action={
            <>
              <span className="mono" style={{ fontSize: 11, color: 'var(--fg)' }}>
                floor {score3(threshold)}
              </span>
              {lowerPresets.length > 0 ? (
                lowerPresets.map((p) => (
                  <button key={p.key} type="button" className="btn" onClick={() => setParams({ th: p.value })}>
                    try {p.label} {score3(p.value)}
                  </button>
                ))
              ) : (
                <span style={{ fontSize: 11, color: 'var(--dim)' }}>try a lower preset</span>
              )}
            </>
          }
        />
      ) : null}

      {!loading && hits.length > 0 ? (
        <section className="card" style={{ padding: 0 }}>
          {hits.map((hit, i) => (
            <div key={hit.id} style={{ borderTop: i === 0 ? undefined : '1px solid var(--hairline)' }}>
              <Hit hit={hit} />
            </div>
          ))}
        </section>
      ) : null}
    </div>
  );
}
