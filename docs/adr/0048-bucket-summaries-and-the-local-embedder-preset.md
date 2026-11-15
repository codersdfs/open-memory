# ADR-0048: Bucket summaries bound the vector arm; the local embedder preset needs no key

Date: 2026-11-08

Status: Accepted

Implements both halves of P8 of the memory-systems research plan (`docs/research/memory-systems-notes-2026-11-07.md` §3, review verdict: approved, with the correction that the speed baseline is the current **10.3 ms**, not the pre-ADR-0029 28.6 ms). Stands on ADR-0029 (the partition cache this walks beside, and the failed one-dimensional index whose 56% loss defines the bar), ADR-0009 (the switch is settings + restart + reembed, which the new preset rides unchanged), ADR-0016 amendment (the maintenance pass this refresh hangs off), and ADR-0020 (the project dimension the buckets are keyed by). Related: ADR-0025/0026 (the off-by-default discipline and the negative-result precedent), ADR-0004 (the OpenAI-compatible provider this preset reuses).

## Context

Two gaps, one plan item. The **translation half**: `resolveEmbedding` hard-required a non-empty key for every API provider (`src/core/embedding/index.ts:45-48` before this change) and `ApiEmbeddingProvider` sent `authorization: Bearer …` unconditionally (`openai.ts:56`) — so an OpenAI-compatible local endpoint (Ollama, LM Studio, llama.cpp) could not be used at all, and the hash embedder's vector arm contributes nothing. The **scale half**: the vector arm scans its whole partition every search; at 384d that is 1.4 ms warm and 22 ms projected at 10^5, at 2048d it is 150 ms at 10k rows and ~1.5 s projected — past the 700 ms budget. ADR-0026 already named the only lever that changes the order of magnitude: read fewer *rows*, not fewer bytes per row. Every prior attempt to read fewer rows was approximate and was rejected for it (ADR-0029's Rejected section: one-dimensional binning lost 56% of the vector top-5).

## Decision 1: the key is optional exactly where the endpoint is local (`openai-local`)

A fourth preset, `EMBEDDING_PROVIDER=openai-local`, same wire as `openai` (one `ApiEmbeddingProvider`, no new dependency), with two rules:

- **The key is optional.** Empty `OPENAI_API_KEY` sends **no `Authorization` header** — never `Bearer ""`. A local endpoint authenticates by being on localhost, and some builds 401 a malformed Bearer line rather than ignore it. Hosted `openai` still requires its key (its test predates this ADR and still passes), and NIM still requires its key.
- **Nothing else has a default.** A local endpoint's address, model id and width are facts about the user's install, so `OPENAI_BASE_URL`, `OPENAI_EMBED_MODEL` and `EMBEDDING_DIM` are all required before the provider resolves, and the factory names every missing one in one message. A preset that defaulted the width to 1536 for a 768-d model, or the address to api.openai.com for localhost, is exactly the switch-that-lies the factory exists to refuse — the under-configuration throws at preview time, where the console can show it, not at the first embed, where it is a 401 that looks like a broken model.

The console surface follows: `EMBEDDING_PRESETS` carries the row with `keyEnv: null` and `dim: 0` (the documented sentinel for "no width of its own"; the console omits `EMBEDDING_DIM` from that preset's write and says so), the card renders it enabled regardless of key presence with a hint naming the three required variables, and `KEY_ENVS` needed no change — `OPENAI_API_KEY`'s restart-effect and presence inventory already describe the optional key correctly, because saving a key still changes what the next start builds. The switch itself is untouched ADR-0009: settings → dry run → migrate → restart; `.env.example` documents the preset with an Ollama example.

## Decision 2: one bucket per (namespace, project), summarized without a model

`memory_buckets(namespace, project, abstract, dim, embedding, norm, cos_theta, total, pending, updated_at)` — one row per (namespace, project) pair, the split ADR-0020 already made load-bearing. `project` stores `''` for the unscoped backlog because a nullable PRIMARY KEY would let two NULL rows coexist. The summary rows are **not memories**: they never enter `list`, any candidate pool, or any result set — they are derived state like the postings, and every path that can invalidate them does:

- **The abstract** is model-free: the newest 16 live rows, each clipped to 200 characters, newline-joined (`buildAbstract`). It is carried for diagnostics — what the bucket is about, readable in SQL — never ranked on.
- **The geometry** is what the scan reads: the bucket's centroid (the raw mean of its live rows' unit directions) and `cos_theta`, the smallest centroid-to-row cosine over them — together a spherical cap that contains every row direction. Both come from the vectors the store already holds, so **a refresh needs no embedder and no network**, and the summary is in the query's space by construction (a provider swap re-embeds the rows and drops the summaries — see Decision 4).
- **The drift counters**: every write path already funnels through `noteChange`, which now also marks the row's bucket pending (one PK seek + one upsert, off entirely unless the flag is on). A pending bucket is stale by definition.

