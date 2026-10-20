/**
 * Markdown → indexable sections (ADR-0023).
 *
 * The file is the truth; these sections are the only thing the memory index ever
 * sees. That means two contracts matter more than fidelity to every markdown
 * feature:
 *
 *  1. **A section key is stable while its heading text is unchanged.** The sync
 *     updates a row in place by `(knowledge_id, knowledge_section)`, so a key that
 *     moved when a neighbour was edited would turn every sync into delete+insert
 *     and re-embed the whole vault.
 *  2. **The rendered text carries its own title and heading.** A row outlives the
 *     page it came from (the file may be renamed, or moved out of the vault), and
 *     "`set the retry budget to 3`" alone cannot answer "which page was that?".
 *     `[page] heading: prose` is also what `knowledgePage` parses back out.
 */

export interface KnowledgeSection {
  /** Stable within the page: heading-derived, `preamble`, or `section-<n>` as a fallback. */
  key: string;
  heading: string;
  prose: string;
  chars: number;
}

export interface SplitOptions {
  /** A page with more than this many sections is indexed by its first N. */
  maxSections?: number;
  /** Sections shorter than this are dropped: a heading with three words is a label, not knowledge. */
  minChars?: number;
  /** Hard cap per section, cut at a sentence boundary when one is available. */
  maxChars?: number;
}

export const DEFAULT_MAX_SECTIONS = 12;
export const DEFAULT_MIN_SECTION_CHARS = 40;
export const DEFAULT_MAX_SECTION_CHARS = 1500;

const HEADING = /^#{1,3}[ \t]+(.+?)[ \t]*#*[ \t]*$/;
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;

/**
 * A heading is a label the author chose; the key just has to survive edits to
 * *other* headings. Letters, digits and CJK survive; everything else collapses to
 * one dash. `## How tokens work` → `how-tokens-work`, `## 令牌怎么算` → `令牌怎么算`.
 */
export function sectionKey(heading: string, index: number): string {
  const raw = heading
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[`*_~]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return raw.length > 0 ? raw : `section-${index + 1}`;
}

/** `[page] heading: prose` — the shape `renderSectionText` writes and `knowledgePage` reads. */
export function renderSectionText(title: string, heading: string, prose: string, maxChars = DEFAULT_MAX_SECTION_CHARS): string {
  const head = heading.trim();
  const body = clamp(prose.trim(), maxChars);
  return head.length > 0 ? `[${title}] ${head}: ${body}` : `[${title}] ${body}`;
}

/** Cut at the last sentence end inside the budget; never mid-word when a boundary exists. */
export function clamp(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const slice = text.slice(0, maxChars);
  const end = Math.max(
    slice.lastIndexOf(". "),
    slice.lastIndexOf("。"),
    slice.lastIndexOf("! "),
    slice.lastIndexOf("? "),
    slice.lastIndexOf("; ")
  );
  return end > maxChars * 0.5 ? slice.slice(0, end + 1).trim() : slice.trimEnd();
}

/** Strip markdown dressing that would otherwise be embedded as tokens. */
function cleanProse(lines: string[]): string {
  return lines
    .join("\n")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/\[([^\]]+)\]\((?:[^)]+)\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((l) => l.trimEnd())
    .join("\n")
    .trim();
}

/**
 * Split a page body into sections. Line-oriented on purpose: a heading inside a
 * fenced code block is not a heading, and `stripCode` would also throw away the
 * code, which is often the most valuable part of a how-to section.
 */
export function splitKnowledgeSections(body: string, opts: SplitOptions = {}): KnowledgeSection[] {
  const maxSections = opts.maxSections ?? DEFAULT_MAX_SECTIONS;
  const minChars = opts.minChars ?? DEFAULT_MIN_SECTION_CHARS;
  const maxChars = opts.maxChars ?? DEFAULT_MAX_SECTION_CHARS;

  const buckets: { heading: string; lines: string[]; index: number }[] = [{ heading: "", lines: [], index: 0 }];
  let fenced = false;
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const h = fenced ? null : line.match(HEADING);
    if (h) {
      buckets.push({ heading: h[1]!.trim(), lines: [], index: buckets.length });
      continue;
    }
    buckets[buckets.length - 1]!.lines.push(line);
  }

  const used = new Map<string, number>();
  const out: KnowledgeSection[] = [];
  for (const bucket of buckets) {
    const prose = cleanProse(bucket.lines);
    // The preamble only counts when it says something: a page that starts with
    // frontmatter and an H1 then its first `##` has an empty one.
    if (prose.length < minChars) continue;
    const base = bucket.heading === "" ? "preamble" : sectionKey(bucket.heading, bucket.index);
    const n = used.get(base) ?? 0;
    used.set(base, n + 1);
    const key = n === 0 ? base : `${base}-${n + 1}`;
    const text = clamp(prose, maxChars);
    out.push({ key, heading: bucket.heading, prose: text, chars: text.length });
    if (out.length >= maxSections) break;
  }
  return out;
}

/** Page title back out of a rendered section, or `null` for a row that was never a knowledge row. */
export function titleOfSectionText(text: string): string | null {
  const m = text.match(/^\[([^\]\n]{1,120})\]\s/);
  return m ? m[1]! : null;
}

/** True when the text looks like it carries knowledge (used by tests and the sync report). */
export function looksLikeKnowledge(text: string): boolean {
  return titleOfSectionText(text) !== null || CJK.test(text);
}
