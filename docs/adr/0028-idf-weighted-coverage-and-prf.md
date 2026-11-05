# ADR-0028: coverage is weighted by df, and the second hop is measured off

- **Status:** Accepted (2026-11-04). Changes `src/core/retrieval/terms.ts` (adds `coverageWeighted`), `src/core/retrieval/hybrid.ts` (weighted rank/sort/MMR/budget, `expand`, `MEMORY_PRF`), `src/core/store/{interface,sqlite,memory}.ts` (`termDf`), `scripts/realtime-bench.mjs` (pins the judge off), `bench/run-locomo.mjs` (chunk 1200 → 1000).
- **Problem.** The LoCoMo shootout reported open-memory at 59.2%, but two things about that number did not survive an audit, and the weak categories pointed straight at retrieval:
  1. The "v0.4 re-run" posted to a long-lived daemon started before the v0.4 retrieval work landed — its store was the old JSON-vector schema (`om-v04.db` has no `memory_vectors` column and a leftover smoke-test row). The current tree had never been measured end-to-end.
  2. The README line "same pinned reader and judge, only open-memory changed" is false: the v0.3 figure (50.7%) was `vyceai/deepseek-v4.1`, but the +8.5pp "re-run" used a *different* run and the v0.4 changes were scored against a different reader in the conv26/ds41 pairings. The honest move is to re-run one arm on the current tree with the reader actually pinned, which this ADR does not itself report — it reports the offline ruler and the ranking change the ruler drove.
  The category split, unchanged across every honest run, is the real target: **multi-hop (cat1) evidence recall 23%, temporal (cat2) 68%.** Those are retrieval questions, not reader questions.

## New ruler: the evidence-hit audit (`bench/evhit.mjs`)

- Reader, judge and gateway are all in the LoCoMo number's path, so none of them can be trusted to isolate the memory system, and a re-run costs ~30 min and a paid LLM per question. The dataset already carries the ground truth retrieval needs: **every LoCoMo question names the `evidence` turns (`D1:5`) that answer it, and the harness stamps every stored chunk with its turn's `[Dx:y]` id.** So the retrieval can be scored with no model at all: store the conversation, run each question through the real `POST /memories/search`, and ask what fraction of the gold turns landed in the retrieved blocks. `evhit.mjs` spawns the current tree against a fresh store, does exactly that over all 152 conv-26 questions, and prints per-category `evALL` / `evANY` / `ev-part`.
- This is a model-free ruler and never claims an accuracy number; it measures *whether the answer's evidence reaches the context*, which is the half the benchmark's own writeup says the gains live in ("the remaining misses are still dominated by retrieval, not by the reader").

## Diagnosis: coverage's denominator was a count, its numerator should have been a sum

- ADR-0027 made `coverage` the sort key, the gate, and the relevance term for MMR and the budget. Each asked term was worth 1. For a corpus that is one ongoing conversation, that is backwards: **"What is Caroline's identity?" asks {caroline, identity}; `caroline` is the protagonist, so it sits in ~every chunk, and `identity` is in none of the row that answers it (D1:5: "I am a transgender woman").** Half the store scores coverage 0.5 exactly like the gold row does, so the coverage-first ordering (ADR-0027) breaks the tie by recency+strength — the two signals with nothing to do with what was asked — and the gold chunk never surfaces. The trace confirms the shape: that query retrieved sessions 3,4,7,11,17, and never session 1.
- The textbook fix is to stop counting matched terms and start summing their **inverse document frequencies**. `coverageWeighted(text, query, df)` weights each asked word by `log(1 + maxDf/df)` over the *asked* terms, so a word in every row earns `log 2 ≈ 0.69` and a word two rows hold earns far more; the share is `held-weight / total-weight`. `df` comes from a new optional `store.termDf(tokens)` — the `term_df` table ADR-0019 already maintains in the write transaction, read by primary key.

