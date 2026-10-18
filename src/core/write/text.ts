/**
 * Text primitives for the write path. Pure, synchronous, no dependencies.
 *
 * These are the measurements `reconciler.ts` decides on, so they are separated from
 * the decision itself: a gate you cannot test in isolation is a gate nobody can tune.
 */

/** Function words that carry no topic. Small on purpose: an over-long list turns a
 * short sentence into zero tokens and every short sentence into every other one. */
const STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "to", "of",
  "and", "or", "in", "on", "at", "for", "it", "its", "this", "that", "these",
  "those", "with", "as", "by", "from", "but", "if", "so", "than", "then",
  "我的", "的", "了", "是", "在", "和", "就", "也", "都", "我", "你",
]);

const CJK = /[\u4e00-\u9fff]/;
const WORD_SPLIT = /[^\p{L}\p{N}]+/u;
const TRAILING_PUNCT = /[.!?。！？]+$/;

/**
 * Comparison form: lowercase, one space between words, no trailing sentence mark.
 *
 * Deliberately does *not* strip inner punctuation — "use pnpm, not npm" and "use pnpm
 * not npm" stay different strings for the exact-duplicate rule, because the token
 * measurement below is the thing that treats them as the same claim.
 */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(TRAILING_PUNCT, "")
    .trim();
}

/**
 * Word tokens. A CJK run contributes character bigrams instead of one token, because
 * Chinese has no spaces: one token per sentence would make every Chinese pair score 0
 * or 1 and nothing in between.
 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(WORD_SPLIT)) {
    if (!raw) continue;
    if (CJK.test(raw)) {
      if (raw.length === 1) {
        if (!STOPWORDS.has(raw)) out.push(raw);
        continue;
      }
      for (let i = 0; i + 1 < raw.length; i++) out.push(raw.slice(i, i + 2));
      continue;
    }
    if (raw.length < 2) continue;
    if (STOPWORDS.has(raw)) continue;
    out.push(raw);
  }
  return out;
}

/** Jaccard over token sets. 0 when neither side has a token. */
export function lexicalSimilarity(a: string, b: string): number {
  const setA = new Set(tokenize(a));
  const setB = new Set(tokenize(b));
  if (setA.size === 0 && setB.size === 0) return 0;
  let shared = 0;
  for (const t of setA) if (setB.has(t)) shared++;
  const union = setA.size + setB.size - shared;
  return union === 0 ? 0 : shared / union;
}

/** True when every token of the old text is present in the new one. */
export function covers(oldText: string, newText: string): boolean {
  const oldTokens = new Set(tokenize(oldText));
  if (oldTokens.size === 0) return false;
  const newTokens = new Set(tokenize(newText));
  for (const t of oldTokens) if (!newTokens.has(t)) return false;
  return true;
}

/** Cap on an appended merge, in characters. See spec 4.3. */
const MERGE_MAX_CHARS = 600;
/**
 * Cap on an appended merge relative to the new text: an old claim far longer than the
 * new one is a different claim, not a detail of it, and appending it is how a memory
 * grows to three times its size on every rewrite.
 */
const MERGE_MAX_OLD_RATIO = 2;
const MERGE_MARKER = " (previously: ";

/**
 * The text a superseding row stores: the new claim, plus the old claim when the old one
 * carries something the new one does not.
 *
 * A merge that would triple the stored tokens is not worth the detail — past the cap the
 * row keeps the new text and the soft-deleted row in the chain keeps the old one.
 */
export function mergeText(oldText: string, newText: string): string {
  if (covers(oldText, newText)) return newText;
  const merged = `${newText}${MERGE_MARKER}${oldText})`;
  if (merged.length > MERGE_MAX_CHARS || oldText.length > newText.length * MERGE_MAX_OLD_RATIO) return newText;
  return merged;
}
