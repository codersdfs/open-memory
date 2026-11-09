import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { api } from '../lib/api';
import type { AgentStatus, AgentTraceStep, Memory, SearchResult, SearchResultItem } from '../lib/api';
import { respond, preflight, SUGGESTIONS } from '../lib/agent';
import type { AgentBlock } from '../lib/agent';
import { score3, truncate, relTime } from '../lib/format';
import { explainSegments } from '../lib/score';
import { ScoreBar } from '../components/ScoreBar';
import { Badge } from '../components/Badge';
import { IconArrowUp, IconCheck, IconShield } from '../components/Icons';

/**
 * ADR-0043 — the Agent view: a conversation over your own store. The brain is
 * `lib/agent.ts` (LLM tool loop when the daemon has a key, deterministic commands
 * when it does not — the pill in the composer names which one answered). The view
 * itself only renders blocks and keeps the thread: every number a block shows came
 * off the wire, the same D4 rule Recall runs under.
 *
 * The thread persists in localStorage (capped) rather than the hash: a conversation
 * is session state, not a shareable query. Refresh restores it; a namespace switch
 * starts a fresh one, because mixing partitions inside one transcript would mislead.
 */

const THREAD_KEY = 'om-agent-thread';
const THREAD_LIMIT = 40;
const MAX_INPUT = 2000;

interface Turn {
  id: number;
  role: 'user' | 'agent';
  blocks: AgentBlock[];
}

function loadThread(): Turn[] {
  try {
    const raw = localStorage.getItem(THREAD_KEY);
    if (raw === null) return [];
    const parsed = JSON.parse(raw) as { role?: string; blocks?: unknown }[];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((t) => (t.role === 'user' || t.role === 'agent') && Array.isArray(t.blocks))
      .slice(-THREAD_LIMIT)
      .map((t, i) => ({ id: i, role: t.role as 'user' | 'agent', blocks: t.blocks as AgentBlock[] }));
  } catch {
    return [];
  }
}

function saveThread(turns: Turn[]): void {
  try {
    localStorage.setItem(THREAD_KEY, JSON.stringify(turns.slice(-THREAD_LIMIT)));
  } catch {
    // A full or blocked storage must not take the conversation down with it.
  }
}

/** The intro is a designed answer, not a greeting: it names what the agent can do. */
const INTRO: Turn[] = [
  {
    id: -1,
    role: 'agent',
    blocks: [
      {
        kind: 'text',
        text: '这是你自己的记忆库。可以问它(直接打字即检索),也可以让它记住——写入门会照常把关,被拒绝时给出原因。',
      },
    ],
  },
];

function Blocks({ blocks }: { blocks: AgentBlock[] }) {
  return (
    <>
      {blocks.map((b, i) => (
        <Block key={i} block={b} />
      ))}
    </>
  );
}

