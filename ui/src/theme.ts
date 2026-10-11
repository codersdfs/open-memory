import { useCallback, useEffect, useState } from 'react';

export type ThemeChoice = 'auto' | 'dark' | 'light';

const KEY = 'om-theme';

function storedChoice(): ThemeChoice {
  const raw = localStorage.getItem(KEY);
  return raw === 'dark' || raw === 'light' ? raw : 'auto';
}

/** `auto` follows the OS; the resolved value is what goes on `<html data-theme>`. */
export function useTheme(): {
  choice: ThemeChoice;
  resolved: 'dark' | 'light';
  setChoice(c: ThemeChoice): void;
} {
  const [choice, setChoiceState] = useState<ThemeChoice>(storedChoice);
  const [prefersLight, setPrefersLight] = useState(() => matchMedia('(prefers-color-scheme: light)').matches);

  useEffect(() => {
    const mq = matchMedia('(prefers-color-scheme: light)');
    const onChange = (e: MediaQueryListEvent) => setPrefersLight(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const resolved: 'dark' | 'light' = choice === 'auto' ? (prefersLight ? 'light' : 'dark') : choice;

  useEffect(() => {
    document.documentElement.dataset.theme = resolved;
  }, [resolved]);

  const setChoice = useCallback((next: ThemeChoice) => {
    localStorage.setItem(KEY, next);
    setChoiceState(next);
  }, []);

  return { choice, resolved, setChoice };
}
