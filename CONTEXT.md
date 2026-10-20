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

**Read fan-out**: A read covers the caller's own partition, the `shared` partition, and `default:default` — where memories written before scoping existed live. Leaving the legacy partition out does not narrow a search, it empties it: an agent marker in the environment made a bare `ai-memory search` look only at `pi:<user>` (0 rows) while every row the user had sat in `default:default`. Writes still land in exactly one partition. `--all` widens a read to every partition this user owns — the only way to reach a partition written under a different agent identity — and never crosses into another user's partitions.
_Avoid_: tenant, workspace

**Token Burning**: Cost and latency incurred by injecting too many tokens of memory into a prompt.

**Context Burning**: Quality degradation from injecting irrelevant or low-value memories that dilute the prompt.

**Importance**: A 0..1 score of how critical a memory is to retain; boosts rank and resists decay.

**Supersede**: Linking a new Memory to an old one via `supersedesId` and soft-deleting the old while keeping it for audit.

**Hard Budget**: A maximum token cap for any single search result; overflow is summarized, not stuffed.

**Smart Search**: Two-stage retrieval — Stage 1 hybrid scoring over the candidate union, Stage 2 MMR, hard budget enforcement, and projection into whatever budget is left.
_Avoid_: semantic search (the default embedder is lexical), fuzzy recall

**Candidate union**: The Stage 1 candidate set = vector top-`max(20, k*4)` ∪ term-index top-`max(20, k*4)`. Neither side is a filter on the other; a row found only by its words enters scoring with `vectorScore = 0` and still has to clear the same relevance gate. Before v0.4 BM25 only re-ranked the vector window, so recall@5 equalled P(target ranked in the top 20 by cosine) — 32.5% of known targets fell outside it.
_Avoid_: hybrid search (that names the scoring, not the candidate set), vector recall

**Shape gate**: The write-time filter that rejects text by structure rather than wording — table rows, headings, list bullets, prompt XML, code fences, fixture headers, and terminator-less slices under 40 characters (first-person facts excepted). Measured 165/180 junk rows rejected with 5 false kills in 335 rows.
_Avoid_: quality filter, content filter, junk detector

**Archive**: The default life-cycle action: a row that was written, never retrieved, is older than 30 days and has `importance < 0.6` becomes `status = archived` — hidden from search, still readable with `includeArchived`, reversible. Deleting is a separate opt-in hard pass. Decay used to mean "prune", which is why the verb changed.
_Avoid_: decay, prune, eviction (each names a different thing now)

**Projection**: Assembling a memory block from its most query-relevant lines — its best line, that line's neighbours, and the block's dated header — but only into budget left over after every whole row that fits has been placed. Projecting every block up front was measured to lose evidence (single-hop 55/70 → 43/70).
_Avoid_: summarization, truncation, chunking

**Project**: The effort a memory is about, stored as a slug (`memory`, `open-memory`) on the row, independent of the Namespace that says who wrote it. Resolved explicit → `MEMORY_PROJECT` → the git work-tree root, slugged → null. It is a dimension, not a partition: the shared layer and the read fan-out are unchanged, and two agents in the same checkout derive the same slug without coordinating.
_Avoid_: repository key, workspace, repo namespace

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

**Bulk write**: `insertMany` / `saveMany` / `POST /memories/bulk` — one transaction and one embed batch for up to 5000 rows, with write-time reconcile **off** by default because a five-neighbour search per row is quadratic on an import. A bulk import is new material; a history replay that must reconcile passes the flag.
_Avoid_: batch insert (it undersells the reconcile decision), import (that is the CLI verb)

**Purge / compact**: `purgeDeleted` hard-deletes tombstones (and their postings and vectors) and cannot be undone; `compact` VACUUMs the file and reports footprint (db + WAL + shm). Soft delete keeps bytes, so without the pair the file only grows.
_Avoid_: cleanup, vacuum (one is a policy, the other is a command)

**Console**: The one browser UI (`ui/`, built to `dist/src/ui-next`, served at `/`). It is a client of the store, not part of it — distinct from the store, the CLI and the MCP server.
_Avoid_: inspector, dashboard, front-end

**Theme (Vantablack / Paper)**: One token set with two values — Vantablack (dark, the default) and Paper (warm-white light). Anything that hardcodes a colour is a bug.
_Avoid_: dark mode, skin

**Embedding switch**: The non-secret settings file the console writes (`~/.ai-memory/settings.json`) plus the migration and restart that apply it — the provider is never swapped in place, because one process serves one vector space. A real environment variable, `.env` included, beats the file, and the file beats the built-in default.
_Avoid_: hot swap, live provider