Refresh runs in the P2 maintenance pass, after the reversible decay, on the same serialized chain — and once at daemon boot when the flag is on, so enabling the feature costs one restart, not one restart plus up to a maintenance interval of full scans. The threshold is OpenViking's freshness policy (`bench/OpenViking/.../freshness_policy.py:16` `refresh_ratio=0.10`, the `pending/total >= ratio` comparison at :48-52; small populations ≤ 32 refresh immediately, :37-41): missing or wrong-width summaries and small buckets always refresh; a bucket with `pending/total ≥ 10%` refreshes; otherwise the pending count keeps accumulating and nothing is lost. Summaries whose bucket no longer holds a live row are dropped. `reembedAll` drops every summary on success — a swap can keep the old width (1536 → another 1536-d model), so the dim check alone would trust old-model geometry; `renameProject`/`forgetProject`/`prune`/`purgeDeleted` drop what they strand, per the same rare-sweep precedent as their `vectors.clear()`.

## Decision 3: the prefilter is a bound, not a ranking — and the ranking version was measured and rejected

The plan sketched "rank the summaries, scan the top-b". **That variant was built and measured, and it failed the acceptance line**: on a clustered 12-bucket corpus with the hash embedder, the exact top-20 of a self-query spanned **six** of the twelve buckets while the abstract-embedding ranking put the query's own bucket **third** — a top-3 scan set missed four of the six buckets holding true hits, and the prefiltered top-20 came back disjoint from the exact one. A summary cosine is a scent; a scent cannot bound.

What shipped instead is the smallest exact filter. For a bucket whose rows all lie within angle θ of its centroid, the largest cosine **any** of its rows can reach with a query at angle δ from the centroid is:

- `1` when the query direction is inside the cap (δ ≤ θ) — the bucket is scanned, always;
- `cos(δ − θ)` when it is outside — `a·cosTheta + √(1−a²)·√(1−cosTheta²)` with `a = cos δ`.

The walk: stale buckets first (no valid bound), then fresh buckets by bound descending, merging each bucket's top-`limit` into the result and stopping at the first bucket whose bound cannot reach the current top-`limit` floor (minus `BUCKET_BOUND_EPS = 1e-9` of float slack, plus `BUCKET_RADIUS_SLACK = 1e-6` of radius slack covering the float32 re-pack of the centroid). A skipped bucket provably holds no row that could enter the top-`limit` — **the prefilter can cost time, never rows**, which is ADR-0029's lesson held structurally rather than by measurement. The scan-set universe comes from the data (`SELECT DISTINCT project` over the same candidate WHERE, cached against the change-seq), never from the summary table, so a bucket with no summary is scanned in full, never skipped; one-bucket partitions and not-yet-warmed stores fall through to the plain exact scan; per-bucket scans reuse `scanCandidates`, so they pay the partition-cache warm price ADR-0029 measured and keep the q8 shortlist working per bucket. The bound math and the refresh thresholds live in one shared module (`src/core/store/buckets.ts`) that both stores call, so the SQL store and `InMemoryVectorStore` cannot drift — the same discipline the facet postings and the lexical arm are held to.

**The population guard** (independent review, 2026-11-08): the summaries describe the DEFAULT population — `is_deleted = 0 AND status = 'active'`, which is what the refresh's universe, abstract and geometry queries all read. A search over a wider one — tombstones (`includeDeleted`), archived or draft rows (`includeArchived` / `includeDraft`), any explicit `status` slice — must not be bucket-filtered: its candidate population reaches rows whose directions no cap covers, and the review probe made the failure concrete (an archived row was the exact scan's top-1 and **absent** from the prefiltered result, on both stores). The guard is one line at the bucketed entry in each store — wider population, `return null`, plain exact scan — following the same any-incapability-falls-back discipline as every other exit. Narrower filters (`type`, `kind`, `project`, `knowledge`, `facet`) need no guard, because a cap over a superset still bounds every subset of it.

Two correctness bugs were found by the exactness test while landing this, and are pinned there now: the cap formula's inside-case (a self-query scored 1.0 against a bound of 0.9999 — the first cut used `cos(δ−θ)` for all δ), and a stored centroid whose `norm` column described the pre-normalization mean while the blob held the unit vector (every bound silently divided by ~100). The radius slack exists because of the second one.

