/**
 * D2 — hand-written inline SVG, no icon library. Every glyph is drawn on the 16px grid
 * with a 1.5px stroke so it stays legible at 16px: geometric paths, no decoration, no
 * fills except where a shape has to read solid (`IconAuto`, and the sun/moon pair have
 * one each). `currentColor` everywhere, so an icon takes the colour of its context.
 */

type IconProps = { size?: number };

const SVG = {
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
} as const;

export function IconSearch({ size = 16 }: IconProps) {
  return (
    <svg {...SVG} width={size} height={size}>
      <circle cx="7" cy="7" r="4.25" />
      <path d="M10.3 10.3L14 14" />
    </svg>
  );
}

export function IconClose({ size = 16 }: IconProps) {
  return (
    <svg {...SVG} width={size} height={size}>
      <path d="M4 4L12 12" />
      <path d="M12 4L4 12" />
    </svg>
  );
}

/** A pushpin: top bar, tapered head, shaft. Reads at 16px because it is three strokes. */
export function IconPin({ size = 16 }: IconProps) {
  return (
    <svg {...SVG} width={size} height={size}>
      <path d="M6 2.5h4" />
      <path d="M7 2.5v4.2L5 9.2h6L9 6.7V2.5" />
      <path d="M8 9.2v4.3" />
    </svg>
  );
}

export function IconTrash({ size = 16 }: IconProps) {
  return (
    <svg {...SVG} width={size} height={size}>
      <path d="M3 4.5h10" />
      <path d="M6.5 4.5V3.2a.7.7 0 0 1 .7-.7h1.6a.7.7 0 0 1 .7.7v1.3" />
      <path d="M5 4.5v8a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1v-8" />
    </svg>
  );
}

/** Two chain links: two mirrored half-circles joined by a diagonal. */
export function IconLink({ size = 16 }: IconProps) {
  return (
    <svg {...SVG} width={size} height={size}>
      <path d="M6.8 9.2L9.2 6.8" />
      <path d="M7.5 4.6 9.1 3a2.55 2.55 0 0 1 3.6 3.6L11.1 8.2" />
      <path d="M8.5 11.4 6.9 13a2.55 2.55 0 0 1-3.6-3.6L4.9 7.8" />
    </svg>
  );
}

export function IconKeyboard({ size = 16 }: IconProps) {
  return (
    <svg {...SVG} width={size} height={size}>
      <rect x="1.5" y="4.5" width="13" height="7" rx="1.5" />
      <path d="M4 7h1M7 7h1M10 7h1" />
      <path d="M5.5 9.5h5" />
    </svg>
  );
}

export function IconSun({ size = 16 }: IconProps) {
  return (
    <svg {...SVG} width={size} height={size}>
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1.5V4M8 12v2.5M1.5 8H4M12 8h2.5" />
      <path d="M3.4 3.4L5.2 5.2M12.6 3.4L10.8 5.2M12.6 12.6L10.8 10.8M3.4 12.6L5.2 10.8" />
    </svg>
  );
}

/** A crescent: the outer arc of one circle closed by the far arc of a second. */
export function IconMoon({ size = 16 }: IconProps) {
  return (
    <svg {...SVG} width={size} height={size}>
      <path d="M13.6 8.6A5.2 5.2 0 1 1 7.3 2.4a4.4 4.4 0 0 1 6.3 6.2Z" />
    </svg>
  );
}

