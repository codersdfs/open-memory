import { useEffect, useState } from 'react';
import { Badge } from '../components/Badge';
import { Panel } from '../components/Panel';
import { api } from '../lib/api';
import type { SettingsEntry, SettingsPayload } from '../lib/api';
import { effectBadge, maskedDisplay, needsAdoptBanner, sourceBadge } from '../lib/settings-model';

/**
 * `#/settings` — the one page that writes a credential.
 *
 * Three rules hold the whole view together:
 *
 * 1. A secret is never rendered in clear. The only value on the page is the masked tail
 *    `GET /settings` returns (src/core/settings.ts:326-328); an input is empty until the
 *    user types into it and is emptied again on save, so the console never holds a stored
 *    key long enough to print one.
 * 2. What a row *says* comes from the row: `source` and `effect` are reported per key by
 *    `settingsInventory` (src/core/settings.ts:383-413) and the words for them live in
 *    settings-model.ts, not in this JSX.
 * 3. The environment beats `settings.json`, so a row whose `source` is `env` cannot be
 *    written here — the server answers 400 naming it, and the row says so first.
 *
 * The nine embedding settings are deliberately not on this page: they stay in the
 * Embeddings card of Stats (ADR-0009), which is why the one link at the top exists.
 */

/**
 * The judge and extractor knobs as the spec groups them (S4). The Keys card does not
 * repeat this list — it takes every writable secret the inventory reports, so a key added
 * to `SECRET_KEYS` shows up here without an edit.
 */
const JUDGE_KEYS = ['JEV_ENDPOINT', 'JEV_MODEL', 'MEMORY_JEV', 'MEMORY_JEV_MIN'];
const EXTRACTOR_KEYS = ['ENABLE_EXTRACTOR', 'EXTRACTOR_MODEL'];

const RESTART_COMMAND = 'ai-memory daemon restart';

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * A 404 here is not "the key is wrong": it is a daemon that was started before this route
 * existed, and the page above it stays empty until it is restarted. Saying that beats
 * showing `HTTP 404` over an empty card.
 */
function loadError(e: unknown): string {
  const status = (e as { status?: number }).status;
  if (status === 404) {
    return `GET /settings answered 404 — the daemon serving this page predates the settings route. Run \`${RESTART_COMMAND}\` and reload.`;
  }
  return errText(e);
}

function RowName({ entry }: { entry: SettingsEntry }) {
  return (
    <span className="mono" style={{ fontSize: 12, color: 'var(--fg)' }}>
      {entry.name}
    </span>
  );
}

/** The two badges every row carries: where the value lives, and what changing it costs. */
function RowBadges({ entry }: { entry: SettingsEntry }) {
  return (
    <>
      <Badge kind={entry.source === 'env' ? 'warn' : 'neutral'}>{sourceBadge(entry.source)}</Badge>
      <Badge kind={entry.effect === 'restart' ? 'warn' : 'ok'}>{effectBadge(entry.effect)}</Badge>
    </>
  );
}

/**
 * One secret. The masked tail is the stored value; the field is a new one, on its way in.
 * A credential the environment supplies gets no field and no button — the write would be
 * refused, and offering the button only to show a 400 is a worse way to say that.
 */
