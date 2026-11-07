# AI Memory

A local-first, namespace-partitioned memory substrate for AI agents that stores, retrieves, and budgets historical context without burning tokens or degrading prompt quality.

## Language

**Memory**: A single stored unit of recall: text plus vector plus metadata.
_Avoid_: context, chunk, document

**Episodic Memory**: What happened — time-bound events and observations from interactions.
_Avoid_: history, log

**Semantic Memory**: Stable facts and preferences about the user or world, e.g. "user lives in Berlin".
_Avoid_: fact, knowledge

**Procedural Memory**: How-to knowledge, skills, and routines the agent can reuse.
_Avoid_: instruction, tool

**Working Memory**: Current task or goal-scoped context, short-lived and replaceable.
_Avoid_: cache, scratchpad

**Namespace**: The isolation key `{agentId, userId}` that partitions all memories.

**Declared Agent**: An MCP client the user described in `~/.ai-memory/agents.json` rather than in code — its config file, the key path the server map lives at, optional env and an instructions file. Built-in ids (`claude`, `codex`, `dsh`, `pi`) are reserved: a declaration that collides with one is ignored, because the built-in writes more than an MCP entry. Every linked agent gets `AI_MEMORY_AGENT=<id>`, which is what puts its writes in its own partition.
_Avoid_: plugin, custom adapter

**Read fan-out**: A read covers the caller's own partition, the `shared` partition, and `default:default` — where memories written before scoping existed live. Leaving the legacy partition out does not narrow a search, it empties it: an agent marker in the environment made a bare `ai-memory search` look only at `pi:<user>` (0 rows) while every row the user had sat in `default:default`. Writes still land in exactly one partition. `--all` widens a read to every partition this user owns — the only way to reach a partition written under a different agent identity — and never crosses into another user's partitions. It is answered by enumerating the store, not by constructing a fixed name list from the request: the list form silently covered less than the plain layered read, which is the one thing a flag called `all` must never do (ADR-0038).
_Avoid_: tenant, workspace

**Token Burning**: Cost and latency incurred by injecting too many tokens of memory into a prompt.

**Context Burning**: Quality degradation from injecting irrelevant or low-value memories that dilute the prompt.

**Importance**: A 0..1 score of how critical a memory is to retain; boosts rank and resists decay.

**Supersede**: Linking a new Memory to an old one via `supersedesId` and soft-deleting the old while keeping it for audit.

**Hard Budget**: A maximum token cap for any single search result; overflow is summarized, not stuffed.

**Smart Search**: Two-stage retrieval — Stage 1 hybrid scoring over the candidate union, Stage 2 MMR, hard budget enforcement, and projection into whatever budget is left.
_Avoid_: semantic search (the default embedder is lexical), fuzzy recall

**Coverage**: The share of a query's own words a row holds, counting a matched two-character word once. It ranks above the hybrid score, admits a row that holds three quarters of the words whatever its score, and is what MMR and the budget order by. Exists because a score answers "is this relevant" but cannot always answer "was this the row asked for" — in Chinese the filler shares the question's subject matter instead of its function words (ADR-0027).
_Avoid_: overlap, match rate, similarity

**Weighted coverage**: The same share where each asked word is counted by how rare it is in the partition (`log(1 + maxDf/df)` over the asked terms), not as one flat unit. It exists because coverage-as-a-count breaks the other way on a conversation corpus: a question that names the protagonist ("What is Caroline's identity?") scores half the store identically, since `caroline` sits in every row and `identity` in the one that answers — so coverage-led ranking falls back on age and use (ADR-0028). It **orders only — it never gates**: a row holding one rare word would reach a weighted 1.0, and the gate must keep meaning "holds three quarters of what was asked", so the unweighted `coverage` is what the relevance admission reads while the weighted one is what the sort, MMR and the budget see. Its df comes from `term_df`, the same table the lexical arm maintains.
_Avoid_: coverage (that one gates), tf-idf coverage (the weighting is idf over the asked set, not a per-document term score)

