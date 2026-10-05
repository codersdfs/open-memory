// Minimal BM25 for hybrid scoring — offline, no deps.

/** CJK ideographs, kana, and compatibility forms. */
const CJK_CLASS = "\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff";
const CJK_RUN = new RegExp(`[${CJK_CLASS}]+`, "g");
const CJK_ANY = new RegExp(`[${CJK_CLASS}]`, "g");

export function bm25Score(query: string, doc: string): number {
  const qTerms = tokenize(query);
  const dTerms = tokenize(doc);
  if (qTerms.length === 0 || dTerms.length === 0) return 0;
  const tf = new Map<string, number>();
  for (const t of dTerms) tf.set(t, (tf.get(t) ?? 0) + 1);
  const docLen = dTerms.length;
  const avgLen = 20; // heuristic
  const k1 = 1.2, b = 0.75;
  let score = 0;
  for (const q of qTerms) {
    const f = tf.get(q) ?? 0;
    if (f === 0) continue;
    // idf approximated as 1 for local corpus (no global df) — we still reward term overlap
    const idf = 1;
    const numerator = f * (k1 + 1);
    const denominator = f + k1 * (1 - b + b * (docLen / avgLen));
    score += idf * (numerator / denominator);
  }
  // normalize to 0..1 by dividing by max possible (qTerms.length * ~1.5)
  return Math.min(1, score / (qTerms.length * 1.5 + 1e-9));
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