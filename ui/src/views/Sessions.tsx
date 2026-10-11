import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import type { SessionInfo, SessionTurn } from '../lib/api';
import { absTime, bytes, relTime, truncate } from '../lib/format';
import { Badge } from '../components/Badge';
import { DataTable, type Column } from '../components/DataTable';
import { Empty } from '../components/Empty';
import { KeyboardHint } from '../components/KeyboardHint';
import { Panel } from '../components/Panel';
import { useRoute } from '../router';

/**
 * D8 — pi's own transcripts, as a timeline, with the memory calls marked.
 *
 * Read-only by construction: `/sessions` and `/sessions/:id` are the only two calls this
 * view makes, and both are GETs over files this project does not own (`src/core/sessions.ts`
 * never writes either). The reason the timeline exists is the marked turns — what the agent
 * recalled, and when — so those get their full text while every other turn is a preview.
 */

const PAGE = 200;
const LIST_PAGE = 50;
const MEMORY_TOOLS = ['memory_search', 'memory_save', 'memory_recall'] as const;

/**
 * `clip` (src/core/sessions.ts:148-151) appends one ellipsis to the first `DEFAULT_CHARS`
 * (400) characters, so a clipped turn is exactly 401 characters and ends with it. That
 * signature is the only thing the wire carries — there is no `clipped` flag to read, and
 * `?full=1` (`maxChars: Infinity`, src/api/server.ts:284) is what removes the clip.
 */
const CLIP_LEN = 401;

function normalizeTool(tool: string): string {
  return tool.toLowerCase().replace(/[.\s-]+/g, '_');
}

/** `memory_search`, `memory.recall`, `mcp__open-memory__memory_save` all land here. */
function isMemoryTool(tool: string | null): boolean {
  if (tool === null) return false;
  const t = normalizeTool(tool);
  return MEMORY_TOOLS.some((name) => t === name || t.endsWith(`_${name}`));
}

/**
 * The `tool` field is checked first, because that is what the timeline is supposed to
 * match on — but on a real transcript it is always `null`: pi nests the name under
 * `message` (`{"message":{"role":"assistant","content":[{"type":"toolCall","name":"memory_search"…`),
 * and the wire parser reads `obj.tool ?? obj.toolName` at the top level only
 * (src/core/sessions.ts:158). A tool-call turn still arrives as its own raw line JSON,
 * so the fallback is the quoted key — prose that merely mentions `memory_search` has no
 * `"name":"memory_search"` in it and is not marked as a call.
 */
const MEMORY_TOOL_SIGNATURE = /"(?:tool|toolName|name)"\s*:\s*"memory[._](?:search|save|recall)"/i;

function isMemoryCall(turn: SessionTurn): boolean {
  return isMemoryTool(turn.tool) || MEMORY_TOOL_SIGNATURE.test(turn.text);
}

function isClipped(turn: SessionTurn): boolean {
  return turn.text.length === CLIP_LEN && turn.text.endsWith('…');
}

/**
 * The query, out of whatever the turn carries: a tool-call turn's text is the raw line
 * JSON (and is clipped unless `?full=1`), so the key is read textually and unescaped
 * rather than by parsing the whole line. It only ever fills a search box on click.
 */
const QUERY_IN_JSON = /"(?:query|q)"\s*:\s*"((?:[^"\\]|\\.)*)"/;

