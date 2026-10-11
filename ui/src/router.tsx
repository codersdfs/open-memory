import { useCallback, useEffect, useState } from 'react';

export type ViewName = 'recall' | 'memories' | 'sessions' | 'graph' | 'stats';

const VIEWS: readonly ViewName[] = ['recall', 'memories', 'sessions', 'graph', 'stats'];
const DEFAULT_VIEW: ViewName = 'recall';

type Route = { view: ViewName; params: URLSearchParams };

/** `#/recall?q=x&k=5` — the hash is the whole state store, so refresh and deep links work. */
function parse(hash: string): Route {
  const raw = hash.replace(/^#\/?/, '');
  const mark = raw.indexOf('?');
  const name = (mark === -1 ? raw : raw.slice(0, mark)).split('/')[0] ?? '';
  const view = (VIEWS as readonly string[]).includes(name) ? (name as ViewName) : DEFAULT_VIEW;
  return { view, params: new URLSearchParams(mark === -1 ? '' : raw.slice(mark + 1)) };
}

function write(view: ViewName, params: URLSearchParams) {
  const search = params.toString();
  location.hash = `#/${view}${search ? `?${search}` : ''}`;
}

export function useRoute(): {
  view: ViewName;
  params: URLSearchParams;
  setParams(next: Record<string, string | number | undefined>): void;
  setView(v: ViewName): void;
} {
  const [route, setRoute] = useState<Route>(() => parse(location.hash));

  useEffect(() => {
    const onHash = () => setRoute(parse(location.hash));
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  }, []);

  const setParams = useCallback((next: Record<string, string | number | undefined>) => {
    const current = parse(location.hash);
    const params = new URLSearchParams(current.params);
    for (const [key, value] of Object.entries(next)) {
      if (value === undefined) params.delete(key);
      else params.set(key, String(value));
    }
    write(current.view, params);
  }, []);

  // Switching views keeps the params: filters and the selected id are the same
  // keys on every view, and a switch that dropped them would strand the query.
  const setView = useCallback((v: ViewName) => {
    write(v, parse(location.hash).params);
  }, []);

  return { view: route.view, params: route.params, setParams, setView };
}