function SecretRow({
  entry,
  draft,
  busy,
  onDraft,
  onSave,
}: {
  entry: SettingsEntry;
  draft: string;
  busy: boolean;
  onDraft: (value: string) => void;
  onSave: () => void;
}) {
  const shadowed = entry.writable && entry.source === 'env';

  return (
    <div
      className="hairline-top"
      style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '10px 0' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <RowName entry={entry} />
        <RowBadges entry={entry} />
        <span
          className="mono"
          style={{ marginLeft: 'auto', fontSize: 12, color: entry.masked === null ? 'var(--faint)' : 'var(--dim)' }}
        >
          {maskedDisplay(entry)}
        </span>
      </div>

      {entry.writable ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            aria-label={`New value for ${entry.name}`}
            placeholder={shadowed ? 'set in the environment — not writable here' : 'paste a new value'}
            value={draft}
            disabled={shadowed || busy}
            onChange={(e) => onDraft(e.target.value)}
            style={{
              flex: '1 1 auto',
              minWidth: 0,
              font: 'inherit',
              fontFamily: 'var(--font-mono)',
              fontSize: 12,
              padding: '4px 8px',
              color: 'var(--fg)',
              background: 'var(--panel-2)',
              border: '1px solid var(--hairline)',
              borderRadius: 'var(--radius-sm)',
            }}
          />
          <button type="button" className="btn" disabled={shadowed || busy} onClick={onSave}>
            save
          </button>
        </div>
      ) : (
        <div style={{ fontSize: 11, color: 'var(--faint)', lineHeight: 1.6 }}>
          read from the environment and not writable from the console — the judge still uses it.
        </div>
      )}

      {shadowed ? (
        <div style={{ fontSize: 11, color: 'var(--warn)', lineHeight: 1.6 }}>
          a real environment variable beats <span className="mono">settings.json</span>, so a save here would be
          refused — adopt below, or edit where it is set.
        </div>
      ) : null}
    </div>
  );
}

/** One non-secret knob: no value is read back, so an empty field means "leave it alone". */
function PlainRow({
  entry,
  draft,
  busy,
  onDraft,
  onSave,
}: {
  entry: SettingsEntry;
  draft: string;
  busy: boolean;
  onDraft: (value: string) => void;
  onSave: () => void;
}) {
  return (
    <div className="hairline-top" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', flexWrap: 'wrap' }}>
      <RowName entry={entry} />
      <RowBadges entry={entry} />
      <input
        autoComplete="off"
        spellCheck={false}
        aria-label={`New value for ${entry.name}`}
        placeholder="new value"
        value={draft}
        disabled={busy}
        onChange={(e) => onDraft(e.target.value)}
        style={{
          marginLeft: 'auto',
          font: 'inherit',
          fontFamily: 'var(--font-mono)',
          fontSize: 12,
          minWidth: 160,
          padding: '4px 8px',
          color: 'var(--fg)',
          background: 'var(--panel-2)',
          border: '1px solid var(--hairline)',
          borderRadius: 'var(--radius-sm)',
        }}
      />
      <button type="button" className="btn" disabled={busy} onClick={onSave}>
        save
      </button>
    </div>
  );
}

/**
 * The banner is the only way out of the shadowed case without a text editor: `adoptEnvKeys`
 * copies the whitelisted `.env` entries into `settings.json` and comments their lines out
 * (never deletes them), writing `.env.bak` first (src/core/settings.ts:242). The process
 * running now still holds what it read at boot, so the banner ends in "restart required".
 */