function queryOf(turn: SessionTurn): string {
  const match = QUERY_IN_JSON.exec(turn.text);
  const raw = match?.[1];
  if (raw === undefined || raw.trim() === '') return '';
  try {
    const unescaped: unknown = JSON.parse(`"${raw}"`);
    return truncate(typeof unescaped === 'string' ? unescaped : raw, 120);
  } catch {
    return truncate(raw, 120);
  }
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function markerColor(turn: SessionTurn): string {
  if (turn.isError) return 'var(--danger)';
  if (isMemoryCall(turn)) return 'var(--accent)';
  return 'var(--faint)';
}

function TurnRow({ turn, full }: { turn: SessionTurn; full: boolean }) {
  const memory = isMemoryCall(turn);
  const clipped = isClipped(turn);
  const q = memory ? queryOf(turn) : '';

  return (
    <li style={{ position: 'relative', padding: '8px 0 10px 16px', listStyle: 'none' }}>
      <span
        aria-hidden="true"
        style={{
          position: 'absolute',
          left: -4,
          top: 14,
          width: 7,
          height: 7,
          borderRadius: 2,
          background: markerColor(turn),
          border: '1px solid var(--panel)',
        }}
      />

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
        <Badge kind={turn.role === 'user' ? 'neutral' : turn.role === 'assistant' ? 'accent' : 'neutral'}>
          {turn.role}
        </Badge>
        {turn.tool !== null ? <Badge kind={memory ? 'accent' : 'neutral'}>{turn.tool}</Badge> : null}
        {memory ? <Badge kind="accent">memory</Badge> : null}
        {turn.isError ? <Badge kind="danger">error</Badge> : null}
        {clipped && !full ? <Badge kind="warn">clipped</Badge> : null}
        <span className="mono" style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--faint)' }}>
          #{turn.index}
        </span>
        <span className="mono" title={absTime(turn.timestamp)} style={{ fontSize: 10, color: 'var(--dim)' }}>
          {relTime(turn.timestamp)}
        </span>
      </div>

      {memory ? (
        <div
          className="hairline"
          style={{
            marginTop: 6,
            padding: '8px 10px',
            background: 'var(--panel-2)',
            borderLeft: '2px solid var(--accent)',
            borderRadius: 'var(--radius-sm)',
          }}
        >
          <div
            style={{
              fontSize: 10,
              letterSpacing: '.08em',
              textTransform: 'uppercase',
              color: 'var(--accent)',
              marginBottom: 4,
            }}
          >
            memory call — query / result as pi wrote it
          </div>
          {q === '' ? null : (
            <div className="mono" style={{ marginBottom: 4, fontSize: 12, color: 'var(--fg)' }}>
              query: {q}
            </div>
          )}
          <div
            className="mono"
            style={{
              fontSize: 12,
              lineHeight: 1.6,
              color: 'var(--fg)',
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
            }}
          >
            {clipped && !full ? `${turn.text}\n… the server clipped this turn at 400 chars` : turn.text}
          </div>
          <a
            href={`#/memories${q === '' ? '' : `?q=${encodeURIComponent(q)}`}`}
            style={{ display: 'inline-block', marginTop: 6, fontSize: 11 }}
            title={q === '' ? 'open Memories' : `search Memories for "${q}"`}
          >
            {q === '' ? 'open in Memories' : `search Memories for "${truncate(q, 40)}"`}
          </a>
        </div>
      ) : (
        <div
          style={{
            marginTop: 4,
            fontSize: 12,
            lineHeight: 1.6,
            color: turn.isError ? 'var(--danger)' : 'var(--dim)',
          }}
        >
          {truncate(turn.text, 180)}
        </div>
      )}
    </li>
  );
}

