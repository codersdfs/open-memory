# ADR-0031 — The lexical index stays hand-rolled; FTS5 was built, measured, and removed

- **Status**: Accepted
- **Date**: 2026-10-23
- **Amends**: ADR-0012 (candidate union from a term index), ADR-0019 (`term_df`)
- **Related**: ADR-0027 (coverage ranks the union), ADR-0029 (the vector scan it sits beside)

## Context

`lexicalCandidates()` is one of the two arms of the candidate union. It picks the
eight rarest query words and projects `SUM(tf / df)` out of `memory_terms` +
`term_df`, so a search's lexical cost tracks how rare the question's words are rather
than how large the partition is. After ADR-0029 removed the vector scan from the
warm path, this arm became the largest single item in a search: at 4,000 rows /
384 d the store reported `lexicalCandidatesP50Ms ≈ 5 ms` against
`vectorSearchP50Ms ≈ 1.3 ms`.

The obvious suspect was the hand-rolled index. SQLite ships FTS5 — Node's bundled
build has `ENABLE_FTS5` — so the proposal was to replace `memory_terms` with an FTS5
table, get `MATCH` for free, and read document frequencies from `fts5vocab` instead
of maintaining `term_df` in the write transaction.

ADR-0012 had rejected FTS5 once already, but for reasons this leg had answers to:

- its default tokenizer has no CJK unigrams, so Chinese questions were invisible —
  fixable by indexing `indexTerms()`'s output rather than the raw text, since that
  is already CJK-unigram-and-bigram tokenised and space-joined;
- it cannot say "how many times", only "does this row match" — fixable with
  `fts5vocab('…', 'instance')`, one row per indexed occurrence, counted per
  `(document, term)`.

## Decision (as built)

One leg was spent building exactly that: a contentless-enough FTS5 table over the
token stream, `rowid` aliased to `memories.rowid`, the id carried in an `UNINDEXED`
column, tf from the occurrence vocabulary, df from the row vocabulary, and the same
`candidateWhere` filters applied through a join back to `memories`. The new reader
was required to be **exactly equivalent** to the postings reader — same ids, same
scores, same filter semantics — and an equivalence test enforced it, including a
`retry retry retry` row to catch tf being read as 1, a `snake_case_ident` row to catch
the `unicode61` tokenizer splitting it where `indexTerms()` does not, and a df cap
case to catch tombstone drift (`fts5vocab` counts every row it holds, including
soft-deleted ones, while `term_df` only counts live postings).

It worked. The two readers agreed, the suite was green, and the write path got
simpler (no more counter maintenance for a second layout).

Then it was measured.

## Measurement

20,000 rows, marker query — one rare token plus two topic words, which is the shape
every query in this retriever actually has:

| path                          | p50     | p95     |
| ----------------------------- | ------- | ------- |
| `memory_terms` postings       | 8.0 ms  | 10.8 ms |
| FTS5 (`MATCH` + vocabularies) | 74.9 ms | 92.1 ms |

**FTS5 is 9.3× slower**, not faster. The breakdown of where the time goes removed the
obvious tuning explanations:

| step                                  | p50    |
| ------------------------------------- | ------ |
| `SELECT COUNT(*) FROM memories` (live) | 0.30 ms |
| `SELECT COUNT(*) FROM memory_fts`      | 2.60 ms |
| `term_df` lookup (8 tokens)            | 0.01 ms |
| `fts5vocab` row lookup                 | 0.28 ms |
| bare `MATCH` to get rowids             | 0.01 ms |
| one correlated `EXISTS(… MATCH …)` per token | ~9.5 ms |

Every ingredient is cheap in isolation. The cost is structural: **`MATCH` has to scan
for phrase matches to discover which rows hold a token**, while an inverted index
answers the same question with an equality lookup on a primary key. Doing it once per
chosen token, per candidate row, multiplies that scan by the token count — which is
why the aggregate is an order of magnitude worse than any single component suggests.
No index on the FTS5 table fixes this: the scan *is* the lookup.

A second, smaller surprise: `COUNT(*) FROM memory_fts` costs more than
`COUNT(*) FROM memories` (2.6 ms vs 0.3 ms), so the free df counter is not free
either — an FTS5 virtual table's b-tree cannot be counted without walking it.

## Decision

**Revert.** `memory_terms` + `term_df` stays. `lexicalCandidates()` keeps its single
reader, `indexTermsSync()` keeps its rowid-free signature, and `compact()` no longer
issues an FTS5 `optimize`.

The reverted work is not wasted, and the reason it is recorded in code rather than
only here is that the "why not just use FTS5, it is in the box" question is a
reasonable one that will be asked again. `src/core/store/sqlite.ts` carries a comment
block above the postings schema stating the measurement and the structural reason, so
the next person weighs the decision with the same numbers this one did.

## What this does not fix

- **`lexicalCandidates` is still the largest line item in a warm search** (~4.5 ms of
  ~10 ms at 4,000 rows / 384 d). This ADR closes the FTS5 route to it, not the cost.
  The remaining levers are all about *not doing the query* — a narrower `df` cap, a
  cheaper rarity estimate, or folding the union into the vector scan — and each one
  changes what a search returns, so none of them is a drop-in optimisation.
- **Write cost is unchanged.** The postings are maintained in the write transaction,
  which is what makes reads cheap; removing a second layout does not make the first
  one cheaper to write.

## Rejected alternatives

- **Keep FTS5 behind a flag.** It was slower on every query shape measured, and a
  dead optional path is a maintenance liability with no caller. Removing it is the
  honest outcome.
- **FTS5 with `bm25()` instead of tf/df.** One line instead of a hand-computed score,
  but a different ranking rule than ADR-0012 specifies, and it does not address the
  `MATCH` scan cost, which is the actual problem.
- **FTS5 only for the df counter, postings for scoring.** The counter was measured at
  0.28 ms (`fts5vocab`) against 0.01 ms (`term_df`); it is the one part that is
  already cheaper the way it is.