**The reset races the writes it resets** (independent review, 2026-11-09): the refresh's summary upsert sat outside any transaction and set `pending = 0` unconditionally, while `retryWrite`'s BUSY backoff yields the lock between attempts — a concurrent write committing inside that window had its drift marker erased by the retried upsert, and the bucket then trusted a cap that did not contain the new row (a 500-row bucket would wait for 50 more writes to reach the 10% re-refresh), silently dropping it from the bucketed top-20. The reset is now conditional and atomic: the plan-time pending is captured in the same synchronous block as the geometry read (it is the drift count the new cap actually describes), the summary write runs inside `BEGIN IMMEDIATE`, the current pending is re-read inside that lock, and `pendingAfterRefresh` (shared by both stores) leaves `current − plan` — every post-snapshot marker survives, exactly the pre-snapshot drift is cleared. Any generation anomaly — the row swept away mid-refresh, another refresher's write, a counter below the baseline — resets to 1 instead of 0: one extra refresh is cheap, a trusted stale cap is not. The secondary angle closed with it: `markBucketPending`'s upsert can itself lose the immediate-BUSY corner (a WAL checkpoint racing a commit), and with a surviving summary a lost marker meant trusting the stale cap — so the failure path now drops the summary row outright (full scans until the next refresh) and the warning says what actually happened; the old text ("search falls back to full scans") was true only while no summary existed. The drop-fallback and the marker both lean on `busy_timeout` for held write locks (a plain held lock makes them wait, not fail), so the unreachable-in-test corner is narrow: an immediate-BUSY that recurs across both the marker and the drop. That corner is not deterministically reproducible in vitest — stated rather than papered over; the deterministic pins are the reset arithmetic (unit) and the race window itself (a per-bucket `beforeWrite` test seam that puts a real write between the geometry read and the summary write of exactly one bucket: its marker must survive the reset, its row must still top the bucketed search, and a drift-free pass settles the bucket back to 0).

## Measured result

Every number below was produced in the landing session, on this tree, this machine (Windows, Node 24), by the commands quoted.

