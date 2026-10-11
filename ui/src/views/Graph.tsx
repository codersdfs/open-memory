import { useEffect, useRef } from 'react';
import { Panel } from '../components/Panel';
import { useTheme } from '../theme';

/**
 * D9 — the graph is framed, not ported. `src/ui/graph.js` is the same force-layout canvas
 * it always was; it now reads the console's tokens, so this view only supplies chrome and
 * the theme. The iframe `src` is relative because the console is served from `/` and
 * `/app/` alike; `graph.html` resolves next to whichever one is running.
 */
export default function GraphView({ namespace: _namespace }: { namespace: string }) {
  const { resolved } = useTheme();
  const frame = useRef<HTMLIFrameElement>(null);
  const src = `graph.html?theme=${resolved}`;

  // Both paths, on purpose: the message repaints a live frame without a reload, the `src`
  // below is what a direct visit (or a reload) resolves the theme from.
  useEffect(() => {
    frame.current?.contentWindow?.postMessage({ type: 'om-theme', theme: resolved }, '*');
  }, [resolved]);

  return (
    <Panel
      title="Graph"
      subtitle="Reads vault/ read-only. Not part of this store, and nothing here writes to it."
      pad={false}
      actions={
        <>
          <button
            type="button"
            className="btn"
            onClick={() => frame.current?.contentWindow?.location.reload()}
          >
            reload
          </button>
          <a className="btn" href={src} target="_blank" rel="noreferrer">
            open in new tab
          </a>
        </>
      }
    >
      <iframe
        ref={frame}
        src={src}
        title="Vault graph"
        style={{
          display: 'block',
          width: '100%',
          height: 'calc(100vh - 260px)',
          minHeight: '60vh',
          border: 0,
          background: 'var(--bg)',
        }}
      />
    </Panel>
  );
}
