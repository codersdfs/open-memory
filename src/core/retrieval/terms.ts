import { tokenize } from "./bm25.js";

/**
 * The one token list the inverted index and the query share.
 *
 * Why this exists (ADR-0027). `memory_terms` used to be built from raw `tokenize`,
 * so every Chinese function word — 的, 怎么, 是, 里, 的约定 — got a posting list.
 * On the real-time benchmark that was not a cost problem, it was a *correctness*
 * problem: the query "bench-project-3 里的 zq1234 是怎么配置的" produced ~40
 * tokens, the candidate fetch kept the eight rarest, and the filler (怎么, 是,
 * 配置) crowded the gold row's real evidence out of the shortlist. Measured CJK
 * recall@5 was 0.6484 with 64 of 182 CJK queries returning nothing at all.
 *
 * The fix is at the index, not at the scorer: function words are never indexed, so
 * they can neither fill the candidate window nor dilute `df`. Inflating weights
 * instead was rejected — it makes every loosely-worded query a match, which is the
 * false-positive direction this project has already measured and undone twice.
 *
 * The invariant that makes it safe (asserted in tests/terms.test.ts):
 *
 *     indexTerms(text) ⊆ queryTerms(text), for every text.
 *
 * `bm25.ts` normalises a score by the number of query terms and uses the *candidate
 * set's* document frequency as idf. If the query produced a term the index never
 * stored, its df would be 0, and idf would be computed against a posting list that
 * does not exist — a score no candidate can earn. So filtering is only ever
 * coarser on the query side in ways the index side already applied. Stopping a
 * term for the index means stopping it for the query too; the reverse is not
 * allowed.
 */

/** CJK function characters. A single character is dropped only if it is listed here. */
const CJK_STOP_CHARS = new Set([
  "的", "地", "得", "了", "着", "过", "是", "在", "有", "和", "与", "及", "或", "而", "则", "就", "都", "也",
  "还", "又", "很", "更", "最", "太", "把", "被", "从", "到", "向", "对", "为", "以", "之", "其", "这", "那",
  "哪", "谁", "什", "么", "怎", "样", "如", "何", "个", "些", "我", "你", "他", "她", "它", "们", "呢", "吧",
  "啊", "呀", "吗", "嘛", "哦", "嗯", "并", "且", "但", "却", "因", "所", "于", "跟", "把", "让", "使", "给",
  "上", "下", "中", "里", "内", "外", "前", "后", "时", "候", "会", "能", "要", "可", "该", "应", "当", "需"
]);

/** Two-character CJK function words. Bigrams made only of stop chars are caught above. */
const CJK_STOP_BIGRAMS = new Set([
  "什么", "怎么", "如何", "哪样", "哪个", "哪些", "为什么", "怎样", "是否", "可以", "应该", "需要", "我们",
  "你们", "他们", "她们", "它们", "这个", "那个", "这些", "那些", "这里", "那里", "时候", "然后", "因为",
  "所以", "但是", "而且", "并且", "如果", "虽然", "已经", "还是", "或者", "以及", "对于", "关于", "由于",
  "通过", "按照", "根据", "一下", "一些", "这样", "那样", "一样", "现在", "以前", "以后",
  // Cross-boundary bigrams: `bm25.ts` emits unigram + bigram over a whole CJK run,
  // so a run that is mostly filler still produces bigrams that span the grammar —
  // 「是怎么配置的」 yields 「么配」「置的」. They are keyed by the word they straddle,
  // the same way a search engine's word-boundary bigrams are: a bigram that starts
  // on 么 or ends on 置 is noise from a function word, not evidence.
  "么配", "置的",
  "的吗", "了呢", "的吧", "的时", "的话", "的是", "的方", "的流", "的是",
  "样的", "么样", "么的", "法的", "候的"
]);

/** A bigram that opens on the tail of an interrogative/particle is a straddle, not a word. */
const CJK_STOP_LEAD = new Set(["么", "样", "何", "哪"]);

/** A bigram that closes on a particle is a straddle, not a word. */
const CJK_STOP_TAIL = new Set(["的", "了", "着", "过", "吗", "呢", "吧", "啊", "嘛"]);

/**
 * Latin words kept out of the index. Deliberately tiny and closed-class: the
 * corpus is half code identifiers, and a pronoun filter that ate `this` out of
 * `this.replace` would be a regression dressed as hygiene.
 */
const LATIN_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "at", "is", "are", "was",
  "were", "be", "been", "it", "its", "as", "by", "for", "with", "that", "this",
  "from", "but", "not", "do", "does", "did", "we", "you", "they", "i"
]);