**Agreement — `node bench/bucket-prefilter.mjs --projects 20 --rows-per-project 500 --queries 60 --embedder …`** (real stack: `MemoryService` + `SqliteVectorStore`, 10,000 rows, 20 buckets × 500, top-20 = the retriever's own over-fetch, 60 queries, ordered-list equality and set overlap):

| corpus | ordered-equal | set overlap |
| --- | --- | --- |
| dense 384d, 20 buckets | 60/60 = **100%** | 1200/1200 = 100% |
| dense 2048d, 20 buckets | 60/60 = **100%** | 1200/1200 = 100% |
| hash 384d, 20 buckets | 60/60 = **100%** | 1200/1200 = 100% |
| dense 384d, 1 bucket (degenerate) | 40/40 = **100%** | 800/800 = 100% |

Gate: ≥99%. Measured: 100% everywhere, including the hash geometry that broke the top-b variant.

**Vector arm cost — same runs** (`vectorSearch` p50, flag off → on):

| corpus | off p50 | on p50 | speedup | 10^5 projection (off → on) |
| --- | --- | --- | --- | --- |
| dense 384d, 20 buckets | 2.21 ms | **0.41 ms** | 5.4× | 22.1 → 4.1 ms |
| dense 2048d, 20 buckets | 150.53 ms | **1.31 ms** | 114.9× | 1505 → 13.1 ms |
| hash 384d, 20 buckets | 2.17 ms | 2.28 ms | 0.95× | 21.7 → 22.8 ms |
| dense 384d, 1 bucket | 0.26 ms | 0.27 ms | 0.96× | 52 → 54 ms |

The 2048d line is the one the int8 shortlist could only reach 1.45× on: it read fewer bytes, the prefilter reads fewer rows. The two sub-1.0 lines are the honest shapes: a hash-embedding corpus has no cluster structure for the caps to exploit (every bound ≈ 1, full scan + small overhead), and a one-bucket partition is the exact scan already.

**End-to-end gate — `node scripts/scale-bench.mjs --rows 4000 --dim 384 --ns 1 --search-runs 50`** (the ADR-0029 baseline configuration; the review-corrected gate is 10.3 ms, which was measured 2026-10-23 — today's machine is faster, so both arms are quoted):

| | search p50 | search p95 | 10^5 projection |
| --- | --- | --- | --- |
| `MEMORY_BUCKET_PREFILTER` off | 5.34 ms | 7.11 ms | 131.85 ms |
| `MEMORY_BUCKET_PREFILTER=on` | **5.07 ms** | 6.06 ms | **125.19 ms** |

Gate: p50 not worse than 10.3 ms — both arms far inside it; 10^5 extrapolation < 700 ms — 125 ms, 5.6× under.

**Evidence ruler — `node bench/evhit.mjs --chunk 1000 --conc 3`** (conv-26, 152 questions, NIM 2048d, k=5 / budget 800 / threshold 0.35, the ADR-0028 grid; one variable = the flag; both runs fresh ingests on this tree, 2026-11-08):

| | evALL | evANY | evidence parts |
| --- | --- | --- | --- |
| prefilter off | 63% (96) | 73% | 118 |
| prefilter on | **64% (97)** | 74% | 119 |

Gate: not below the 66% baseline. Honest reading: the on-arm measured **64% — one point above the same-tree same-day off control (63%), and 151 of 152 questions returned an identical evidence-hit count** (146 identical block sets; the handful of diffs are the fresh-ingest jitter ADR-0046 already documented, since each evhit run re-ingests under NIM). The recorded 66% belongs to the 2026-10-20 tree and box — **today's tree measures 63–64% on both arms**, so the two-point gap to 66 exists with the feature off and is not attributable to it; the store this corpus builds is single-bucket, where the prefilter is a no-op by construction and the exactness of the bound makes a regression structurally impossible.

## Cost

- **Off (default): nothing.** The flag is a strict `=on`; with it off, `noteChange` runs one boolean it already computed, `vectorSearch` takes the path it always took, the `memory_buckets` table stays empty, and the maintenance pass's second step reports "not running".
- **On, per write:** one primary-key seek + one upsert on the bucket key, the same order as the history event a write already records. **Per search:** one small table read, one data-side `DISTINCT project` (cached against the change-seq; the first search after a write pays it), ≤ B dot products for the bounds, and the skipped buckets' scans. **Per refresh:** a full vector read of each drifted bucket (maintenance-time; the same class as one `cosineSpread`), no embedder, no network.
- **Schema:** one new table, no changes to existing ones. **Disk:** one summary row per (namespace, project) — dim × 4 bytes of centroid plus text; thousands of rows per bucket against one row per bucket.
- **What this does not do:** no console surface for the buckets (a default-off flag with no knobs; the summaries are readable in SQL), no cross-partition buckets (a bucket never spans namespaces — the fan-out merge is unchanged), no per-bucket `cosineSpread` (the semantic gate still scans the partition it ranks against — narrowing it would change gate semantics, which is a different ADR), no bucketed `lexicalCandidates` (the postings arm is already index-driven, ADR-0033), and **no prefiltering of wider-than-default populations** — a search carrying `includeArchived` / `includeDraft` / `includeDeleted` or an explicit `status` takes the exact scan by construction, so the archived/tombstone rows the summaries never covered are reachable exactly as before the feature existed.

## Consequences

- `tests/bucket-prefilter.test.ts` pins, on **both** stores: default-off writes nothing and ranks identically; not-warmed falls back to the exact scan; the exact top-20 agreement per query on a clustered corpus; a row written after its bucket's refresh is found immediately (pending → full scan) and the refresh folds the drift back; the ≥10% threshold skips a big bucket under the ratio and refreshes it at or above it while small buckets always refresh; summaries never enter `list` or results; reembed drops every summary and the next search stays exact; rename/forget strand no stale summary; the maintenance pass runs the refresh on its chain and the flag-off hook reports "not running"; the bound's cap cases including the inside-cap one; the exactness premise itself — no row's cosine exceeds its bucket's bound, checked against the real summaries and rows; the pending-reset race (a write placed inside one bucket's geometry-to-write window via the `beforeWrite` seam keeps its drift marker through the refresh, the row still tops the bucketed search, and a drift-free pass settles the bucket to 0; the reset arithmetic pinned unit-side in `pendingAfterRefresh`); and the population guard — an archived row and a tombstone, each the exact scan's top-1 of its own self-query, are returned by the `includeArchived` / `includeDeleted` / explicit-`status` searches (which the review probe showed the unguarded path dropping), while the default-population search still agrees with its exact scan and does not contain them. `tests/embedding.test.ts` pins the preset: no-key resolution, the all-three-missing message, no-`Authorization`-header on the wire (and Bearer when set), the preset row shape, and that hosted `openai` still requires its key. `tests/settings.test.ts` and `tests/console-api.test.ts` pin the four-row preset list.
- A downgrade reads a store with `memory_buckets` as an unknown table (SQLite keeps it; nothing reads it), and an upgrade re-creates it empty — the first boot warm or maintenance pass rebuilds.
- The default posture follows ADR-0026: measured, documented, off. The flag exists for the corpus shape that needs it — one big partition shared by many projects, real embeddings, wide vectors — and the measurements above are what a reviewer should re-run (`bench/bucket-prefilter.mjs`) before widening its default.

## What would change the verdict

A real corpus where the caps are as useless as the hash embedder's — projects whose rows do not cluster in embedding space — measured across a store big enough for the overhead to matter. If the bound walk stops saving anything there, the honest next step is the same as ADR-0026's: record it, keep the flag, and put the effort where the phase split says the time actually is.