export default function SessionsView({ namespace }: { namespace: string }) {
  const { params, setParams } = useRoute();

  const sId = params.get('id');
  const full = params.get('full') === '1';

  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [root, setRoot] = useState<string | null>(null);
  const [sessionTotal, setSessionTotal] = useState(0);
  const [limit, setLimit] = useState(LIST_PAGE);
  const [listLoading, setListLoading] = useState(true);
  const [listTick, setListTick] = useState(0);
  const [turns, setTurns] = useState<SessionTurn[]>([]);
  const [lines, setLines] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detailTick, setDetailTick] = useState(0);

  const pageSeq = useRef(0);

  useEffect(() => {
    let live = true;
    setListLoading(true);
    api
      .sessions(limit)
      .then((res) => {
        if (!live) return;
        setSessions(res.sessions);
        setRoot(res.root);
        setSessionTotal(res.total);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!live) return;
        setSessions([]);
        setSessionTotal(0);
        setError(messageOf(e));
      })
      .finally(() => {
        if (live) setListLoading(false);
      });
    return () => {
      live = false;
    };
  }, [limit, listTick]);

  useEffect(() => {
    if (sId === null || sId === '') {
      setTurns([]);
      setLines(0);
      setTruncated(false);
      return;
    }
    const mine = ++pageSeq.current;
    setBusy(true);
    api
      .session(sId, { offset: 0, limit: PAGE, full })
      .then((res) => {
        if (mine !== pageSeq.current) return;
        setTurns(res.turns);
        setLines(res.total);
        setTruncated(res.truncated);
        setError(null);
      })
      .catch((e: unknown) => {
        if (mine !== pageSeq.current) return;
        setTurns([]);
        setLines(0);
        setTruncated(false);
        setError(messageOf(e));
      })
      .finally(() => {
        if (mine === pageSeq.current) setBusy(false);
      });
  }, [sId, full, detailTick]);

  async function loadMore(): Promise<void> {
    if (sId === null || sId === '') return;
    const mine = ++pageSeq.current;
    setBusy(true);
    try {
      const res = await api.session(sId, { offset: turns.length, limit: PAGE, full });
      if (mine !== pageSeq.current) return;
      setTurns((prev) => [...prev, ...res.turns]);
      setLines(res.total);
      setTruncated(res.truncated);
    } catch (e) {
      if (mine === pageSeq.current) setError(messageOf(e));
    } finally {
      if (mine === pageSeq.current) setBusy(false);
    }
  }

  const current = sessions.find((s) => s.id === sId) ?? null;
  const clippedCount = turns.reduce((acc, t) => acc + (isClipped(t) ? 1 : 0), 0);
  const memoryCount = turns.reduce((acc, t) => acc + (isMemoryCall(t) ? 1 : 0), 0);
  const more = turns.length > 0 && turns.length < lines;

  const columns: Column<SessionInfo>[] = [
    {
      key: 'dir',
      header: 'directory',
      render: (s) => (
        <span className="mono" style={{ fontSize: 11, color: 'var(--dim)' }}>
          {s.dir}
        </span>
      ),
    },
    {
      key: 'file',
      header: 'file',
      render: (s) => (
        <span className="mono" style={{ fontSize: 12, color: 'var(--fg)' }}>
          {s.file}
        </span>
      ),
    },
    {
      key: 'mtimeMs',
      header: 'modified',
      align: 'right',
      render: (s) => (
        <span className="mono" title={absTime(s.mtimeMs)} style={{ fontSize: 11, color: 'var(--dim)' }}>
          {relTime(s.mtimeMs)}
        </span>
      ),
    },
    {
      key: 'sizeBytes',
      header: 'size',
      align: 'right',
      mono: true,
      render: (s) => <span style={{ fontSize: 11 }}>{bytes(s.sizeBytes)}</span>,
    },
    {
      key: 'turns',
      header: 'turns',
      align: 'right',
      mono: true,
      render: (s) => (
        <span
          title="The list endpoint does not count lines — that would read every transcript. The count arrives when the file is opened."
          style={{ fontSize: 11, color: s.id === sId && lines > 0 ? 'var(--fg)' : 'var(--faint)' }}
        >
          {s.id === sId && lines > 0 ? lines : '—'}
        </span>
      ),
    },
  ];

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

      <Panel
        title="Sessions"
        subtitle={root === null ? 'resolving the sessions root…' : root}
        actions={
          <>
            <span className="mono" style={{ fontSize: 12, color: 'var(--dim)' }}>
              {listLoading ? '…' : `${sessions.length} of ${sessionTotal}`}
            </span>
            <button type="button" className="btn" onClick={() => setListTick((n) => n + 1)} disabled={listLoading}>
              refresh
            </button>
          </>
        }
        pad={false}
      >
        <DataTable
          rows={sessions}
          columns={columns}
          rowKey={(s) => s.id}
          selectedKey={sId}
          onSelect={(key) => setParams({ id: key })}
          onActivate={(row) => setParams({ id: row.id })}
          loading={listLoading}
          empty={
            <Empty
              title="No transcripts found"
              body={
                <>
                  Nothing under <span className="mono">{root ?? 'the sessions root'}</span> ends in{' '}
                  <span className="mono">.jsonl</span>. The root comes from the environment —{' '}
                  <span className="mono">PI_SESSIONS</span> wins, otherwise pi's default agent directory.
                </>
              }
            />
          }
        />
        {sessions.length < sessionTotal ? (
          <div style={{ padding: 10, display: 'flex', justifyContent: 'center' }}>
            <button type="button" className="btn" onClick={() => setLimit((n) => n + LIST_PAGE)}>
              load more sessions
            </button>
          </div>
        ) : null}
      </Panel>

      {sId === null || sId === '' ? (
        <Empty
          title="No session selected"
          body="Pick a transcript above and its timeline loads here: every turn, its role and time, and the memory calls marked with the query and result pi wrote."
        />
      ) : (
        <Panel
          title={current === null ? sId : current.file}
          subtitle={
            current === null
              ? undefined
              : `${current.dir} · ${absTime(current.mtimeMs)} · ${bytes(current.sizeBytes)}`
          }
          actions={
            <>
              <KeyboardHint keys={['j', 'k', 'Enter']} />
              <button type="button" className="btn" onClick={() => setDetailTick((n) => n + 1)} disabled={busy}>
                reload
              </button>
            </>
          }
        >
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
            <span className="mono" style={{ fontSize: 12, color: 'var(--fg)' }}>
              {turns.length} of {lines} lines
            </span>
            {memoryCount > 0 ? <Badge kind="accent">{memoryCount} memory calls</Badge> : null}
            {clippedCount > 0 && !full ? <Badge kind="warn">{clippedCount} clipped turns</Badge> : null}
            {truncated ? <Badge kind="warn">truncated</Badge> : null}
            <button
              type="button"
              className="btn"
              aria-pressed={full}
              onClick={() => setParams({ full: full ? undefined : 1 })}
              title="re-fetch with ?full=1 so per-turn text is not clipped at 400 chars"
            >
              {full ? 'full text: on' : 'full text: off'}
            </button>
          </div>

          {truncated ? (
            <div style={{ marginTop: 8, fontSize: 11, lineHeight: 1.6, color: 'var(--warn)' }}>
              The file is larger than the 24 MB read cap, so only its first part was read — “lines” above counts what
              was read, not what the file holds.
            </div>
          ) : null}

          <div style={{ marginTop: 8, fontSize: 11, color: 'var(--faint)' }}>
            Read-only: this view opens pi's transcripts and never writes them.
          </div>

          {busy && turns.length === 0 ? (
            <div className="empty" style={{ marginTop: 12 }}>
              reading {sId}
            </div>
          ) : turns.length === 0 ? (
            <Empty title="No turns" body="The file was read and holds no turn lines at this offset." />
          ) : (
            <ol
              style={{
                margin: '14px 0 0',
                padding: 0,
                listStyle: 'none',
                borderLeft: '1px solid var(--hairline)',
                marginLeft: 4,
              }}
            >
              {turns.map((turn) => (
                <TurnRow key={turn.index} turn={turn} full={full} />
              ))}
            </ol>
          )}

          {more ? (
            <div style={{ marginTop: 10, display: 'flex', justifyContent: 'center' }}>
              <button type="button" className="btn" onClick={() => void loadMore()} disabled={busy}>
                load more turns (offset {turns.length})
              </button>
            </div>
          ) : null}
        </Panel>
      )}
    </div>
  );
}
