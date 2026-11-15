import { useState } from 'react';
import { api, setStoredPrincipalToken } from '../lib/api';

/**
 * The console's principal gate (ADR-0049). The daemon serves one principal and gives
 * its token to nobody — not to a page it renders, not to any unauthenticated reader —
 * so the browser authenticates the way the CLI does: the operator supplies the token.
 * One paste, kept in localStorage for this origin; a wrong token is refused here before
 * it is ever stored, by probing a gated route with it.
 */
export default function PrincipalGate({ onUnlocked }: { onUnlocked: () => void }) {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    setStoredPrincipalToken(token.trim() || null);
    try {
      await api.namespaces();
      onUnlocked();
    } catch (e) {
      setStoredPrincipalToken(null);
      const status = (e as { status?: number }).status;
      setError(status === 401 ? 'the daemon rejected that token' : 'the daemon is unreachable');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="content"
      style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '80vh' }}
    >
      <div className="field" style={{ flexDirection: 'column', gap: 10, minWidth: 360 }}>
        <span>principal locked</span>
        <p className="muted" style={{ margin: 0 }}>
          This daemon serves one principal and answers 401 without its token. Paste it once —
          it is stored in this browser only, never rendered by the server.
        </p>
        <input
          value={token}
          type="password"
          autoFocus
          spellCheck={false}
          aria-label="Principal token"
          placeholder="x-ai-memory-principal"
          onChange={(e) => setToken(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && token.trim()) void submit();
          }}
        />
        <div className="row">
          <button type="button" className="btn" disabled={busy || !token.trim()} onClick={() => void submit()}>
            unlock
          </button>
        </div>
        {error && <div className="mono health-down">{error}</div>}
        <div className="mono muted" style={{ fontSize: 12 }}>
          where the token lives: the daemon&apos;s key file — print it with `ai-memory principal reveal`
        </div>
      </div>
    </div>
  );
}