**Pseudo-relevance feedback (PRF)**: An optional second lexical pass — the terms the top two hits share, minus the question's own words, capped by document frequency so a protagonist's name cannot expand — re-run to reach rows that hold the rest of a multi-hop answer without any of the question's vocabulary. Built, measured net-negative on the LoCoMo evidence audit (the merged rows crowd a fixed token budget that whole single-hop rows needed: evidence-any 76% → 72%), and therefore **off by default**: `MEMORY_PRF=on` opts in, the same disposition the int8 shortlist took (ADR-0028).
_Avoid_: query expansion (that is user-supplied), reranking (this fetches new candidates, it does not reorder existing ones)

**Evidence-hit audit** (`bench/evhit.mjs`): The model-free ruler for retrieval — store the conversation, run every LoCoMo question through the real `POST /memories/search`, and score what share of the question's own `evidence` turn-ids landed in the retrieved blocks (`[Dx:y]` stamps make it checkable with no reader and no judge). Exists because the accuracy number routes through a reader model and a paid gateway, so it cannot isolate the memory system and costs ~30 minutes a run; this costs NIM embeddings and seconds. It measures whether the answer's evidence reaches the context, never whether an answer is correct, and must be run one tag at a time (parallel NIM ingest shares a rate limit).
_Avoid_: offline accuracy (it reports no accuracy), the LoCoMo harness (that one has a reader and a judge)

**Candidate union**: The Stage 1 candidate set = vector top-`max(20, k*4)` ∪ term-index top-`max(20, k*4)`. Neither side is a filter on the other; a row found only by its words enters scoring with `vectorScore = 0` and still has to clear the same relevance gate. Before v0.4 BM25 only re-ranked the vector window, so recall@5 equalled P(target ranked in the top 20 by cosine) — 32.5% of known targets fell outside it.
_Avoid_: hybrid search (that names the scoring, not the candidate set), vector recall

**Empty-search diagnostics**: What an empty `SearchResult` carries instead of the bare sentence "no memories matched" — the threshold, the row count of every partition actually searched, the nearest candidates that were rejected, and (ADR-0039) the partitions the read did not cover but which still hold rows. Exists because that sentence was identical for "nothing is stored here", "you are looking at the wrong partition" and "the rows exist, your words missed", and the only move it suggests is to reword and retry, which cannot work for the first two (ADR-0037). The renderer answers with one of three last lines, one per correct next move: store the fact, change the words, or lower the threshold — and "change the words" is the branch taken when nothing was even a candidate, because a gate that never ran cannot be lowered. The fourth line outranks all of them: when the scope holds nothing but `outside` names a partition that does, "nothing was stored for this scope" is true and is the sentence that sends the caller off to reword a fact that is simply filed under another agent (ADR-0039).
_Avoid_: no results, empty state, zero hits

**Shape gate**: The write-time filter that rejects text by structure rather than wording — table rows, headings, list bullets, prompt XML, code fences, fixture headers, and terminator-less slices under 40 characters (first-person facts excepted). Measured 165/180 junk rows rejected with 5 false kills in 335 rows.
_Avoid_: quality filter, content filter, junk detector

**Curation**: The verdict every write passes through in `saveDetailed` before the embed — does this deserve to exist at all? Nine named classes, bilingual, zero model calls; secrets and conversational repairs are refused on every path, progress narration and self-narration demote an explicit write to `note` 0.35 with a `curation:*` tag, and every refusal names one next move instead of an error (ADR-0040). It answers the question the shape gate never could, because the shape gate only polices the extractor's slices while the junk arrived through every other door. Distilled from Mem0's empty-output few-shots, Letta's "self-contained facts, not conversational fragments", Memobase's non-statement examples and Zep's supersede-not-delete; the two classes the whole field leaves to prompt advice — secrets and negation — are exactly the ones it leads with. `MEMORY_CURATE=off` restores the un-gated store.
_Avoid_: moderation, validation, the shape gate (that one is structural and extractor-only)

