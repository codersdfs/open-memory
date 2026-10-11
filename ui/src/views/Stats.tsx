import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Confirm } from '../components/Confirm';
import { DataTable } from '../components/DataTable';
import type { Column } from '../components/DataTable';
import { Empty } from '../components/Empty';
import { Histogram } from '../components/Histogram';
import { Panel } from '../components/Panel';
import { StatCard } from '../components/StatCard';
import { api } from '../lib/api';
import type { DecayCandidate, EmbeddingInfo, EmbeddingPreset, ReembedJob, StatsResponse } from '../lib/api';
import { absTime, bytes, relTime, score3, truncate } from '../lib/format';

/**
 * Stats, over `?full=1`. D11 is the rule this screen is built on: every figure here is a
 * field of the response. `textTokensEstimate` is the one number that is a *derived* size
 * (chars / 4, the same heuristic the budget uses) and it is labelled as a size, never as a
 * saving — the store keeps no recall log, so any "tokens saved" would be invented.
 *
 * D7 — `decay` previews first: the candidate count and the exact predicates are stated in
 * the dialog, and the preview reads the same constants the prune does (src/core/stats.ts:18-20
 * mirrors src/core/lifecycle/decay.ts).
 */

const PREDICATES = 'episodic older than 90 days with importance <= 0.3; working older than 7 days';

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Skeleton, never a spinner. SMIL because a `<style>` block and CSS keyframes are banned. */
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

function InfoRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, minWidth: 0 }}>
      <span
        style={{
          flex: '0 0 104px',
          fontSize: 10,
          letterSpacing: '.08em',
          textTransform: 'uppercase',
          color: 'var(--faint)',
        }}
      >
        {label}
      </span>
      <span className="mono" style={{ minWidth: 0, fontSize: 11, color: 'var(--fg)', wordBreak: 'break-all' }}>
        {value}
      </span>
    </div>
  );
}

/** The micro-label every section of the embeddings card opens with. */
function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div style={{ fontSize: 10, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--faint)' }}>
      {children}
    </div>
  );
}

/**
 * D5 — `failed[]` is shown verbatim. Rows that failed stay at the old width, so they stay
 * counted in the unreadable line above; a warning that cleared itself on a partial run
 * would be worse than none.
 */
function FailedRows({ failed }: { failed: { id: string; error: string }[] }) {
  if (failed.length === 0) return null;
  return (
    <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ fontSize: 11, color: 'var(--dim)', lineHeight: 1.6 }}>
        failed rows stay at the old width, so they stay counted above until they are migrated.
      </div>
      {failed.map((f) => (
        <div
          key={f.id}
          className="mono"
          style={{ fontSize: 11, color: 'var(--danger)', wordBreak: 'break-all', lineHeight: 1.5 }}
        >
          {f.id}: {f.error}
        </div>
      ))}
    </div>
  );
}

/** The env-variable name each preset's model belongs in; `hash` has no model to name. */
const PRESET_MODEL_ENV: Record<EmbeddingPreset['provider'], string | null> = {
  hash: null,
  openai: 'OPENAI_EMBED_MODEL',
  nim: 'NIM_EMBED_MODEL',
};

/**
 * The body `POST /embedding` takes is the environment-variable vocabulary, not a key: a
 * preset becomes `EMBEDDING_PROVIDER` + `EMBEDDING_DIM` + the provider's model variable.
 * `EMBEDDING_DIM` is always sent — the write is a patch, and a width left over from the
 * previous provider would be the one field that could make the next start refuse.
 */
function presetPatch(p: EmbeddingPreset): Record<string, string> {
  const patch: Record<string, string> = { EMBEDDING_PROVIDER: p.provider, EMBEDDING_DIM: String(p.dim) };
  const modelEnv = PRESET_MODEL_ENV[p.provider];
  if (modelEnv !== null && p.model !== null) patch[modelEnv] = p.model;
  return patch;
}

/**
 * D3/D4/D5/D6 — the embedding switch. This card is the only place the dark window is a
 * number: `stored.unreadable` is what the running provider cannot read, and it is a line,
 * never a tooltip. The provider is never swapped in place (ADR-0009): the card writes
 * settings, migrates vectors, and then asks for a restart — that order, always.
 */