- **Decision (1): weighting orders, it does not gate.** The measured regression that pinned this: making the *gate* read the weighted share let a row holding one rare query word reach `coverage 1.0 >= 0.75` and pass ADR-0027's coverage admission, which changed the gate's meaning (it is supposed to admit a row holding three-quarters of *what was asked*, not a row holding one rare word). So the two live apart: the gate keeps reading the unweighted `coverageScore` (ADR-0027 semantics, and `tests/diagnostics.test.ts`'s near-miss counts stay byte-stable), and only the sort, MMR input, and budget input switch to `coverageWeightedScore`. A store without `termDf` falls back to the candidate-set `df` the BM25 pass already built — a coarser estimate of the same quantity, never inverted.

## The second hop: pseudo-relevance feedback, built and measured off

- **Decision (2).** The remaining multi-hop failures are the classic "answer shares none of the question's vocabulary" case ("What books has Melanie read?" does not contain *Nothing is Impossible*). A PRF pass was built: take the top-2 first-pass rows, find the terms **both** hold that the question does not, cap each term by the ADR-0019 `DF_CAP_RATIO` rule (a word held by a third of the partition is the protagonist's name, not the topic) and require `df >= 2`, keep the 5 rarest such terms, re-search **lexically-only** (no vector arm, no cosine spread) on `query + those terms`, merge the new rows, and re-cover them against the *original* question so an expansion hit never outranks a row that answered the question directly. `MEMORY_PRF=on` gates it; it is best-effort on every step (no `termDf`, no seeds, a failed read → pass one stands).

- **Measured result, and why it is off by default.** At 1000-char chunks, NIM embeddings, 152 questions — the only difference is `MEMORY_PRF`:

  | | evALL | evANY | cat1 evALL/ev-part | cat4 evALL | avg blocks |
  |---|---|---|---|---|---|
  | PRF **off** (default) | **66%** | **76%** | 13% / 30% | 87% | 4.53 |
  | PRF on | 63% | 72% | 16% / 31% | 83% | 4.26 |

  PRF *did* reach new multi-hop rows (cat1 evidence-part 30 → 31%, a few questions went 1→2 of 2 golds), but it merged them into a **fixed 800-token budget** that whole first-pass single-hop rows needed, and the any-evidence share fell 76 → 72%. Net negative on this corpus. It is kept behind `MEMORY_PRF=on` — the same disposition the int8 shortlist got (ADR-0026): built, measured, shipped off. Its cost is a real second posting-list pass; its win-shape is a partition of short rows whose second hop is rare, not a store of long topically-similar chunks.

- **Decision (3): both the ranking change and the chunk size are measured at one variable at a time.** The model-free grid (NIM, 152 questions) is laid out so each lever is isolated by holding the others fixed, and the earlier confound (the 1200 → 1000 headline mixing chunk *and* weighting) is now resolved by running the fixed-code sweep:

  **(a) The weighting, at one fixed chunk (1200) and one fixed store shape, old-unweighted → new-weighted:**

  | code @1200 | evALL | evANY | cat2 evALL | cat4 evALL |
  |---|---|---|---|---|
  | unweighted (ADR-0027) | 57% | 68% | 68% | 83% |
  | **weighted (ADR-0028)** | **64%** | **76%** | 86% | 89% |

  +7 evALL / +8 evANY from the ranking change alone, chunk held at 1200. This is the clean attribution the confounded table could not give.

  **(b) The chunk size, at fixed new code (weighted, PRF off):**

  | chunk | evALL | evANY | cat1 evALL | cat2 evALL | avg blocks |
  |---|---|---|---|---|---|
  | 600 | 61% | 72% | 9% | 86% | 4.93 |
  | 800 | **66%** | **76%** | **16%** | 89% | 4.99 |
  | 1000 | **66%** | **76%** | 13% | 86% | 4.53 |
  | 1200 | 64% | 76% | 3% | 86% | 4.40 |

  Under a fixed 800-token budget the whole-row rule (ADR-0014) fits ~four chunks. A smaller chunk puts the answer nearer the head (cat2 sits at 86–89%), but below ~800 the extra same-topic rows crowd multi-hop evidence out (cat1 16% at 800 → 9% at 600 → 3% at 1200 is the crowding-from-the-other-side). **800 and 1000 are statistically tied on evALL/evANY** (the cat1 gap is 16 vs 13 out of 32, within noise); 1000 was the point the end-to-end accuracy run used, so it is what `run-locomo.mjs` keeps. The honest claim is "a ~800–1000 chunk, measured", not "1000 is uniquely optimal".

  **(c) The PRF second hop, at fixed chunk 1000 and fixed weighted code, only `MEMORY_PRF` differs:** off **66/76** vs on 63/72 — off wins (see Decision 2). This is the isolated PRF measurement.

  Read together: the accuracy gain decomposes into the weighting (+7–8 evALL, a), a chunk in the 800–1000 band (b), and a second pass that was built, measured net-negative, and left off (c).

## The judge leaked into a benchmark that promised it would not

- `scripts/realtime-bench.mjs` advertises "no key, no network, reproducible" and defaults to the hash embedder for that reason. But `~/.ai-memory/settings.json` holds a `JEV_API_KEY`, and ADR-0041's write gate reads the *merged* env on every write ≥12 chars. The result: a headline run had **write p50 209 ms** (was 3 ms) — every `saveDetailed` in the mixed workload was making a model round trip, the run's saturation point moved with an unrelated service, and 6 requests dropped at 60 req/s.
- **Decision (4): the bench pins its own judgment off.** `process.env.MEMORY_JEV ??= "false"` before the service starts (`??=` so a caller who *wants* the judged write path can set a real env value and win). With that, the same run is `verdict: pass`: 0 dropped, stall 39 ms, write p50 back to single digits, and bare/CJK/noisy recall@5 all 1.00 — the ranking change did not disturb the term-index path ADR-0027 owns. The vector arm was separately confirmed with `--embedder synthetic`: 20 req/s, recall@5 0.9889, semantic shape 0.962, **verdict pass**.

## Consequences

- `tests/prf-coverage.test.ts` (12): `coverageWeighted` weights a ubiquitous term below a rare one and returns 1 for a full holder regardless of df; both `termDf` backends agree on the count; the PRF pass reaches a topic-sharing zero-question-overlap row *only* when `MEMORY_PRF=on`, respects the df cap so it never expands on a protagonist-name term, and never lets an expansion hit outrank the row that answered. The gate-isolation choice is pinned by the rest of the suite staying green unchanged (`tests/diagnostics.test.ts` near-miss counts did not move).
- Full suite: **673 passed, 7 skipped** (was 632 / 7).
- `bench/evhit.mjs` is now the fast inner loop for any retrieval change: `node evhit.mjs --tag X`, no gateway, and its `results/evhit-*.json` are the before/after evidence for this and future ranking ADRs. It must be run **serially** — parallel NIM-embedding ingest runs share a rate limit and one poisoned grid cell in this ADR's data (a cat4 collapse to 3% was an HTTP timeout, not a retrieval result; the clean re-run replaced it).
- The honest end-to-end LoCoMo accuracy on the current tree, with the reader actually pinned and the chunk size above, is re-run separately and reported in the README; the numbers here are the retrieval ruler, not that accuracy.
- Known limit: `termDf` is partition-wide df from `term_df`, so coverage weighting is calibrated to the store's own vocabulary. A query word that has never been indexed contributes 0 to the denominator (dropped), which is correct (no row can hold it) but means a query written entirely in unseen words still returns its lexical candidates via BM25, not coverage — unchanged from ADR-0027.
