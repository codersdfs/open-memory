/**
 * Shortcuts are only discoverable if they are on screen (D6): the drawers and the table
 * footer render the keys they support instead of documenting them somewhere else.
 */
export function KeyboardHint({ keys }: { keys: string[] }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      {keys.map((key, i) => (
        <kbd
          key={`${key}-${i}`}
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            lineHeight: '16px',
            padding: '0 5px',
            color: 'var(--dim)',
            background: 'var(--panel-2)',
            border: '1px solid var(--hairline)',
            borderRadius: 'var(--radius-sm)',
          }}
        >
          {key}
        </kbd>
      ))}
    </span>
  );
}