/**
 * A bare number is a name fragment, not a word. `bench-project-2` and `project 2`
 * both become `…, 'project', '2'`, so a project id is queryable either way — the
 * English half of a corpus writes "in bench-project-2" and the Chinese half writes
 * "项目 bench-project-2 的约定", and without this a query mentioning the id scored
 * against filler like `2` and contaminated everything.
 */
const BARE_NUMBER = /^[0-9]+$/;

const CJK_ONLY = /^[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+$/;

/**
 * Half of a two-character CJK term, when that term is reported instead of both
 * halves. Only meaningful where a *match* is being counted rather than a term
 * ranked — see `coverage`.
 */
const HAN_ONLY = /^[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]$/;

/**
 * True when a token carries evidence. Everything here is applied identically on
 * the index side and the query side — see the module comment for why that
 * direction is the only safe one.
 */
function keep(token: string): boolean {
  if (CJK_ONLY.test(token)) {
    const chars = [...token];
    // A single CJK character is kept unless it is a function character; a bigram
    // is kept unless it is a listed phrase or both halves are function characters
    // ("的和", "了吗"). Unigram + bigram both survive otherwise, which is what lets
    // 「数据库」 match a query for 「数据」.
    if (chars.length === 1) return !CJK_STOP_CHARS.has(token);
    if (chars.length === 2) {
      if (CJK_STOP_BIGRAMS.has(token)) return false;
      if (CJK_STOP_CHARS.has(chars[0]!) && CJK_STOP_CHARS.has(chars[1]!)) return false;
      // A straddle runs from the tail of one word into the head of the next, so it
      // opens on a question particle or closes on a grammatical one. Both ends are
      // checked: 「么配」 and 「置的」 are the same defect from opposite sides.
      if (CJK_STOP_LEAD.has(chars[0]!)) return false;
      if (CJK_STOP_TAIL.has(chars[1]!)) return false;
      return true;
    }
    return true;
  }
  if (BARE_NUMBER.test(token)) return false;
  return !LATIN_STOPWORDS.has(token);
}

/**
 * Terms for one document, exactly as the inverted index stores them. Repeats are
 * preserved so the caller can count them for tf; do not dedupe here.
 */
export function indexTerms(text: string): string[] {
  const out: string[] = [];
  for (const token of tokenize(text)) if (keep(token)) out.push(token);
  // Re-join what the bigram tokenizer cut through. `bm25.ts` splits a CJK run into
  // unigram + bigram, so 「项目」 arrives as 项/项目/目 — the interior unigram 「目」
  // is noise that inflates df and lets a one-character match look like evidence.
  // A character strictly inside a keeper bigram is already covered by that bigram.
  const covered = new Set<string>();
  for (const token of out) {
    const chars = [...token];
    if (CJK_ONLY.test(token) && chars.length === 2) {
      covered.add(chars[0]!);
      covered.add(chars[1]!);
    }
  }
  if (covered.size === 0) return out;
  const kept: string[] = [];
  for (let i = 0; i < out.length; i++) {
    const token = out[i]!;
    const chars = [...token];
    if (chars.length !== 1 || !CJK_ONLY.test(token) || !covered.has(token)) {
      kept.push(token);
      continue;
    }
    // Keep a standalone character only when the neighbour that covered it was not
    // part of the same run — 「猫 项目」 has two runs, 「项目」 has one.
    const prev = out[i - 1] ? [...out[i - 1]!] : null;
    const next = out[i + 1] ? [...out[i + 1]!] : null;
    const absorbedByPrev = prev !== null && prev.length === 2 && prev[1] === token;
    const absorbedByNext = next !== null && next.length === 2 && next[0] === token;
    if (!(absorbedByPrev || absorbedByNext)) kept.push(token);
  }
  return kept;
}

/**
 * Terms for a query: the same filter, order and duplicates removed. Same rule as
 * the index (never stricter), so every indexed term a caller searches for is
 * reachable.
 */
export function queryTerms(query: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of tokenize(query)) {
    if (!keep(token) || seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  // The query does NOT drop characters covered by a bigram. Keeping them is what
  // makes the subset invariant hold in the safe direction: the index may be
  // coarser than the query, never finer. A stored document term that the index
  // dropped also being droppable from a query would mean a query can ask for a
  // posting list the index never built.
  return out;
}

/** Exported for the invariant test, which pins the two sets against each other. */
export const _stopChars = CJK_STOP_CHARS;
export const _stopLatin = LATIN_STOPWORDS;

/**
 * How much of `text` the query asked for, as a share of what was asked.
 *
 * This is the *ranking* companion to `queryTerms`: a boolean "did any word
 * match" cannot order candidates, and BM25's length normalization stops it
 * ordering them either. Measured on the real-time bench, a Chinese question
 * expands into unigrams and straddle bigrams of its own function words, so rows
 * that only rhyme with the question's grammar scored as high as the row holding
 * its marker — 「配置」 becomes 配/配置/置 and every row containing 的 matched
 * something. What separates them is not how much a row contains but which of the
 * requested words it contains.
 *
 * Each query term is worth 1, a two-character CJK term whose bigram the text
 * holds is counted once (its halves are the same word), and the result is
 * divided by the number of *asked* terms — `indexTerms(query)`, the coarser
 * scale, so that a text holding every word of the query scores 1.
 */
export function coverage(text: string, query: string): number {
  const asked = queryTerms(query);
  if (asked.length === 0) return 0;
  const held = new Set(indexTerms(text));
  // A two-character CJK term is one word, not a word plus two letters. Drop a
  // half whose partner bigram the text also holds.
  const absorbed = new Set<string>(CJK_STOP_CHARS);
  for (const term of asked) {
    const chars = [...term];
    if (CJK_ONLY.test(term) && chars.length === 2 && held.has(term)) {
      for (const c of chars) absorbed.add(c);
    }
  }
  let matched = 0;
  for (const term of asked) {
    if (!held.has(term)) { continue; }
    const chars = [...term];
    if (CJK_ONLY.test(term) && chars.length === 1 && absorbed.has(term)) continue;
    matched++;
  }
  return Math.min(1, matched / asked.length);
}

/**
 * The held-set of `text`, with the CJK half-absorption `coverage` applies, as the
 * two coverage functions share it.
 */
function heldTerms(text: string): Set<string> {
  return new Set(indexTerms(text));
}

/**
 * Coverage where the asked words are not worth one each (ADR-0028).
 *
 * The unweighted `coverage` treats every asked term alike, and for a query that
 * names an entity the whole store knows, that is exactly backwards: on a
 * conversation store "What is Caroline's identity?" asks two words, `caroline`
 * sits in nearly every row of the partition and `identity` in none of the row
 * that answers it — so half the store scores 0.5, the answering row scores 0.5,
 * and the coverage-first sort (ADR-0027) orders them by recency and strength,
 * the two signals that have nothing to do with what was asked. The measured
 * shape on the LoCoMo evidence audit: multi-hop evidence recall 23%.
 *
 * The fix is the IR textbook one — weight by inverse document frequency. A
 * term's weight is `log(1 + maxDf / df)` over the *asked* terms' df, so a word
 * every row holds earns log(2) ≈ 0.69 and a word two rows hold earns
 * log(1 + df_max/2); the score is the share of total weight the row holds. The
 * max is taken over the asked terms rather than the partition so the weights
 * are self-normalizing — no row count needed, same scale for every caller.
 *
 * `df` is the partition's document frequency (`store.termDf`); a term the
 * partition has never seen is dropped from the asked set entirely, because no
 * row can hold it and keeping it in the denominator would only shrink every
 * score by a constant — moving the floor's meaning, not the ordering.
 *
 * CJK half-absorption matches `coverage` exactly: a two-character word counts
 * once even when its halves also match.
 */
export function coverageWeighted(text: string, query: string, df: Map<string, number>): number {
  const asked = queryTerms(query);
  if (asked.length === 0) return 0;
  const seen = asked.filter((t) => (df.get(t) ?? 0) > 0);
  if (seen.length === 0) return 0;
  let maxDf = 0;
  for (const t of seen) maxDf = Math.max(maxDf, df.get(t)!);
  const weight = new Map<string, number>();
  let total = 0;
  for (const t of seen) {
    const w = Math.log(1 + maxDf / df.get(t)!);
    weight.set(t, w);
    total += w;
  }
  if (total <= 0) return 0;
  const held = heldTerms(text);
  const absorbed = new Set<string>(CJK_STOP_CHARS);
  for (const term of seen) {
    const chars = [...term];
    if (CJK_ONLY.test(term) && chars.length === 2 && held.has(term)) {
      for (const c of chars) absorbed.add(c);
    }
  }
  let got = 0;
  for (const t of seen) {
    if (!held.has(t)) continue;
    const chars = [...t];
    if (CJK_ONLY.test(t) && chars.length === 1 && absorbed.has(t)) continue;
    got += weight.get(t)!;
  }
  return Math.min(1, got / total);
}