function EmbeddingsCard() {
  const [info, setInfo] = useState<EmbeddingInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [selected, setSelected] = useState<EmbeddingPreset['provider'] | null>(null);
  const [pending, setPending] = useState(false);
  const [writing, setWriting] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [dry, setDry] = useState<ReembedJob | null>(null);
  const [job, setJob] = useState<ReembedJob | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [migrateError, setMigrateError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api
      .embedding()
      .then((i) => {
        if (!live) return;
        setInfo(i);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!live) return;
        // The API answers `{ error }`, and `request()` already threw that message.
        setError(errText(e));
        setInfo(null);
      });
    return () => {
      live = false;
    };
  }, [nonce]);

  // A job started from another tab is still this process's job, so the card seeds from
  // `info.reembed` and only overrides it once this card has started one of its own.
  const activeJob = job ?? info?.reembed ?? null;
  const running = activeJob !== null && activeJob.state === 'running';

  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => {
      api
        .reembedJob()
        .then((j) => {
          setJob(j);
          // The widths have moved, so the histogram above is stale the moment it ends.
          if (j.state === 'done' && !j.dryRun) setNonce((n) => n + 1);
        })
        .catch((e: unknown) => setMigrateError(errText(e)));
    }, 1000);
    return () => clearInterval(id);
  }, [running]);

  if (error !== null) {
    return (
      <Panel title="embeddings" subtitle="provider, store widths, migration">
        <div className="mono" style={{ fontSize: 12, lineHeight: 1.6, color: 'var(--danger)', whiteSpace: 'pre-wrap' }}>
          {error}
        </div>
      </Panel>
    );
  }

  if (info === null) {
    return (
      <Panel title="embeddings" subtitle="provider, store widths, migration">
        <SkeletonBar width="60%" />
      </Panel>
    );
  }

  const preset =
    (selected !== null ? info.presets.find((p) => p.provider === selected) : undefined) ??
    info.presets.find((p) => p.provider === (info.target?.provider ?? info.live.provider)) ??
    null;

  const buckets = Object.entries(info.stored.byVectorDim)
    .map(([dim, count]) => ({ dim: Number(dim), count }))
    .sort((a, b) => a.dim - b.dim)
    .map((b) => ({ label: `${b.dim}d`, count: b.count }));

  const busy = pending || writing || running;
  const progress = activeJob !== null && activeJob.total > 0 ? Math.min(100, (activeJob.done / activeJob.total) * 100) : 0;
  const migrated = activeJob !== null && activeJob.state === 'done' && !activeJob.dryRun;

  // The environment beats the settings file, so a write of a key it already sets would
  // be refused by the server. Knowing it here is the difference between a disabled button
  // and a 400 the user has to interpret. `presetPatch` is the same body the write sends,
  // so the keys cannot drift from the ones actually posted.
  const blocked = preset === null ? [] : Object.keys(presetPatch(preset)).filter((k) => info.shadowed.includes(k));

  const writeSettings = () => {
    if (preset === null) return;
    setWriting(true);
    setSwitchError(null);
    api
      .setEmbedding(presetPatch(preset))
      .then(() => {
        // The dry-run numbers described the old target; they are not the answer any more.
        setDry(null);
        setJob(null);
        setNonce((n) => n + 1);
      })
      .catch((e: unknown) => setSwitchError(errText(e)))
      .finally(() => setWriting(false));
  };

  const runDry = () => {
    setPending(true);
    setMigrateError(null);
    api
      .reembed({ dryRun: true })
      .then((r) => setDry(r))
      .catch((e: unknown) => setMigrateError(errText(e)))
      .finally(() => setPending(false));
  };

  const runMigration = () => {
    setPending(true);
    setMigrateError(null);
    api
      .reembed({ dryRun: false })
      .then((j) => {
        setJob(j);
        setConfirmOpen(false);
        if (j.state === 'done') setNonce((n) => n + 1);
      })
      .catch((e: unknown) => {
        setMigrateError(errText(e));
        setConfirmOpen(false);
      })
      .finally(() => setPending(false));
  };

  return (
    <Panel title="embeddings" subtitle="one process, one vector space — a switch is settings plus a restart">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {/* 1 — what is live, and whether an edit below is even in play. */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <InfoRow
            label="live"
            value={
              <>
                {info.live.provider} ·{' '}
                <span style={{ fontVariantNumeric: 'tabular-nums' }}>{info.live.dim}d</span>
              </>
            }
          />
          <InfoRow label="model" value={info.live.model ?? '—'} />
          <InfoRow label="source" value={info.live.source} />
          <div style={{ fontSize: 11, color: 'var(--faint)', lineHeight: 1.6 }}>
            {info.live.source === 'env'
              ? 'source env: the real environment beats the settings file, so a write below cannot change what starts next.'
              : info.live.source === 'settings'
                ? 'source settings: nothing in the environment overrides it, so the settings file below decides the next start.'
                : 'source default: nothing in the environment or the settings file sets a provider — a write below is the only thing that would.'}
          </div>
        </div>

        {/* 2 — restart required: a persistent line, not a toast. */}
        {info.needsRestart && info.target !== null ? (
          <div
            className="hairline"
            style={{
              padding: '7px 9px',
              fontSize: 11,
              lineHeight: 1.7,
              color: 'var(--warn)',
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
            }}
          >
            <div>
              restart required — this process is still <span className="mono">{info.live.provider}</span>{' '}
              <span className="mono" style={{ fontVariantNumeric: 'tabular-nums' }}>
                {info.live.dim}d
              </span>
              ; the settings now build <span className="mono">{info.target.provider}</span>{' '}
              <span className="mono" style={{ fontVariantNumeric: 'tabular-nums' }}>
                {info.target.dim}d
              </span>
              , and the running process keeps the old one until it restarts.
            </div>
            <div>
              restarting before the migration below is refused by the startup guard, which names both dims — that is the
              guard working, not a crash.
            </div>
          </div>
        ) : null}

        {/* 3 — presets. A key is only ever a name and a boolean here. */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <SectionLabel>presets</SectionLabel>
          <div role="radiogroup" aria-label="embedding preset" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {info.presets.map((p) => {
              const entry = p.keyEnv === null ? undefined : info.keys.find((k) => k.env === p.keyEnv);
              const missingKey = entry !== undefined && !entry.present;
              const checked = preset !== null && preset.provider === p.provider;
              return (
                <label
                  key={p.provider}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 8,
                    padding: '7px 9px',
                    border: `1px solid ${checked ? 'var(--hairline-strong)' : 'var(--hairline)'}`,
                    background: checked ? 'var(--accent-dim)' : 'transparent',
                    borderRadius: 'var(--radius-sm)',
                    opacity: missingKey ? 0.5 : 1,
                    cursor: missingKey ? 'not-allowed' : 'pointer',
                    transition: 'border-color var(--motion), background-color var(--motion)',
                  }}
                >
                  <input
                    type="radio"
                    name="embedding-preset"
                    value={p.provider}
                    checked={checked}
                    disabled={missingKey}
                    onChange={() => setSelected(p.provider)}
                    style={{ marginTop: 2 }}
                  />
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: 'block', fontSize: 12, color: 'var(--fg)' }}>{p.provider}</span>
                    <span
                      className="mono"
                      style={{ display: 'block', fontSize: 11, color: 'var(--dim)', fontVariantNumeric: 'tabular-nums' }}
                    >
                      {p.model ?? '—'} · {p.dim}d
                    </span>
                    {missingKey ? (
                      <span style={{ display: 'block', marginTop: 2, fontSize: 11, color: 'var(--warn)' }}>
                        needs {p.keyEnv} in the environment, not here
                      </span>
                    ) : null}
                  </span>
                </label>
              );
            })}
          </div>
        </div>

        {/* 4 — the store's widths. After a migration this is the dark window, as a number. */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <SectionLabel>store widths</SectionLabel>
          {buckets.length === 0 ? (
            <div style={{ fontSize: 11, color: 'var(--dim)' }}>no rows stored yet.</div>
          ) : (
            <Histogram buckets={buckets} />
          )}
          {info.stored.unreadable > 0 ? (
            <div style={{ fontSize: 11, lineHeight: 1.6, color: 'var(--danger)' }}>
              {info.stored.unreadable} rows the running provider cannot read — search skips them
            </div>
          ) : (
            <div style={{ fontSize: 11, lineHeight: 1.6, color: 'var(--dim)' }}>every row matches the running provider</div>
          )}
        </div>

        {/* 5 — the switch: write settings. The order is fixed and stated, not implied. */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <SectionLabel>switch</SectionLabel>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button
              type="button"
              className="btn"
              disabled={busy || preset === null || blocked.length > 0}
              style={{
                opacity: busy || preset === null || blocked.length > 0 ? 0.5 : 1,
                cursor: busy || preset === null || blocked.length > 0 ? 'not-allowed' : 'pointer',
              }}
              onClick={writeSettings}
            >
              {writing ? 'writing…' : 'write settings'}
            </button>
            <span className="mono" style={{ fontSize: 11, color: 'var(--dim)', minWidth: 0, wordBreak: 'break-all' }}>
              {info.settingsPath}
            </span>
          </div>
          <div style={{ fontSize: 11, color: 'var(--dim)', lineHeight: 1.6 }}>
            writing rewrites no vectors by itself. the order is write → dry run → migrate → restart, because the startup
            guard refuses a store that does not match the provider it is opened with.
          </div>
          {blocked.length > 0 ? (
            <div style={{ fontSize: 11, color: 'var(--danger)', lineHeight: 1.6 }}>
              {blocked.join(', ')} {blocked.length > 1 ? 'are' : 'is'} set in the environment, and the environment wins —
              the write would be refused, which is why this button is off. unset {blocked.length > 1 ? 'them' : 'it'} (or
              edit .env) and restart the server to switch here.
            </div>
          ) : switchError !== null ? (
            <div style={{ fontSize: 11, color: 'var(--danger)', whiteSpace: 'pre-wrap' }}>{switchError}</div>
          ) : null}
        </div>

        {/* 6 — migrate: dry run first, then the real run behind a confirm that names the cost. */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <SectionLabel>migrate</SectionLabel>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button
              type="button"
              className="btn"
              disabled={busy}
              style={{ opacity: busy ? 0.5 : 1, cursor: busy ? 'not-allowed' : 'pointer' }}
              onClick={runDry}
            >
              {pending ? 'working…' : 'dry run'}
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy || dry === null}
              style={{ opacity: busy || dry === null ? 0.5 : 1, cursor: busy || dry === null ? 'not-allowed' : 'pointer' }}
              onClick={() => setConfirmOpen(true)}
            >
              migrate
            </button>
            {dry === null ? (
              <span style={{ fontSize: 11, color: 'var(--faint)' }}>dry run first — it is the only count there is.</span>
            ) : null}
          </div>

          {dry !== null ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div style={{ fontSize: 11, color: 'var(--fg)', lineHeight: 1.6 }}>
                dry run: scanned <span className="mono">{dry.scanned}</span> · rewritten{' '}
                <span className="mono">{dry.rewritten}</span> · wouldFail <span className="mono">{dry.failed.length}</span>
              </div>
              <div style={{ fontSize: 11, color: 'var(--dim)', lineHeight: 1.6 }}>
                one embedding call per row, batched 64 at a time — a remote provider means real money, and rewritten is how
                many calls.
              </div>
              <FailedRows failed={dry.failed} />
            </div>
          ) : null}

          {running && activeJob !== null ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div className="mono" style={{ fontSize: 11, color: 'var(--fg)', fontVariantNumeric: 'tabular-nums' }}>
                {activeJob.done} / {activeJob.total} rows
              </div>
              <div style={{ height: 8, borderRadius: 2, background: 'var(--panel-2)', overflow: 'hidden' }}>
                <div
                  style={{
                    width: `${progress}%`,
                    height: '100%',
                    borderRadius: 2,
                    background: 'var(--accent)',
                    transition: 'width var(--motion)',
                  }}
                />
              </div>
            </div>
          ) : null}

          {migrated && activeJob !== null ? (
            <div
              className="hairline"
              style={{ padding: '7px 9px', fontSize: 11, lineHeight: 1.7, color: 'var(--warn)', display: 'flex', flexDirection: 'column', gap: 4 }}
            >
              <div>
                rewrote <span className="mono">{activeJob.rewritten}</span> of{' '}
                <span className="mono">{activeJob.scanned}</span> rows.
              </div>
              {/* Never a checkmark: every row is at the new width and this process is not. */}
              <div>restart now to restore search</div>
            </div>
          ) : null}

          {activeJob !== null && activeJob.state === 'error' ? (
            <div style={{ fontSize: 11, color: 'var(--danger)', whiteSpace: 'pre-wrap' }}>
              {activeJob.error ?? 'the migration job reported an error'}
            </div>
          ) : null}

          {activeJob !== null && activeJob.failed.length > 0 && !migrated ? <FailedRows failed={activeJob.failed} /> : null}

          {migrateError !== null ? (
            <div style={{ fontSize: 11, color: 'var(--danger)', whiteSpace: 'pre-wrap' }}>{migrateError}</div>
          ) : null}
        </div>
      </div>

      {dry !== null ? (
        <Confirm
          open={confirmOpen}
          danger
          title="migrate every row to the target provider?"
          confirmLabel={pending ? 'migrating…' : 'migrate'}
          disabled={pending}
          onCancel={() => setConfirmOpen(false)}
          onConfirm={runMigration}
          body={
            <>
              <div>
                this rewrites <span className="mono">{dry.scanned}</span> row{dry.scanned === 1 ? '' : 's'} —{' '}
                <span className="mono">{dry.rewritten}</span> embedding call{dry.rewritten === 1 ? '' : 's'}, batched 64 at
                a time. a remote provider means real money.
              </div>
              <div style={{ marginTop: 6, color: 'var(--danger)' }}>
                {'until the server restarts, searches will return nothing — every row is now at the new width'}
              </div>
            </>
          }
        />
      ) : null}
    </Panel>
  );
}