**Write gate**: The second gate, asked of the model instead of a regex (ADR-0041) — the judgement call no lexical rule settles, put to every write that survives curation. Two questions, one request: `keep` (will this still be useful weeks from now) and `scaffold` (is this the agent's own scaffolding or session narration). Below the floor an extractor-sourced write is refused as `low-value`, an explicit one is demoted — priced, not refused, and never when the caller named a kind or an importance. Same endpoint and key as jev, fail-open the same way, and a row jev already priced never asks twice: one judgement per row.
_Avoid_: curation (deterministic, runs first), jev (the extractor's judge, extraction-only), reconcile (decides effect on neighbours, not existence)

**Archive**: The default life-cycle action: a row past its kind's window whose `importance` is under `0.6` and whose hotness has fallen below the keep line becomes `status = archived` — hidden from search, still readable with `includeArchived`, reversible. Deleting is a separate opt-in hard pass the scheduler cannot reach. Decay used to mean "prune", which is why the verb changed.
_Avoid_: decay, prune, eviction (each names a different thing now)

**Hotness**: What "still in use" means to the archive rule since the ADR-0016 amendment — `log1p(use_count) × exp(−ln2 · age / window)`, the row's retrieval count against the time since its last activity, with the kind's retention window doubling as the half-life (no new global constant). A row survives while at least as hot as one used a single time one window ago; the keep line is derived, not tuned. It replaced the binary `lastUsedAt !== null` test, under which one retrieval immunised a row forever while 89% of the audited store had never been asked for. The durable kinds are skipped before the formula is read, and the `importance < 0.6` floor still applies after it (ADR-0021).
_Avoid_: strength (the +0.02-per-use score), popularity, recency alone

**Maintenance**: The daemon's scheduled sweep — `MEMORY_MAINTAIN_HOURS` (default 24, `0` off) fires the reversible pass from the server main entry, and `runScheduledDecay` takes no options bag, so the hard pass is unreachable from the trigger by signature. `store_meta` keeps `last_maintenance_at`, so an overdue store is caught up in the background at open instead of waiting an interval; no request blocks on a sweep and each pass logs to stderr (ADR-0016 amendment).
_Avoid_: decay (the pass it runs), the `POST /decay` button (the human half), cron (this is not one)

**Projection**: Assembling a memory block from its most query-relevant lines — its best line, that line's neighbours, and the block's dated header — but only into budget left over after every whole row that fits has been placed. Projecting every block up front was measured to lose evidence (single-hop 55/70 → 43/70).
_Avoid_: summarization, truncation, chunking

**Project**: The effort a memory is about, stored as a slug (`memory`, `open-memory`) on the row, independent of the Namespace that says who wrote it. Resolved explicit → `MEMORY_PROJECT` → the git work-tree root, slugged → null. It is a dimension, not a partition: the shared layer and the read fan-out are unchanged, and two agents in the same checkout derive the same slug without coordinating. Managed where it is stored — `project init|list|rename|forget`, `memory_project`, `/projects`; `init` writes one durable marker tagged `project:init` (visible to management, skipped by the brief), rename folds two efforts only on an explicit merge, and forget is a soft delete (restorable) with detach (unscope) as the explicit alternative (ADR-0042).
_Avoid_: repository key, workspace, repo namespace, project registry (no second copy of the dimension exists)

**Kind**: Why a memory deserves to survive — `decision`, `convention`, `gotcha` (durable: decay never archives them), `fact` (90d), `task` (7d), `note` (30d). Derived lexically from the text, bilingual, zero model calls; an explicit kind always wins and supplies its own default importance.
_Avoid_: category, label, tag

**Brief**: The deterministic block a session reads before it has a question — sections conventions → decisions → gotchas → open → recent, inside a token budget, byte-identical for the same store and clock. A Brief guarantees coverage; a search ranks against a query. `memory_brief`, `GET|POST /brief`, `ai-memory brief`.
_Avoid_: context dump, summary, digest

**Knowledge page**: One markdown file in the vault, identified by its frontmatter `slug:` or its path relative to the vault without `.md` (`how-tokens-work`). The file is the truth; the rows are its index. A page owns its sections and its outgoing links.
_Avoid_: document, wiki entry, note file

**Knowledge section**: One heading-delimited part of a Knowledge page, stored as a memory row under `knowledgeId` + `knowledgeSection`. The key comes from the heading (`how-tokens-work`, repeats `-2`, CJK kept, position only as a fallback), so inserting a paragraph elsewhere rewrites nothing. Its text is `[page title] heading: prose`.
_Avoid_: chunk, fragment, block

**Knowledge link**: A `[[target]]` edge declared in a page body or its frontmatter `links:`, stored in `knowledge_links` with `to_id = NULL` when the target does not resolve (that null is maintenance debt, not an error). Links are shown on a hit and walked only by an explicit `neighbors` call — retrieval never expands them implicitly.
_Avoid_: backlink index, auto-context, graph hop

**Layer (solo alias)**: Tencent L0-L3 mapped onto flat types without a new column — `L0 raw conversation ~= episodic (source: chat)`, `L1 Atom ~= semantic fact (importance >=0.7)`, `L2 Scenario ~= semantic|procedural with tags scope:scenario:* / scope:repo:*`, `L3 Persona ~= semantic with tags scope:persona`. Layers are simulated via `tags` + `importance`; retrieval stays one flat `HybridRetriever` call.
_Avoid_: L0/L1/L2/L3 as separate types

**Vector blob**: A row's embedding as raw float32 bytes in `memory_vectors(memory_id, dim, vec, norm)`, not JSON in the row. Rows read off the scan path carry `embedding: []` on purpose; `getById` and `list` are the two places that attach it.
_Avoid_: embedding column, stored vector (it now lives in its own table)

**Two-phase read**: `vectorSearch` scores `(id, vec, dim, norm)` first, sorts and slices, then fetches whole rows for the survivors only. The phase boundary is what keeps a 10^5-row scan from also paying for text and tags.
_Avoid_: quick scan, prefilter

**Partition vector cache**: The decoded candidate set a search scored against — ids, norms and one flat `Float32Array` of vectors — kept so the next query over the same rows does not re-read the blob column. Keyed by the resolved `WHERE` clause, not merely the namespace, because `project`/`kind`/`status` pick different rows inside one partition; bounded by `MEMORY_VECTOR_CACHE_MB` and evicted least-recently-used. A write never throws a decode away when it can be told what changed: an **insert** is appended from the store's change log, a **rewrite** is patched in place at the slot the entry keeps for that row, and only a **delete or re-label** — which moves a row out of the candidate set — marks the entry stale for one rebuild. It changes only the cost of a scan, never its result: the same floats, the same cosine, the same top-k. (ADR-0029, ADR-0034, ADR-0035, ADR-0036)
_Avoid_: index, ANN (it is neither — nothing is approximated and no structure is maintained beyond a decode)

**Bulk write**: `insertMany` / `saveMany` / `POST /memories/bulk` — one transaction and one embed batch for up to 5000 rows, with write-time reconcile **off** by default because a five-neighbour search per row is quadratic on an import. A bulk import is new material; a history replay that must reconcile passes the flag. The cheap gates do run here (ADR-0018 amendment, 2026-11-07): the curation verdict per row — a rejected line skips with a `skipDetails` reason rather than killing the batch, and `secret` plus empty text are refused even under `raw` — plus exact-text folding on the derived `text_hash` column within one partition (namespace, project, type), against readable live rows only.
_Avoid_: batch insert (it undersells the reconcile decision), import (that is the CLI verb)

**Purge / compact**: `purgeDeleted` hard-deletes tombstones (and their postings and vectors) and cannot be undone; `compact` VACUUMs the file and reports footprint (db + WAL + shm). Soft delete keeps bytes, so without the pair the file only grows.
_Avoid_: cleanup, vacuum (one is a policy, the other is a command)

**Console**: The one browser UI (`ui/`, built to `dist/src/ui-next`, served at `/`). It is a client of the store, not part of it — distinct from the store, the CLI and the MCP server.
_Avoid_: inspector, dashboard, front-end

**Theme (Vantablack / Paper)**: One token set with two values — Vantablack (dark, the default) and Paper (warm-white light). Anything that hardcodes a colour is a bug.
_Avoid_: dark mode, skin

**Embedding switch**: The non-secret settings file the console writes (`~/.ai-memory/settings.json`) plus the migration and restart that apply it — the provider is never swapped in place, because one process serves one vector space. A real environment variable, `.env` included, beats the file, and the file beats the built-in default.
_Avoid_: hot swap, live provider