/** The three-state theme control: outline circle, right half solid. Neither sun nor moon. */
export function IconAuto({ size = 16 }: IconProps) {
  return (
    <svg {...SVG} width={size} height={size}>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 2a6 6 0 0 1 0 12Z" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** Three nodes and their edges — the memory graph, not a line chart. */
export function IconGraph({ size = 16 }: IconProps) {
  return (
    <svg {...SVG} width={size} height={size}>
      <circle cx="8" cy="3.2" r="1.8" />
      <circle cx="3.6" cy="12" r="1.8" />
      <circle cx="12.4" cy="12" r="1.8" />
      <path d="M7.1 4.8L4.5 10.3M8.9 4.8l2.6 5.5M5.4 12h5.2" />
    </svg>
  );
}

export function IconList({ size = 16 }: IconProps) {
  return (
    <svg {...SVG} width={size} height={size}>
      <path d="M6 4h8M6 8h8M6 12h8" />
      <circle cx="3" cy="4" r=".6" />
      <circle cx="3" cy="8" r=".6" />
      <circle cx="3" cy="12" r=".6" />
    </svg>
  );
}

export function IconClock({ size = 16 }: IconProps) {
  return (
    <svg {...SVG} width={size} height={size}>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.5V8l2.6 1.6" />
    </svg>
  );
}

export function IconChart({ size = 16 }: IconProps) {
  return (
    <svg {...SVG} width={size} height={size}>
      <path d="M2 13.5h12" />
      <path d="M4.5 13.5V9M8 13.5V5M11.5 13.5V10.5" />
    </svg>
  );
}

/** A four-point star — the agent glyph (ADR-0043). One path, filled, so it reads at 14px. */
export function IconSparkles({ size = 16 }: IconProps) {
  return (
    <svg {...SVG} width={size} height={size}>
      <path
        d="M8 1.8c.9 3 1.9 4 4.9 4.9-3 .9-4 1.9-4.9 4.9-.9-3-1.9-4-4.9-4.9 3-.9 4-1.9 4.9-4.9Z"
        fill="currentColor"
        stroke="none"
      />
      <path d="M12.4 10.4c.45 1.5.95 2 2.45 2.45-1.5.45-2 .95-2.45 2.45-.45-1.5-.95-2-2.45-2.45 1.5-.45 2-.95 2.45-2.45Z" />
    </svg>
  );
}

/** The store: a cylinder, two ellipse arcs and sides. */
export function IconDatabase({ size = 16 }: IconProps) {
  return (
    <svg {...SVG} width={size} height={size}>
      <ellipse cx="8" cy="3.6" rx="5.5" ry="2.1" />
      <path d="M2.5 3.6v8.8c0 1.16 2.46 2.1 5.5 2.1s5.5-.94 5.5-2.1V3.6" />
      <path d="M2.5 8c0 1.16 2.46 2.1 5.5 2.1S13.5 9.16 13.5 8" />
    </svg>
  );
}

export function IconArrowUp({ size = 16 }: IconProps) {
  return (
    <svg {...SVG} width={size} height={size}>
      <path d="M8 13V3" />
      <path d="M3.8 7.2 8 3l4.2 4.2" />
    </svg>
  );
}

export function IconCheck({ size = 16 }: IconProps) {
  return (
    <svg {...SVG} width={size} height={size}>
      <path d="M3 8.6 6.4 12 13 4.6" />
    </svg>
  );
}

export function IconX({ size = 16 }: IconProps) {
  return (
    <svg {...SVG} width={size} height={size}>
      <path d="M4 4 12 12" />
      <path d="M12 4 4 12" />
    </svg>
  );
}

/** Shield with a mark: the write gate, refusing or passing. */
export function IconShield({ size = 16 }: IconProps) {
  return (
    <svg {...SVG} width={size} height={size}>
      <path d="M8 1.8 13 3.6v4.2c0 3.1-2.1 5.3-5 6.4-2.9-1.1-5-3.3-5-6.4V3.6Z" />
      <path d="M5.8 8h4.4" />
    </svg>
  );
}

export function IconPencil({ size = 16 }: IconProps) {
  return (
    <svg {...SVG} width={size} height={size}>
      <path d="M11.3 2.6a1.7 1.7 0 0 1 2.4 2.4L5.4 13.3 2.5 14l.7-2.9Z" />
      <path d="M10 3.9l2.1 2.1" />
    </svg>
  );
}

export function IconTrash2({ size = 16 }: IconProps) {
  return <IconTrash size={size} />;
}

export function IconChevronDown({ size = 16 }: IconProps) {
  return (
    <svg {...SVG} width={size} height={size}>
      <path d="M4 6.2 8 10.2 12 6.2" />
    </svg>
  );
}

export function IconChevronUp({ size = 16 }: IconProps) {
  return (
    <svg {...SVG} width={size} height={size}>
      <path d="M4 9.8 8 5.8 12 9.8" />
    </svg>
  );
}

/** A gear: ring plus six teeth, centre dot solid. */
export function IconSettings({ size = 16 }: IconProps) {
  return (
    <svg {...SVG} width={size} height={size}>
      <circle cx="8" cy="8" r="2.6" />
      <path d="M8 1.6v2M8 12.4v2M1.6 8h2M12.4 8h2M3.5 3.5l1.4 1.4M11.1 11.1l1.4 1.4M12.5 3.5l-1.4 1.4M4.9 11.1l-1.4 1.4" />
    </svg>
  );
}
