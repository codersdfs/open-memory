import { countTokens } from "./tokens.js";
import { tokenize } from "./bm25.js";

/**
 * Read-time projection of one long memory onto the part of it that earned its place.
 *
 * Why this exists: the store keeps whole episodes (a 1,200-character session chunk, a
 * wiki section, a console dump) because that is the unit a human wrote, but a search
 * result is a fragment an agent will read *alongside* other fragments inside a hard
 * token budget. Measured on the benchmark's chunks: 2.7 whole 275-token chunks fit in
 * an 800-token budget, while 5 windows with the matching turns fit in the same budget —
 * and multi-hop questions that needed two chunks never got both. The gold evidence
 * turn is one line inside the chunk; the other ~10 lines are what paid for it.
 *
 * This is a deterministic, zero-LLM, zero-dependency projection: units are scored by
 * query-term overlap, the best unit is kept with its neighbours (a pronoun in the next
 * line only means something when the previous line is there), the opening line is kept
 * when it looks like a header (it carries the date the temporal questions need), and
 * the whole thing is capped in tokens, not characters.
 *
 * `memory_get` is unchanged: a caller that asks for one memory by id still gets all of
 * it. Only `search` returns the projection.
 */

export interface AssembleOptions {
  query: string;
  /** Token ceiling for this one fragment. */
  maxTokens: number;
  /** Lines kept on each side of the matching line (default 2). */
  neighborRadius?: number;
}

export interface Assembled {
  text: string;
  tokens: number;
  /** True when text was projected; false when the whole memory already fit. */
  trimmed: boolean;
  /** Number of units (lines or sentences) kept. */
  parts: number;
}

const SENTENCE = /(?<=[.!?。！？；;])\s+/;
const DATE = /\b\d{4}-\d{2}-\d{2}\b/;
const HEADER = /^(#{1,4}\s|session\s+\d+|session\s*:|第\s*\d+\s*[轮天章节]|\[\d{4}-\d{2}-\d{2}\])/i;

function splitUnits(text: string): { units: string[]; joiner: string } {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length >= 3) return { units: lines, joiner: "\n" };
  const sentences = text
    .split(SENTENCE)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (sentences.length >= 2) return { units: sentences, joiner: " " };
  return { units: [text.trim()], joiner: " " };
}

/** How many distinct query terms this unit contains. */
function overlap(terms: Set<string>, unit: string): number {
  let n = 0;
  for (const term of new Set(tokenize(unit))) if (terms.has(term)) n++;
  return n;
}

/** The first unit, when it reads like a header rather than prose. */
function headerIndex(units: string[]): number | null {
  const first = units[0];
  if (!first || first.length > 160) return null;
  if (HEADER.test(first) || DATE.test(first)) return 0;
  // A short line ending in ':' is a section label ("Speakers:", "你的文件：").
  if (first.length <= 80 && /[:：]$/.test(first)) return 0;
  return null;
}

export function assembleFragment(text: string, opts: AssembleOptions): Assembled {
  const total = countTokens(text);
  if (total <= opts.maxTokens) return { text, tokens: total, trimmed: false, parts: 1 };

  const { units, joiner } = splitUnits(text);
  if (units.length < 2) return { text, tokens: total, trimmed: false, parts: 1 };

  const terms = new Set(tokenize(opts.query));
  const scores = units.map((u) => overlap(terms, u));
  const best = scores.reduce((bi, s, i) => (s > scores[bi]! ? i : bi), 0);
  const matched = scores[best]! > 0;

  const keep: number[] = [];
  let used = 0;
  const push = (i: number): boolean => {
    if (i < 0 || i >= units.length || keep.includes(i)) return false;
    const cost = countTokens(units[i]!) + (keep.length > 0 ? 1 : 0);
    if (used + cost > opts.maxTokens) return false;
    keep.push(i);
    used += cost;
    return true;
  };

  // The header is worth its tokens even when it matches nothing: it is where the
  // date lives, and a temporal memory without its date cannot answer "when".
  const header = headerIndex(units);
  if (header !== null) push(header);

  if (matched) {
    push(best);
    // Neighbours in both directions: the line that names the thing and the line
    // that says what happened are routinely adjacent, and a lone line loses the
    // pronouns that make it readable. Radius 2 is where retention stops climbing:
    // measured on the benchmark chunks, keeping ±2 lines retained 87% of gold
    // evidence turns while ±1 retained 74% and ±4 bought only 1 more point.
    const radius = Math.max(1, opts.neighborRadius ?? 2);
    for (let d = 1; d <= radius; d++) {
      push(best - d);
      push(best + d);
    }
    // Then the next-best matches, so a two-hop fragment still carries both hops.
    const rest = scores
      .map((s, i) => ({ s, i }))
      .filter(({ i }) => !keep.includes(i))
      .sort((a, b) => b.s - a.s || a.i - b.i);
    for (const { i } of rest) push(i);
  } else {
    // No term matched (the row arrived on vector signal alone): keep the head,
    // which is where a document states its subject.
    for (let i = 0; i < units.length; i++) push(i);
  }

  if (keep.length === 0) return { text, tokens: total, trimmed: false, parts: 1 };
  keep.sort((a, b) => a - b);
  const projected = keep.map((i) => units[i]!).join(joiner);
  return { text: projected, tokens: countTokens(projected), trimmed: true, parts: keep.length };
}
