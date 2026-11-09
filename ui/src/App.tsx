import { useEffect, useState } from 'react';
import { useRoute, type ViewName } from './router';
import { useTheme, type ThemeChoice } from './theme';
import { api } from './lib/api';
import PrincipalGate from './components/PrincipalGate';
import AgentView from './views/Agent';
import RecallView from './views/Recall';
import MemoriesView from './views/Memories';
import SessionsView from './views/Sessions';
import GraphView from './views/Graph';
import StatsView from './views/Stats';
import SettingsView from './views/Settings';
import {
  IconAuto,
  IconChart,
  IconClock,
  IconDatabase,
  IconGraph,
  IconMoon,
  IconSearch,
  IconSettings,
  IconSparkles,
  IconSun,
} from './components/Icons';

type IconComponent = (props: { size?: number }) => React.ReactNode;

const NAV: readonly { view: ViewName; label: string; icon: IconComponent }[] = [
  { view: 'agent', label: 'Agent', icon: IconSparkles },
  { view: 'recall', label: 'Recall', icon: IconSearch },
  { view: 'memories', label: 'Memories', icon: IconDatabase },
  { view: 'sessions', label: 'Sessions', icon: IconClock },
  { view: 'graph', label: 'Graph', icon: IconGraph },
  { view: 'stats', label: 'Stats', icon: IconChart },
  { view: 'settings', label: 'Settings', icon: IconSettings },
];

const THEMES: readonly ThemeChoice[] = ['auto', 'dark', 'light'];
const THEME_ICON: Record<ThemeChoice, IconComponent> = {
  auto: IconAuto,
  dark: IconMoon,
  light: IconSun,
};
const NS_KEY = 'om-namespace';
const HEALTH_INTERVAL = 15000;

type Health = { ok?: boolean; embedding?: string; dim?: number; version?: string };

export default function App() {
  const route = useRoute();
  const theme = useTheme();
  const [namespace, setNamespace] = useState(() => localStorage.getItem(NS_KEY) ?? 'default:default');
  /** D5 — the real partitions, so nobody types one that holds nothing. A failed load leaves
   *  the field free-text: the server being unreachable must not block the picker. */
  const [known, setKnown] = useState<string[]>([]);
  /** P7 (ADR-0049): a gated daemon answers 401 until the operator pastes its token —
   *  the gate is the console's whole credential surface, shown instead of the shell. */
  const [locked, setLocked] = useState(false);
  const [unlockTick, setUnlockTick] = useState(0);

  useEffect(() => {
    let live = true;
    api
      .namespaces()
      .then((r) => {
        if (live) setKnown(r.namespaces);
      })
      .catch((e) => {
        if (live && (e as { status?: number }).status === 401) setLocked(true);
      });
    return () => {
      live = false;
    };
  }, [unlockTick]);
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

  if (locked) {
    return (
      <PrincipalGate
        onUnlocked={() => {
          setLocked(false);
          setUnlockTick((t) => t + 1);
        }}
      />
    );
  }

  return (
    <div className="shell">
      <nav className="rail" aria-label="Views">
        <div className="rail-brand">
          <span className="rail-mark" aria-hidden="true" />
          <span>open-memory</span>
          <span className="chip" style={{ marginLeft: 2 }}>
            beta
          </span>
        </div>
        <div className="rail-cap">workspace</div>
        {NAV.map((item) => {
          const Icon = item.icon;
          return (
            <a
              key={item.view}
              className="rail-item"
              href={`#/${item.view}`}
              aria-current={route.view === item.view ? 'page' : undefined}
            >
              <Icon size={14} />
              <span>{item.label}</span>
            </a>
          );
        })}
        <div className="rail-foot">
          {offline ? 'api unreachable' : health?.version ? `api ${healthText}` : 'api checking…'}
        </div>
      </nav>

      <div className="content">
        <header className="header">
          <div className="field">
            <span>namespace</span>
            <input
              value={namespace}
              list="om-namespaces"
              spellCheck={false}
              aria-label="Namespace"
              onChange={(e) => setNamespace(e.target.value)}
            />
            <datalist id="om-namespaces">
              {known.map((ns) => (
                <option key={ns} value={ns} />
              ))}
            </datalist>
          </div>

          <div className="field">
            <span>theme</span>
            <div className="row" role="group" aria-label="Theme">
              {THEMES.map((t) => {
                const Icon = THEME_ICON[t];
                return (
                  <button
                    key={t}
                    type="button"
                    className="btn"
                    aria-pressed={theme.choice === t}
                    aria-label={t}
                    title={t}
                    onClick={() => theme.setChoice(t)}
                  >
                    <Icon size={13} />
                  </button>
                );
              })}
            </div>
          </div>

          <div className="field">
            <span>api</span>
            <div className={`mono ${offline ? 'health-down' : 'health-up'}`}>{healthText}</div>
          </div>
        </header>

        {route.view === 'agent' && <AgentView namespace={namespace} />}
        {route.view === 'recall' && <RecallView namespace={namespace} />}
        {route.view === 'memories' && <MemoriesView namespace={namespace} />}
        {route.view === 'sessions' && <SessionsView namespace={namespace} />}
        {route.view === 'graph' && <GraphView namespace={namespace} />}
        {route.view === 'stats' && <StatsView namespace={namespace} />}
        {route.view === 'settings' && <SettingsView />}
      </div>
    </div>
  );
}
