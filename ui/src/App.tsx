import { useEffect, useState } from 'react';
import { useRoute, type ViewName } from './router';
import { useTheme, type ThemeChoice } from './theme';
import RecallView from './views/Recall';
import MemoriesView from './views/Memories';
import SessionsView from './views/Sessions';
import GraphView from './views/Graph';
import StatsView from './views/Stats';

const NAV: readonly { view: ViewName; label: string }[] = [
  { view: 'recall', label: 'Recall' },
  { view: 'memories', label: 'Memories' },
  { view: 'sessions', label: 'Sessions' },
  { view: 'graph', label: 'Graph' },
  { view: 'stats', label: 'Stats' },
];

const THEMES: readonly ThemeChoice[] = ['auto', 'dark', 'light'];
const NS_KEY = 'om-namespace';
const HEALTH_INTERVAL = 15000;

type Health = { ok?: boolean; embedding?: string; dim?: number; version?: string };

export default function App() {
  const route = useRoute();
  const theme = useTheme();
  const [namespace, setNamespace] = useState(() => localStorage.getItem(NS_KEY) ?? 'default:default');
  const [health, setHealth] = useState<Health | null>(null);
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    localStorage.setItem(NS_KEY, namespace);
  }, [namespace]);

  useEffect(() => {
    let live = true;
    const load = () => {
      fetch('/health')
        .then((r) => (r.ok ? (r.json() as Promise<Health>) : null))
        .then((h) => {
          if (!live) return;
          setHealth(h);
          setOffline(h === null);
        })
        .catch(() => {
          if (!live) return;
          setHealth(null);
          setOffline(true);
        });
    };
    load();
    const timer = setInterval(load, HEALTH_INTERVAL);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);

  const healthText = offline ? 'unreachable' : health?.version ? `v${health.version}` : 'checking';

  return (
    <div className="shell">
      <nav className="rail" aria-label="Views">
        <div className="rail-brand mono">open-memory</div>
        {NAV.map((item) => (
          <a
            key={item.view}
            className="rail-item"
            href={`#/${item.view}`}
            aria-current={route.view === item.view ? 'page' : undefined}
          >
            {item.label}
          </a>
        ))}
      </nav>

      <div className="content">
        <header className="header">
          <div className="field">
            <span>namespace</span>
            <input
              value={namespace}
              spellCheck={false}
              aria-label="Namespace"
              onChange={(e) => setNamespace(e.target.value)}
            />
          </div>

          <div className="field">
            <span>theme</span>
            <div className="row" role="group" aria-label="Theme">
              {THEMES.map((t) => (
                <button
                  key={t}
                  type="button"
                  className="btn"
                  aria-pressed={theme.choice === t}
                  onClick={() => theme.setChoice(t)}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>

          <div className="field">
            <span>api</span>
            <div className={`mono ${offline ? 'health-down' : 'health-up'}`}>{healthText}</div>
          </div>
        </header>

        {route.view === 'recall' && <RecallView namespace={namespace} />}
        {route.view === 'memories' && <MemoriesView namespace={namespace} />}
        {route.view === 'sessions' && <SessionsView namespace={namespace} />}
        {route.view === 'graph' && <GraphView namespace={namespace} />}
        {route.view === 'stats' && <StatsView namespace={namespace} />}
      </div>
    </div>
  );
}
