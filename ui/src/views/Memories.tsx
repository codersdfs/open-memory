import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { api } from '../lib/api';
import type { Memory, MemoryStatus, MemoryType } from '../lib/api';
import { absTime, relTime, score3, truncate } from '../lib/format';
import { chainOf } from '../lib/supersede';
import { Badge } from '../components/Badge';
import { Confirm } from '../components/Confirm';
import { DataTable, type Column } from '../components/DataTable';
import { Drawer } from '../components/Drawer';
import { Empty } from '../components/Empty';
import { IconPin } from '../components/Icons';
import { KeyboardHint } from '../components/KeyboardHint';
import { RangeField } from '../components/RangeField';
import { useRoute } from '../router';

/**
 * D5 / D7 — the memory list and its governance actions.
 *
 * Every piece of view state a refresh would lose lives in the hash (D10), except the
 * two side panels, which are transient by nature. The list is read at one page size
 * and the store's own order is kept (`pin DESC, created_at DESC`, src/core/store/sqlite.ts:272):
 * `GET /memories` takes no `sort`, so a client-side sort would reorder a *page* and
 * claim to have sorted the set.
 */

const TYPES: readonly MemoryType[] = ['episodic', 'semantic', 'procedural', 'working'];
const STATUSES: readonly MemoryStatus[] = ['active', 'archived', 'draft', 'superseded'];

/** One page, above the drawer's need for the supersede chain — the chain is walked over
 *  these rows, so a shallow page is a short chain. */
const LIST_LIMIT = 200;
/** The server's own bound: `text required (1-5000 chars)` (src/api/server.ts:53). */
const MAX_TEXT = 5000;

const STATUS_KIND: Record<MemoryStatus, 'ok' | 'neutral' | 'warn' | 'accent'> = {
  active: 'ok',
  archived: 'neutral',
  draft: 'warn',
  superseded: 'accent',
};

/** `base.css` styles `.field input, .field select`; a control outside a `.field` carries its own. */
const controlStyle: CSSProperties = {
  font: 'inherit',
  fontSize: 13,
  padding: '5px 8px',
  color: 'var(--fg)',
  background: 'var(--panel)',
  border: '1px solid var(--hairline)',
  borderRadius: 'var(--radius-sm)',
};

const textareaStyle: CSSProperties = {
  display: 'block',
  width: '100%',
  minHeight: 180,
  resize: 'vertical',
  font: 'inherit',
  fontSize: 13,
  lineHeight: 1.6,
  padding: 8,
  color: 'var(--fg)',
  background: 'var(--panel-2)',
  border: '1px solid var(--hairline)',
  borderRadius: 'var(--radius-sm)',
};

function messageOf(e: unknown): string {
  // `ApiError` carries the server's own sentence ("text required (1-5000 chars)").
  return e instanceof Error ? e.message : String(e);
}

function asType(raw: string | null): MemoryType | '' {
  return raw !== null && (TYPES as readonly string[]).includes(raw) ? (raw as MemoryType) : '';
}

function asStatus(raw: string | null): MemoryStatus | '' {
  return raw !== null && (STATUSES as readonly string[]).includes(raw) ? (raw as MemoryStatus) : '';
}

/** One hop of the supersede chain: clickable, so the chain is navigable and not a list. */
function ChainRow({ memory, onPick }: { memory: Memory; onPick: (id: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => onPick(memory.id)}
      style={{
        all: 'unset',
        display: 'block',
        width: '100%',
        boxSizing: 'border-box',
        cursor: 'pointer',
        padding: '6px 8px',
        background: 'var(--panel-2)',
        border: '1px solid var(--hairline)',
        borderRadius: 'var(--radius-sm)',
      }}
    >
      <span className="mono" style={{ fontSize: 10, color: 'var(--faint)' }}>
        {truncate(memory.id, 30)}
      </span>
      <span style={{ display: 'block', marginTop: 3, fontSize: 12, lineHeight: 1.5, color: 'var(--fg)' }}>
        {truncate(memory.text, 90)}
      </span>
    </button>
  );
}

function MetaRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', padding: '5px 0' }}>
      <span
        style={{
          flex: '0 0 84px',
          fontSize: 10,
          letterSpacing: '.08em',
          textTransform: 'uppercase',
          color: 'var(--faint)',
        }}
      >
        {label}
      </span>
      <span style={{ minWidth: 0, fontSize: 12, color: 'var(--fg)', wordBreak: 'break-word' }}>{children}</span>
    </div>
  );
}

export default function MemoriesView({ namespace }: { namespace: string }) {
  const { params, setParams } = useRoute();

  const q = params.get('q') ?? '';
  const type = asType(params.get('type'));
  const status = asStatus(params.get('status'));
  const includeDeleted = params.get('deleted') === '1';
  const selectedId = params.get('id');

  const [draftQ, setDraftQ] = useState(q);
  const [rows, setRows] = useState<Memory[]>([]);
  const [total, setTotal] = useState(0);
  const [detail, setDetail] = useState<Memory | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  /** Which side panel is open: the detail drawer is open whenever an id is selected and no form covers it. */
  const [form, setForm] = useState<'create' | 'supersede' | null>(null);
  const [draft, setDraft] = useState<{ text: string; type: MemoryType; importance: number }>({
    text: '',
    type: 'episodic',
    importance: 0.5,
  });
  const [confirming, setConfirming] = useState<'delete' | 'supersede' | null>(null);

  const searchRef = useRef<HTMLInputElement>(null);
  const seq = useRef(0);

  // D6 — `/` reaches the search field. Letters typed into a field stay letters.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (
        t !== null &&
        (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)
      ) {
        return;
      }
      e.preventDefault();
      searchRef.current?.focus();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  // The input is local draft state; the hash only changes on submit, so typing does not
  // write history entries one keystroke at a time.
  useEffect(() => {
    setDraftQ(q);
  }, [q]);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    try {
      const res = await api.list({
        namespace,
        limit: LIST_LIMIT,
        q: q === '' ? undefined : q,
        type: type === '' ? undefined : type,
        status: status === '' ? undefined : status,
        includeDeleted: includeDeleted ? true : undefined,
      });
      if (mine !== seq.current) return;
      setRows(res.memories);
      setTotal(res.total);
      setError(null);
    } catch (e) {
      if (mine !== seq.current) return;
      setRows([]);
      setTotal(0);
      setError(messageOf(e));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [namespace, q, type, status, includeDeleted]);

  useEffect(() => {
    void load();
  }, [load, tick]);

  // The drawer reads the row by id rather than from the page: after a soft delete the row
  // leaves the list but must stay in the drawer, because that is where Restore lives.
  useEffect(() => {
    if (selectedId === null || selectedId === '') {
      setDetail(null);
      return;
    }
    let live = true;
    api
      .get(selectedId)
      .then((m) => {
        if (live) setDetail(m);
      })
      .catch((e: unknown) => {
        if (!live) return;
        setDetail(null);
        setError(messageOf(e));
      });
    return () => {
      live = false;
    };
  }, [selectedId, tick]);

  async function mutate<T>(fn: () => Promise<T>, after?: (value: T) => void): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const value = await fn();
      after?.(value);
      setTick((n) => n + 1);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  function openForm(kind: 'create' | 'supersede'): void {
    if (kind === 'supersede') {
      if (detail === null) return;
      setDraft({ text: detail.text, type: detail.type, importance: detail.importance });
    } else {
      setDraft({ text: '', type: 'episodic', importance: 0.5 });
    }
    setError(null);
    setForm(kind);
  }

  const trimmed = draft.text.trim();
  const textOk = trimmed.length > 0 && trimmed.length <= MAX_TEXT;

  function submitForm(): void {
    if (!textOk || form === null) return;
    if (form === 'create') {
      void mutate(
        () => api.create({ namespace, type: draft.type, text: trimmed, importance: draft.importance }),
        (created) => {
          setForm(null);
          setParams({ id: created.id });
        },
      );
      return;
    }
    setConfirming('supersede');
  }

  async function confirmSupersede(): Promise<void> {
    const old = detail;
    setConfirming(null);
    if (old === null) return;
    await mutate(
      () =>
        api.supersede(old.id, {
          namespace: old.namespace,
          type: draft.type,
          text: trimmed,
          importance: draft.importance,
          supersedesId: old.id,
        }),
      (created) => {
        setForm(null);
        setParams({ id: created.id });
      },
    );
  }

  async function confirmDelete(): Promise<void> {
    const row = detail;
    setConfirming(null);
    if (row === null) return;
    await mutate(() => api.remove(row.id));
  }

  const columns: Column<Memory>[] = [
    {
      key: 'text',
      header: 'memory',
      width: '42%',
      render: (m) => (
        <span title={truncate(m.text, 400)} style={{ color: 'var(--fg)' }}>
          {truncate(m.text, 80)}
        </span>
      ),
    },
    {
      key: 'type',
      header: 'type',
      render: (m) => (
        <span className="mono" style={{ fontSize: 11, color: 'var(--dim)' }}>
          {m.type}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'status',
      render: (m) => <Badge kind={STATUS_KIND[m.status]}>{m.status}</Badge>,
    },
    {
      key: 'importance',
      header: 'imp',
      align: 'right',
      mono: true,
      render: (m) => <span style={{ fontSize: 12 }}>{score3(m.importance)}</span>,
    },
    {
      key: 'strength',
      header: 'str',
      align: 'right',
      mono: true,
      render: (m) => <span style={{ fontSize: 12 }}>{score3(m.strength)}</span>,
    },
    {
      key: 'lastUsedAt',
      header: 'last used',
      render: (m) => (
        <span className="mono" title={absTime(m.lastUsedAt)} style={{ fontSize: 11, color: 'var(--dim)' }}>
          {relTime(m.lastUsedAt)}
        </span>
      ),
    },
    {
      key: 'pin',
      header: 'pin',
      width: '40px',
      render: (m) =>
        m.pin === 1 ? (
          <span style={{ display: 'inline-flex', color: 'var(--accent)' }} title="pinned">
            <IconPin size={13} />
          </span>
        ) : (
          <span style={{ color: 'var(--faint)' }}>—</span>
        ),
    },
    {
      key: 'superseded',
      header: 'supersedes',
      width: '120px',
      render: (m) =>
        m.supersedesId ? (
          <button
            type="button"
            className="mono"
            title={`supersedes ${m.supersedesId}`}
            onClick={(e) => {
              // The row's own click would otherwise select this row and discard the jump.
              e.stopPropagation();
              setParams({ id: m.supersedesId ?? undefined });
            }}
            style={{
              all: 'unset',
              cursor: 'pointer',
              fontSize: 10,
              color: 'var(--accent)',
            }}
          >
            {truncate(m.supersedesId, 14)}
          </button>
        ) : (
          <span style={{ color: 'var(--faint)' }}>—</span>
        ),
    },
  ];

  const chain = detail === null ? { ancestors: [], successors: [] } : chainOf(detail.id, rows);
  const ancestorMissing = detail !== null && detail.supersedesId != null && chain.ancestors.length === 0;
  const filtered = q !== '' || type !== '' || status !== '' || includeDeleted;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {error !== null ? (
        <div
          role="alert"
          className="hairline"
          style={{ padding: '8px 10px', fontSize: 12, color: 'var(--danger)', borderRadius: 'var(--radius-sm)' }}
        >
          {error}
        </div>
      ) : null}

      <div
        className="card"
        style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 12, padding: 12 }}
      >
        <label className="field">
          <span>search</span>
          <input
            ref={searchRef}
            value={draftQ}
            spellCheck={false}
            aria-label="Search memory text"
            placeholder="text contains…"
            onChange={(e) => setDraftQ(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              e.preventDefault();
              setParams({ q: draftQ.trim() === '' ? undefined : draftQ.trim(), id: undefined });
            }}
          />
        </label>

        <label className="field">
          <span>type</span>
          <select
            aria-label="Type"
            value={type}
            onChange={(e) => setParams({ type: e.currentTarget.value || undefined, id: undefined })}
          >
            <option value="">any</option>
            {TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>status</span>
          <select
            aria-label="Status"
            value={status}
            onChange={(e) => setParams({ status: e.currentTarget.value || undefined, id: undefined })}
          >
            <option value="">any</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>

        <label
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            height: 27,
            fontSize: 12,
            color: 'var(--dim)',
            cursor: 'pointer',
          }}
        >
          <input
            type="checkbox"
            checked={includeDeleted}
            onChange={(e) => setParams({ deleted: e.currentTarget.checked ? 1 : undefined, id: undefined })}
            style={{ accentColor: 'var(--accent)' }}
          />
          include tombstones
        </label>

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="mono" style={{ fontSize: 12, color: 'var(--dim)' }}>
            {loading ? '…' : `${rows.length} of ${total}`}
          </span>
          <button type="button" className="btn" onClick={() => setTick((n) => n + 1)} disabled={loading}>
            refresh
          </button>
          <button type="button" className="btn btn-primary" onClick={() => openForm('create')}>
            new memory
          </button>
        </div>
      </div>

      <div className="row" style={{ justifyContent: 'space-between', gap: 12 }}>
        <span style={{ fontSize: 11, color: 'var(--faint)' }}>
          {namespace} · the store's order (pinned first, then newest)
        </span>
        <KeyboardHint keys={['/', 'j', 'k', 'Enter', 'Esc']} />
      </div>

      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(m) => m.id}
        selectedKey={selectedId}
        onSelect={(key) => setParams({ id: key })}
        onActivate={(row) => setParams({ id: row.id })}
        loading={loading}
        empty={
          <Empty
            title={filtered ? 'Nothing matched' : `${namespace} is empty`}
            body={
              filtered
                ? 'No row in this namespace matches the current q / type / status / tombstone filters. The store answered, and the answer is zero rows.'
                : 'This namespace holds no memories yet. Create one here, or check the namespace in the header — the picker default is default:default.'
            }
            action={
              filtered ? (
                <button
                  type="button"
                  className="btn"
                  onClick={() => setParams({ q: undefined, type: undefined, status: undefined, deleted: undefined })}
                >
                  clear filters
                </button>
              ) : (
                <button type="button" className="btn btn-primary" onClick={() => openForm('create')}>
                  new memory
                </button>
              )
            }
          />
        }
      />

      <Drawer
        open={detail !== null && form === null}
        title={detail === null ? '' : truncate(detail.text, 44)}
        subtitle={detail === null ? undefined : `${detail.namespace} · ${truncate(detail.id, 34)}`}
        onClose={() => setParams({ id: undefined })}
        footer={
          detail === null ? null : (
            <>
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => void mutate(() => api.patchMeta(detail.id, { pin: detail.pin === 1 ? 0 : 1 }))}
              >
                {detail.pin === 1 ? 'unpin' : 'pin'}
              </button>
              <select
                aria-label="Status"
                value={detail.status}
                disabled={busy}
                style={{ ...controlStyle, fontSize: 12, padding: '4px 6px' }}
                onChange={(e) =>
                  void mutate(() => api.patchMeta(detail.id, { status: e.currentTarget.value as MemoryStatus }))
                }
              >
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => openForm('supersede')}
                style={{ marginLeft: 'auto' }}
              >
                supersede
              </button>
              {detail.isDeleted === 1 ? (
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={() => void mutate(() => api.patchMeta(detail.id, { isDeleted: 0 }))}
                >
                  restore
                </button>
              ) : (
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={() => setConfirming('delete')}
                  style={{ color: 'var(--danger)', borderColor: 'var(--danger)' }}
                >
                  delete
                </button>
              )}
            </>
          )
        }
      >
        {detail === null ? null : (
          <>
            <div
              style={{
                padding: '12px 14px',
                background: 'var(--panel-2)',
                border: '1px solid var(--hairline)',
                borderRadius: 'var(--radius)',
                fontFamily: 'var(--font-serif)',
                fontSize: 14,
                lineHeight: 1.7,
                whiteSpace: 'pre-wrap',
                overflowWrap: 'anywhere',
                color: 'var(--fg)',
              }}
            >
              {detail.text}
            </div>

            <div style={{ marginTop: 12 }}>
              <MetaRow label="type">
                <Badge kind="neutral">{detail.type}</Badge>{' '}
                <Badge kind={STATUS_KIND[detail.status]}>{detail.status}</Badge>
                {detail.pin === 1 ? <Badge kind="accent">pinned</Badge> : null}
                {detail.isDeleted === 1 ? <Badge kind="danger">deleted</Badge> : null}
              </MetaRow>
              <MetaRow label="importance">
                <span className="mono">{score3(detail.importance)}</span>
              </MetaRow>
              <MetaRow label="strength">
                <span className="mono">{score3(detail.strength)}</span>
              </MetaRow>
              <MetaRow label="last used">
                <span className="mono" title={absTime(detail.lastUsedAt)}>
                  {relTime(detail.lastUsedAt)}
                </span>
              </MetaRow>
              <MetaRow label="created">
                <span className="mono">{absTime(detail.createdAt)}</span>
              </MetaRow>
              <MetaRow label="updated">
                <span className="mono">{absTime(detail.updatedAt)}</span>
              </MetaRow>
              <MetaRow label="tags">
                {detail.tags && detail.tags.length > 0 ? (
                  <span className="mono">{detail.tags.join(' · ')}</span>
                ) : (
                  <span style={{ color: 'var(--faint)' }}>—</span>
                )}
              </MetaRow>
              <MetaRow label="source">
                {detail.source ? (
                  <span className="mono">{detail.source}</span>
                ) : (
                  <span style={{ color: 'var(--faint)' }}>—</span>
                )}
              </MetaRow>
              <MetaRow label="id">
                <span className="mono">{detail.id}</span>
              </MetaRow>
            </div>

            <div className="hairline-top" style={{ marginTop: 14, paddingTop: 12 }}>
              <div
                style={{
                  marginBottom: 8,
                  fontSize: 10,
                  letterSpacing: '.08em',
                  textTransform: 'uppercase',
                  color: 'var(--faint)',
                }}
              >
                supersede chain — older above, newer below
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {chain.ancestors
                  .slice()
                  .reverse()
                  .map((m) => (
                    <ChainRow key={m.id} memory={m} onPick={(id) => setParams({ id })} />
                  ))}
                {ancestorMissing ? (
                  <div style={{ fontSize: 11, lineHeight: 1.6, color: 'var(--dim)' }}>
                    the memory it supersedes is not on this page — the chain is walked over the {rows.length} loaded
                    rows, so clear q / type / status to bring the older row in with the page.
                  </div>
                ) : null}
                {chain.ancestors.length === 0 && !ancestorMissing ? (
                  <div style={{ fontSize: 11, color: 'var(--faint)' }}>no ancestor — this row is not a replacement</div>
                ) : null}

                <div
                  className="hairline"
                  style={{ padding: '6px 8px', background: 'var(--panel-2)', borderRadius: 'var(--radius-sm)' }}
                >
                  <span className="mono" style={{ fontSize: 10, color: 'var(--accent)' }}>
                    {truncate(detail.id, 30)} — current
                  </span>
                </div>

                {chain.successors.map((m) => (
                  <ChainRow key={m.id} memory={m} onPick={(id) => setParams({ id })} />
                ))}
                {chain.successors.length === 0 ? (
                  <div style={{ fontSize: 11, color: 'var(--faint)' }}>no successor — nothing supersedes this row</div>
                ) : null}
              </div>
            </div>
          </>
        )}
      </Drawer>

      <Drawer
        open={form !== null}
        title={form === 'supersede' ? 'Supersede memory' : 'New memory'}
        subtitle={form === 'supersede' && detail !== null ? truncate(detail.id, 40) : namespace}
        onClose={() => setForm(null)}
        footer={
          <>
            <button type="button" className="btn" onClick={() => setForm(null)}>
              cancel
            </button>
            <span
              className="mono"
              style={{ marginLeft: 'auto', fontSize: 10, color: textOk ? 'var(--faint)' : 'var(--danger)' }}
            >
              {trimmed.length}/{MAX_TEXT}
            </span>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!textOk || busy}
              onClick={submitForm}
              style={{ opacity: !textOk || busy ? 0.5 : 1, cursor: !textOk || busy ? 'not-allowed' : 'pointer' }}
            >
              {form === 'supersede' ? 'supersede' : 'create'}
            </button>
          </>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ fontSize: 11, lineHeight: 1.6, color: 'var(--dim)' }}>
            {form === 'supersede'
              ? 'A new memory in the same namespace. The text below starts as a copy of the old row — edit it.'
              : `Saved into ${namespace}. The store embeds it on write, so recall can find it immediately.`}
          </div>

          <textarea
            value={draft.text}
            spellCheck={false}
            aria-label="Memory text"
            placeholder="what should be remembered…"
            style={textareaStyle}
            onChange={(e) => setDraft({ ...draft, text: e.currentTarget.value })}
          />

          <label className="field">
            <span>type</span>
            <select
              aria-label="Type"
              value={draft.type}
              onChange={(e) => setDraft({ ...draft, type: e.currentTarget.value as MemoryType })}
            >
              {TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>

          <RangeField
            label="importance"
            min={0}
            max={1}
            step={0.01}
            value={draft.importance}
            onChange={(v) => setDraft({ ...draft, importance: v })}
            format={score3}
          />
        </div>
      </Drawer>

      <Confirm
        open={confirming === 'delete'}
        title="Soft-delete this memory?"
        body={
          detail === null ? null : (
            <>
              One row changes: <span className="mono">{truncate(detail.id, 22)}</span> gets{' '}
              <span className="mono">isDeleted = 1</span>. It leaves the list above (which holds{' '}
              <span className="mono">{total}</span> rows right now) unless "include tombstones" is on. Nothing is
              erased — the text and the embedding stay in the store, and Restore brings the row back.
            </>
          )
        }
        confirmLabel="soft delete"
        danger
        disabled={busy}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setConfirming(null)}
      />

      <Confirm
        open={confirming === 'supersede'}
        title="Supersede this memory?"
        body={
          detail === null ? null : (
            <>
              Writes <span className="mono">1</span> new memory and sets the status of{' '}
              <span className="mono">{truncate(detail.id, 22)}</span> to <span className="mono">superseded</span>. The old
              memory is <strong>not erased</strong> — a superseded row is a tombstone: it keeps its text and stops being
              the head of the chain. The namespace gains exactly one row; the list above (which holds{' '}
              <span className="mono">{total}</span> rows right now) changes only as far as the filters allow.
            </>
          )
        }
        confirmLabel="supersede"
        danger
        disabled={busy}
        onConfirm={() => void confirmSupersede()}
        onCancel={() => setConfirming(null)}
      />
    </div>
  );
}