function Block({ block }: { block: AgentBlock }) {
  switch (block.kind) {
    case 'text':
      return <p className="agent-text">{block.text}</p>;
    case 'hits':
      return <Hits result={block.result} />;
    case 'saved':
      return <Saved memory={block.memory} />;
    case 'rejected':
      return (
        <div
          role="alert"
          className="card"
          style={{ padding: '12px 14px', borderLeft: '2px solid var(--danger)', display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 620 }}
        >
          <div className="row" style={{ gap: 8, fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--danger)' }}>
            <IconShield size={13} />
            <span>{block.title}</span>
          </div>
          <p style={{ fontSize: 13, lineHeight: 1.7, color: 'var(--dim)' }}>{block.advice}</p>
        </div>
      );
    case 'brief':
      return (
        <div className="card" style={{ padding: '4px 14px', maxWidth: 620 }}>
          <pre
            style={{
              margin: 0,
              padding: '10px 0',
              fontFamily: 'var(--font-mono)',
              fontSize: 12,
              lineHeight: 1.7,
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
              color: 'var(--fg)',
            }}
          >
            {block.result.text}
          </pre>
          <div className="legend" style={{ borderTop: '1px solid var(--hairline)', padding: '8px 0' }}>
            <span>
              {block.result.tokensUsed} / {block.result.budgetTokens} tokens
            </span>
            {block.result.truncated ? <span>truncated</span> : null}
          </div>
        </div>
      );
    case 'stats':
      return (
        <div className="card" style={{ padding: '12px 14px', maxWidth: 620, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div className="mono" style={{ fontSize: 12, color: 'var(--fg)' }}>
            {block.namespace} · {block.total} rows
          </div>
          <div className="legend">
            {Object.entries(block.byType).map(([t, n]) => (
              <span key={t}>
                <span className={`tdot ${t}`} aria-hidden="true" />
                {t} {n}
              </span>
            ))}
          </div>
        </div>
      );
    case 'trace':
      return <Trace steps={block.steps} model={block.model} />;
    case 'error':
      return (
        <div
          role="alert"
          className="mono"
          style={{ fontSize: 12, lineHeight: 1.6, color: 'var(--danger)', whiteSpace: 'pre-wrap' }}
        >
          {block.text}
        </div>
      );
  }
}

function Hit({ hit }: { hit: SearchResultItem }) {
  return (
    <div className="hit" style={{ padding: '12px 0' }}>
      <div className="hit-head">
        <span className={`tdot ${hit.type}`} aria-hidden="true" />
        <span className="mono" style={{ fontSize: 11, color: 'var(--dim)' }}>
          {hit.type}
        </span>
        {hit.status !== 'active' ? <Badge kind="warn">{hit.status}</Badge> : null}
        {hit.pin === 1 ? <Badge kind="accent">pinned</Badge> : null}
        <span className="spacer" />
        <span className="hit-score">{score3(hit.score)}</span>
      </div>
      <div className="hit-text">{truncate(hit.text, 300)}</div>
      {hit.explain ? <ScoreBar segments={explainSegments(hit.explain)} total={hit.score} /> : null}
    </div>
  );
}

function Hits({ result }: { result: SearchResult }) {
  if (result.memories.length === 0) {
    const floor = result.diagnostics?.threshold;
    return (
      <div className="empty" style={{ textAlign: 'left', maxWidth: 620 }}>
        没有越线的结果——空是设计好的答案,不是故障。
        {floor !== undefined ? <span className="mono"> floor {score3(floor)}.</span> : null}
      </div>
    );
  }
  return (
    <div className="list" style={{ maxWidth: 620 }}>
      {result.memories.map((m, i) => (
        <div key={m.id} style={{ padding: '2px 14px', borderTop: i === 0 ? undefined : '1px solid var(--hairline)' }}>
          <Hit hit={m} />
        </div>
      ))}
      <div className="hit" style={{ padding: '8px 14px' }}>
        <div className="legend">
          <span>
            预算 {result.tokensUsed} tokens{result.truncated ? ' · truncated' : ''}
          </span>
        </div>
      </div>
    </div>
  );
}

function Saved({ memory }: { memory: Memory }) {
  return (
    <div
      className="card"
      style={{ padding: '12px 14px', borderLeft: '2px solid var(--ok)', maxWidth: 620, display: 'flex', flexDirection: 'column', gap: 7 }}
    >
      <div className="row" style={{ gap: 8, fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--ok)' }}>
        <IconCheck size={13} />
        <span>已存入 {memory.namespace}</span>
      </div>
      <p style={{ fontSize: 13, lineHeight: 1.65, color: 'var(--fg)', overflowWrap: 'anywhere' }}>{memory.text}</p>
      <div className="legend">
        <span>{memory.type}</span>
        <span>imp {score3(memory.importance)}</span>
        <span>{truncate(memory.id, 20)}</span>
        <span>{relTime(memory.createdAt)}</span>
      </div>
    </div>
  );
}

function Trace({ steps, model }: { steps: AgentTraceStep[]; model: string }) {
  return (
    <div className="steps" aria-label="工具轨迹">
      <div className="steps-cap">
        worked · {steps.length} step{steps.length === 1 ? '' : 's'} · {model}
      </div>
      {steps.map((s, i) => (
        <div key={i} className="step">
          <span style={{ color: 'var(--faint)' }}>{String(i + 1).padStart(2, '0')}</span>
          <span>
            <b>{s.tool}</b> · {s.summary}
          </span>
        </div>
      ))}
    </div>
  );
}

function Thinking(): ReactNode {
  // SMIL, not a spinner and not a CSS keyframe (the project's own motion ban):
  // three dots breathing opacity, same trick the other views' skeletons use.
  return (
    <div className="step" aria-label="正在思考">
      {[0, 1, 2].map((i) => (
        <svg key={i} width={5} height={5} viewBox="0 0 5 5" aria-hidden="true">
          <circle cx="2.5" cy="2.5" r="2.5" fill="var(--faint)">
            <animate attributeName="opacity" values=".3;1;.3" keyTimes="0;.5;1" dur="1.1s" begin={`${i * 0.15}s`} repeatCount="indefinite" />
          </circle>
        </svg>
      ))}
      <span style={{ color: 'var(--faint)' }}>正在工作…</span>
    </div>
  );
}

export default function AgentView({ namespace }: { namespace: string }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const idRef = useRef(0);
  const scroller = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const busyRef = useRef(false);

  // One thread per namespace: switching partitions mid-transcript would put answers
  // from one partition under questions from another.
  useEffect(() => {
    setTurns(loadThread().length === 0 ? INTRO : loadThread());
    setStatus(null);
    void preflight().then(setStatus).catch(() => {});
  }, [namespace]);

  useEffect(() => {
    saveThread(turns.filter((t) => t.id !== -1));
  }, [turns]);

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns, busy]);

  const autosize = useCallback(() => {
    const el = inputRef.current;
    if (el === null) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, []);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (trimmed === '' || busyRef.current) return;
      busyRef.current = true;
      setError(null);
      setBusy(true);
      const userTurn: Turn = { id: idRef.current++, role: 'user', blocks: [{ kind: 'text', text: trimmed }] };
      setTurns((prev) => [...prev, userTurn]);
      setInput('');
      if (inputRef.current !== null) inputRef.current.style.height = 'auto';
      try {
        const result = await respond(trimmed, namespace);
        setTurns((prev) => [...prev, { id: idRef.current++, role: 'agent', blocks: result.blocks }]);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [namespace],
  );

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send(input);
    }
  }

  const canSend = input.trim() !== '' && !busy;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
      <div
        ref={scroller}
        style={{ maxHeight: 'calc(100vh - 300px)', minHeight: 320, overflowY: 'auto', paddingRight: 4 }}
      >
        <div className="thread" role="log" aria-live="polite" aria-label="Agent 对话">
          {turns.map((t) =>
            t.role === 'user' ? (
              <div key={t.id} className="msg-user">
                {t.blocks.map((b, i) => (b.kind === 'text' ? <span key={i}>{b.text}</span> : null))}
              </div>
            ) : (
              <div key={t.id} className="msg-agent">
                <div className="agent-ava" aria-hidden="true" />
                <div className="agent-body">
                  <div className="agent-name-row">
                    <span className="agent-name">open-memory</span>
                    <span className="chip">{status?.llm ? `agent · ${status.model ?? 'llm'}` : 'local · 确定性'}</span>
                  </div>
                  <Blocks blocks={t.blocks} />
                </div>
              </div>
            ),
          )}
          {busy ? (
            <div className="msg-agent">
              <div className="agent-ava" aria-hidden="true" />
              <div className="agent-body">
                <Thinking />
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {error !== null ? (
        <div role="alert" className="mono" style={{ margin: '12px 0 0', fontSize: 12, color: 'var(--danger)' }}>
          {error}
        </div>
      ) : null}

      <div className="row" style={{ gap: 6, flexWrap: 'wrap', margin: '14px 0 8px' }}>
        {SUGGESTIONS.map((s) => (
          <button key={s} type="button" className="chip" style={{ cursor: 'pointer', padding: '3px 10px' }} onClick={() => void send(s)}>
            {s}
          </button>
        ))}
      </div>

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send(input);
        }}
      >
        <div className="composer-main">
          <textarea
            ref={inputRef}
            value={input}
            rows={1}
            spellCheck={false}
            aria-label="对 Agent 说话"
            placeholder="问记忆,或说「记住…」"
            maxLength={MAX_INPUT}
            onChange={(e) => {
              setInput(e.currentTarget.value);
              autosize();
            }}
            onKeyDown={onKeyDown}
          />
        </div>
        <div className="composer-bar">
          <span className="chip" title={status?.llm ? '服务端有 key:走 LLM 工具循环' : '服务端无 key:本地确定性命令'}>
            <span className={`tdot ${status?.llm ? 'procedural' : 'working'}`} aria-hidden="true" />
            {status?.llm ? 'llm' : 'local'}
          </span>
          <span className="legend">
            <span className="kbd">⇧↵</span> 换行
            <span className="kbd" style={{ marginLeft: 6 }}>
              ↵
            </span>
            发送
          </span>
          <span className="spacer" style={{ flex: 1 }} />
          <span className={`composer-count${input.length > 0 ? ' has' : ''}`}>
            {input.length} / {MAX_INPUT}
          </span>
          <button type="submit" className="send" disabled={!canSend} aria-label="发送">
            <IconArrowUp size={15} />
          </button>
        </div>
      </form>
    </div>
  );
}