export default function StatsView({ namespace }: { namespace: string }) {
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [decaying, setDecaying] = useState(false);
  const [pruned, setPruned] = useState<number | null>(null);
  const [decayError, setDecayError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setLoading(true);
    api
      .stats(namespace, true)
      .then((s) => {
        if (!live) return;
        setStats(s);
        setError(null);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (!live) return;
        setError(errText(e));
        setStats(null);
        setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [namespace, nonce]);

  const runDecay = () => {
    setDecaying(true);
    setDecayError(null);
    api
      .decay()
      .then((r) => {
        setPruned(r.pruned);
        setConfirmOpen(false);
        setNonce((n) => n + 1);
      })
      .catch((e: unknown) => {
        setDecayError(errText(e));
        setConfirmOpen(false);
      })
      .finally(() => setDecaying(false));
  };

  if (loading && stats === null) {
    return (
      <div
        style={{
          display: 'grid',
          gap: 12,
          gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
        }}
      >
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="card" style={{ padding: '12px 14px' }}>
            <SkeletonBar width="55%" height={20} />
            <div style={{ marginTop: 10 }}>
              <SkeletonBar width="80%" height={6} />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (error !== null) {
    return (
      <Panel title="stats failed" subtitle={namespace}>
        <div className="mono" style={{ fontSize: 12, lineHeight: 1.6, color: 'var(--danger)', whiteSpace: 'pre-wrap' }}>
          {error}
        </div>
      </Panel>
    );
  }

  if (stats === null) return null;

  const candidates = stats.decayCandidates;

  const columns: Column<DecayCandidate>[] = [
    {
      key: 'id',
      header: 'id',
      mono: true,
      render: (row) => (
        <span title={row.id} style={{ fontSize: 10, color: 'var(--dim)' }}>
          {truncate(row.id, 14)}
        </span>
      ),
    },
    {
      key: 'type',
      header: 'type',
      width: '1%',
      render: (row) => <span style={{ fontSize: 11, color: 'var(--fg)' }}>{row.type}</span>,
    },
    {
      key: 'created',
      header: 'created',
      width: '1%',
      mono: true,
      render: (row) => (
        <span title={absTime(row.createdAt)} style={{ fontSize: 11, color: 'var(--dim)' }}>
          {relTime(row.createdAt)}
        </span>
      ),
    },
    {
      key: 'importance',
      header: 'imp',
      width: '1%',
      align: 'right',
      mono: true,
      render: (row) => <span style={{ fontSize: 11 }}>{score3(row.importance)}</span>,
    },
    {
      key: 'strength',
      header: 'str',
      width: '1%',
      align: 'right',
      mono: true,
      render: (row) => <span style={{ fontSize: 11 }}>{score3(row.strength)}</span>,
    },
    {
      key: 'text',
      header: 'text',
      render: (row) => (
        <span title={row.text} style={{ fontSize: 12, color: 'var(--fg)' }}>
          {truncate(row.text, 88)}
        </span>
      ),
    },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
        <StatCard label="total" value={stats.total} accent />
        <StatCard label="active / deleted" value={`${stats.active} / ${stats.deleted}`} />
        <StatCard label="pinned" value={stats.pinned} />
        <StatCard label="reinforced" value={stats.reinforced} sub="retrieved, or stronger than written" />
        <StatCard label="never used" value={stats.neverUsed} />
        <StatCard
          label="supersedes links / heads"
          value={`${stats.supersedesLinks} / ${stats.supersedeHeads}`}
          sub="replaced rows / current answers"
        />
        <StatCard label="text chars" value={stats.textChars} />
        <StatCard
          label="text tokens est."
          value={stats.textTokensEstimate}
          sub="a size, not a saving — the chars / 4 heuristic, nothing was saved"
        />
      </div>

      <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' }}>
        <Panel title="strength" subtitle="distribution of every row, tombstones included">
          <Histogram buckets={stats.strength} />
        </Panel>
        <Panel title="age" subtitle="since createdAt">
          <Histogram buckets={stats.age} />
        </Panel>
      </div>

      <Panel title="store" subtitle={stats.namespace}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <InfoRow label="namespace" value={stats.namespace} />
          <InfoRow label="db path" value={stats.dbPath ?? '—'} />
          <InfoRow label="db bytes" value={bytes(stats.dbBytes)} />
          <InfoRow label="embedding" value={`${stats.embedding} · dim ${stats.dim}`} />
          <InfoRow label="rows scanned" value={String(stats.rowsScanned)} />
        </div>
      </Panel>

      <EmbeddingsCard />

      <Panel
        title="decay"
        subtitle={`preview: ${candidates.length} candidate row${candidates.length === 1 ? '' : 's'} in ${stats.namespace}`}
        actions={
          <button
            type="button"
            className="btn"
            disabled={decaying}
            style={{ opacity: decaying ? 0.5 : 1, cursor: decaying ? 'not-allowed' : 'pointer' }}
            onClick={() => {
              setPruned(null);
              setDecayError(null);
              setConfirmOpen(true);
            }}
          >
            decay
          </button>
        }
      >
        {pruned !== null ? (
          <div className="hairline" style={{ marginBottom: 12, padding: '7px 9px', fontSize: 11, color: 'var(--fg)' }}>
            pruned <span className="mono">{pruned}</span> row{pruned === 1 ? '' : 's'}.
          </div>
        ) : null}
        {decayError !== null ? (
          <div
            className="hairline"
            style={{ marginBottom: 12, padding: '7px 9px', fontSize: 11, color: 'var(--danger)', whiteSpace: 'pre-wrap' }}
          >
            {decayError}
          </div>
        ) : null}
        <DataTable
          rows={candidates}
          columns={columns}
          rowKey={(row) => row.id}
          empty={
            <Empty
              title="nothing to prune"
              body="no row matches the decay predicates right now — nothing here is both old and weak."
            />
          }
        />
      </Panel>

      <Confirm
        open={confirmOpen}
        danger
        title="prune decay candidates?"
        confirmLabel={decaying ? 'pruning…' : 'prune'}
        disabled={decaying}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={runDecay}
        body={
          <>
            <div>
              this would prune <span className="mono">{candidates.length}</span> row
              {candidates.length === 1 ? '' : 's'} matching:
            </div>
            <div className="mono" style={{ marginTop: 6, fontSize: 11, color: 'var(--dim)' }}>
              {PREDICATES}
            </div>
            {/* The preview is the current partition; POST /decay takes no namespace and
                prunes the whole store, so the number it returns can be larger. */}
            <div style={{ marginTop: 6, fontSize: 11, color: 'var(--faint)', lineHeight: 1.6 }}>
              the count is the {stats.namespace} partition; the prune itself runs across every partition.
            </div>
          </>
        }
      />
    </div>
  );
}