function AdoptBanner({
  entries,
  onAdopted,
}: {
  entries: SettingsEntry[];
  onAdopted: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ adopted: string[]; notAdopted: string[]; backupPath: string | null } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  const shadowed = entries.filter((e) => e.writable && e.source === 'env').map((e) => e.name);

  const adopt = () => {
    setBusy(true);
    setError(null);
    api
      .adoptEnv()
      .then((r) => {
        setResult({ adopted: r.adopted, notAdopted: r.notAdopted, backupPath: r.backupPath });
        onAdopted();
      })
      .catch((e: unknown) => setError(errText(e)))
      .finally(() => setBusy(false));
  };

  return (
    <div
      className="hairline"
      style={{
        padding: '10px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        color: 'var(--warn)',
        fontSize: 12,
        lineHeight: 1.65,
      }}
    >
      <div>
        {shadowed.length === 1 ? 'One setting comes' : `${shadowed.length} settings come`} from the
        environment: <span className="mono">{shadowed.join(', ')}</span>. The environment wins over{' '}
        <span className="mono">settings.json</span>, so nothing saved here can change them.
      </div>
      <div style={{ color: 'var(--dim)' }}>
        adopt moves them into <span className="mono">settings.json</span> and comments their{' '}
        <span className="mono">.env</span> lines out — nothing is deleted, and a{' '}
        <span className="mono">.env.bak</span> is written first. restart required.
      </div>
      <div className="row">
        <button type="button" className="btn btn-primary" disabled={busy} onClick={adopt}>
          {busy ? 'adopting…' : 'adopt .env values'}
        </button>
      </div>
      {result !== null ? (
        <div style={{ color: 'var(--dim)' }}>
          {result.adopted.length > 0 ? (
            <div>
              adopted <span className="mono">{result.adopted.join(', ')}</span>
              {result.backupPath !== null ? (
                <>
                  {' '}
                  — backup at <span className="mono">{result.backupPath}</span>
                </>
              ) : null}
              . restart required.
            </div>
          ) : (
            <div>nothing to adopt — no whitelisted name was sitting in .env.</div>
          )}
          {result.notAdopted.length > 0 ? (
            <div>
              stayed in <span className="mono">.env</span>:{' '}
              <span className="mono">{result.notAdopted.join(', ')}</span> (not console fields)
            </div>
          ) : null}
        </div>
      ) : null}
      {error !== null ? (
        <div className="mono" style={{ color: 'var(--danger)', whiteSpace: 'pre-wrap' }}>
          {error}
        </div>
      ) : null}
    </div>
  );
}

/** `ai-memory daemon restart`, with the copy button the spec asks for. */
function RestartLine({ pending }: { pending: boolean }) {
  const [copied, setCopied] = useState<'idle' | 'done' | 'failed'>('idle');

  const copy = () => {
    // Clipboard access is missing on an insecure origin, so a refused copy has to say so
    // rather than look like it worked.
    navigator.clipboard
      .writeText(RESTART_COMMAND)
      .then(() => setCopied('done'))
      .catch(() => setCopied('failed'));
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 12 }}>
      <span style={{ color: pending ? 'var(--warn)' : 'var(--dim)' }}>
        {pending ? 'restart required — the running process keeps what it read at boot:' : 'applies on the next start:'}
      </span>
      <span className="mono" style={{ fontSize: 12, color: 'var(--fg)' }}>
        {RESTART_COMMAND}
      </span>
      <button type="button" className="btn" onClick={copy}>
        {copied === 'done' ? 'copied' : 'copy'}
      </button>
      {copied === 'failed' ? (
        <span style={{ color: 'var(--dim)' }}>copy unavailable — select the command above</span>
      ) : null}
    </div>
  );
}

