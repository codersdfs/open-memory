// Minimal BM25 for hybrid scoring — offline, no deps.

/** CJK ideographs, kana, and compatibility forms. */
const CJK_CLASS = "\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff";
const CJK_RUN = new RegExp(`[${CJK_CLASS}]+`, "g");
const CJK_ANY = new RegExp(`[${CJK_CLASS}]`, "g");

/**
 * Corpus statistics from the candidate set a score is about to be computed over.
 *
 * Optional on purpose: with no stats the function keeps its v0.3 behaviour
 * (idf=1, avgLen=20), which is what the unit tests pin. A caller that has the
 * candidates in hand should pass them: the hardcoded avgLen of 20 tokens was
 * calibrated on one-sentence memories, and a bench corpus of 1,200-character
 * session chunks (≈275 tokens) then scored every term at 1/14 of its weight —
 * measured as BM25 collapsing to ~0.01 on rows whose text contained the words
 * verbatim, which is how exact-match evidence fell out of the relevance gate.
 */
export interface Bm25CorpusStats {
  /** Mean document length in tokens across the candidates. */
  avgLen: number;
  /** Number of candidates. */
  docs: number;
  /** Document frequency of each term (any term the query mentions). */
  df: Map<string, number>;
  /**
   * The query as it was asked, in the vocabulary the index stores.
   *
   * The denominator below is "what a document would score if it held every query
   * term". For English that is the whole query. For Chinese a single topic word
   * expands into unigrams and bigrams — 「配置」 is 配/配置/置 — so counting all of
   * them meant a document holding the word *verbatim* earned 2 of 3 shares and
   * could not clear 0.35. Measured on the real-time bench: the gold row scored
   * bm25 0.135 while unrelated filler scored 0.127, so the correct answer and the
   * noise were separated by 0.008 and the threshold could not tell them apart.
   * Callers that expand a query this way pass the pre-expansion terms here; the
   * numerator keeps using every term, so a document matching more of the
   * expansion is still scored higher.
   */
  queryTerms?: string[];
}

export function bm25Score(query: string, doc: string, stats?: Bm25CorpusStats): number {
  const qTerms = tokenize(query);
  const dTerms = tokenize(doc);
  if (qTerms.length === 0 || dTerms.length === 0) return 0;
  const tf = new Map<string, number>();
  for (const t of dTerms) tf.set(t, (tf.get(t) ?? 0) + 1);
  const docLen = dTerms.length;
  const avgLen = stats && stats.avgLen > 0 ? stats.avgLen : 20;
  const k1 = 1.2, b = 0.75;
  const idfOf = (t: string) =>
    stats
      ? Math.log(1 + (stats.docs - (stats.df.get(t) ?? 0) + 0.5) / ((stats.df.get(t) ?? 0) + 0.5))
      : 1;
  // A document at the mean length scores this per term when it holds it once.
  const saturated = (k1 + 1) / (1 + k1 * (1 - b + b * (avgLen / avgLen)));
  let score = 0;
  let maxScore = 0;
  for (const q of qTerms) {
    // With corpus stats, rarity counts: a term in 1 of 40 candidates is worth
    // more than one in 30 of them. Without, every term is worth 1 — the v0.3
    // approximation kept for callers that have no corpus.
    maxScore += idfOf(q) * saturated;
    const f = tf.get(q) ?? 0;
    if (f === 0) continue;
    const numerator = f * (k1 + 1);
    const denominator = f + k1 * (1 - b + b * (docLen / avgLen));
    score += idfOf(q) * (numerator / denominator);
  }
  // Normalize to 0..1 by the score a document of this length would get if it
  // contained every query term at tf=1. Keeps the threshold meaningful: 0.35 is
  // still "a third of the query's best possible match".
  let denom = stats ? maxScore : qTerms.length * 1.5 + 1e-9;
  if (stats?.queryTerms?.length) {
    // The scale the question was asked on, not the one its expansion produced.
    // Every term the document could have held is still in the numerator, so a row
    // matching more of the expansion still ranks higher — it is only the
    // *denominator* that changes, and it stops a long Chinese question from
    // dividing a verbatim match by the unigrams and straddle bigrams its own words
    // happened to produce. A full match still lands at 1.0: the denominator is
    // never smaller than what `maxScore` would have been for a query whose terms
    // the document all holds.
    let best = 0;
    for (const q of stats.queryTerms) best += idfOf(q) * saturated;
    let fullMatch = 0;
    for (const q of qTerms) {
      if ((tf.get(q) ?? 0) === 0) continue;
      const f = Math.min(tf.get(q)!, 1);
      fullMatch += idfOf(q) * (f * (k1 + 1)) / (f + k1 * (1 - b + b * (docLen / avgLen)));
    }
    denom = Math.max(best, fullMatch);
  }
  return Math.min(1, score / (denom + 1e-9));
}

/**
 * Latin words plus CJK unigrams and bigrams.
 *
 * The previous tokenizer split on `[^a-z0-9]+`, which made every CJK character
 * a delimiter: "用什么语言说话" produced zero terms, so BM25 contributed nothing
 * for any Chinese query and every Chinese memory was unreachable. It failed
 * silently — no error, just ranking by noise.
 *
 * Bigrams rather than an FTS5 trigram index: Chinese words are mostly two
 * characters ("语言", "中文") and trigram matching needs three, so trigrams miss
 * exactly the words that matter. Bigrams need no schema change and no backfill,
 * so an existing memory.db works the moment this lands.
 *
 * ponytail: bigrams, not a segmenter. Intl.Segmenter ships in node and does real
 * word boundaries — swap it in if recall ever misses a phrase a human would say
 * is in there.
 */
export function tokenize(s: string): string[] {
  const lower = s.toLowerCase();
  const out: string[] = [];

  // Unigram + bigram per CJK run: a one-character query still matches, and the
  // common two-character word matches exactly.
  for (const run of lower.match(CJK_RUN) ?? []) {
    const chars = [...run];
    for (let i = 0; i < chars.length; i++) {
      out.push(chars[i]);
      if (i + 1 < chars.length) out.push(chars[i] + chars[i + 1]);
    }
  }

  // Everything else, on word boundaries — "frank 说话中文" still yields "frank".
  for (const w of lower.replace(CJK_ANY, " ").split(/[^a-z0-9_]+/)) {
    if (w) out.push(w);
  }

  return out;
}