export default function SettingsView() {
  const [payload, setPayload] = useState<SettingsPayload | null>(null);
  const [loadFailure, setLoadFailure] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let live = true;
    api
      .getSettings()
      .then((p) => {
        if (!live) return;
        setPayload(p);
        setLoadFailure(null);
      })
      .catch((e: unknown) => {
        if (!live) return;
        setPayload(null);
        setLoadFailure(loadError(e));
      });
    return () => {
      live = false;
    };
  }, [nonce]);

  const refresh = () => setNonce((n) => n + 1);

  const save = (entry: SettingsEntry) => {
    const value = (draft[entry.name] ?? '').trim();
    if (value === '') {
      setRowError(`${entry.name}: type a new value first — an empty field writes nothing.`);
      return;
    }
    setBusy(entry.name);
    setRowError(null);
    setNotice(null);
    api
      .patchSettings({ [entry.name]: value })
      // The typed value is dropped before the re-read: nothing keeps a key in memory after
      // the write that needed it.
      .then((r) => {
        setDraft((d) => ({ ...d, [entry.name]: '' }));
        // `restartRequired` is the server's measurement of the whole settings file against the
        // live process, not a verdict on the row just saved — every row on this page is an
        // immediate key, so a pending restart here belongs to the embedding settings.
        setNotice(
          r.restartRequired
            ? `${r.saved.join(', ')} saved — live on the next call; the restart the embedding settings ask for is still pending.`
            : `${r.saved.join(', ')} saved — live on the next call, no restart needed.`,
        );
        refresh();
      })
      .catch((e: unknown) => setRowError(errText(e)))
      .finally(() => setBusy(null));
  };

  const row = (entry: SettingsEntry) => ({
    entry,
    draft: draft[entry.name] ?? '',
    busy: busy === entry.name,
    onDraft: (value: string) => setDraft((d) => ({ ...d, [entry.name]: value })),
    onSave: () => save(entry),
  });

  const entries = payload?.entries ?? [];
  const secrets = entries.filter((e) => e.kind === 'secret');
  const plain = (names: string[]) =>
    names.flatMap((name) => entries.filter((e) => e.name === name && e.writable));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <h2>Settings</h2>
        <a href="#/stats" style={{ fontSize: 12 }}>
          the Embedding 9 stay in the Stats card →
        </a>
      </div>

      {loadFailure !== null ? (
        <Panel title="settings unavailable">
          <div className="mono" style={{ fontSize: 12, lineHeight: 1.7, color: 'var(--danger)', whiteSpace: 'pre-wrap' }}>
            {loadFailure}
          </div>
        </Panel>
      ) : null}

      {payload === null && loadFailure === null ? (
        <div className="mono" style={{ fontSize: 12, color: 'var(--faint)' }}>
          loading settings…
        </div>
      ) : null}

      {payload !== null && needsAdoptBanner(payload.entries) ? (
        <AdoptBanner entries={payload.entries} onAdopted={refresh} />
      ) : null}

      {notice !== null ? (
        <div style={{ fontSize: 12, color: 'var(--ok)', lineHeight: 1.6 }}>{notice}</div>
      ) : null}
      {rowError !== null ? (
        <div className="mono" style={{ fontSize: 12, color: 'var(--danger)', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
          {rowError}
        </div>
      ) : null}

      {payload !== null ? (
        <>
          <Panel
            title="keys"
            subtitle="stored in settings.json, masked on the way back out, read per call — no restart"
          >
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <div style={{ fontSize: 11, color: 'var(--faint)', lineHeight: 1.6, paddingBottom: 6 }}>
                a value is shown only as its masked tail; a new one is sent only when you type it.
              </div>
              {secrets.map((entry) => (
                <SecretRow key={entry.name} {...row(entry)} />
              ))}
            </div>
          </Panel>

          <Panel title="judge" subtitle="JEV endpoint, model and the two switches — read per call, no restart">
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <div style={{ fontSize: 11, color: 'var(--faint)', lineHeight: 1.6, paddingBottom: 6 }}>
                a plain value is not read back — the badge says where the one in force comes from, and an
                empty field leaves it alone.
              </div>
              {plain(JUDGE_KEYS).map((entry) => (
                <PlainRow key={entry.name} {...row(entry)} />
              ))}
            </div>
          </Panel>

          <Panel title="extractor" subtitle="the extractor shares OPENAI_API_KEY with the embeddings">
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <div style={{ fontSize: 11, color: 'var(--faint)', lineHeight: 1.6, paddingBottom: 6 }}>
                extraction runs on <span className="mono">OPENAI_API_KEY</span>, saved in the keys card above.
              </div>
              {plain(EXTRACTOR_KEYS).map((entry) => (
                <PlainRow key={entry.name} {...row(entry)} />
              ))}
            </div>
          </Panel>

          <Panel title="restart" subtitle="one process, one vector space">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <RestartLine pending={payload.restartRequired} />
              <div className="mono" style={{ fontSize: 11, color: 'var(--faint)', lineHeight: 1.7, wordBreak: 'break-all' }}>
                settings {payload.settingsPath}
                <br />
                env {payload.envPath}
              </div>
            </div>
          </Panel>
        </>
      ) : null}
    </div>
  );
}
