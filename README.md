# Open Memory

**Local-first memory your coding agent can actually trust: one SQLite file, zero dependencies, no LLM call per search — and it out-retrieves the hosted "memory" products on their own benchmark.**

![the console: a query, the floor preset that made seven hits appear, the token budget,
and the score decomposition behind every hit](docs/images/console-recall-dark.png)

> **Status: `0.4.0-beta.2`** — pre-release. The storage format is settled; the HTTP and MCP surfaces
> can still move between prereleases.

Agent memory is usually a vector database you babysit or a cloud you don't trust with your history.
Open Memory is a single `memory.db` file (`node:sqlite`, WAL) that stores episodic, semantic, procedural
and working memories and gets them back with hybrid **smart search** under a **hard token budget** — no
*Token Burning* (cost), no *Context Burning* (dilution). It doesn't just hand back matches; it can show the
exact score that earned every one.

The proof, on one harness and one pinned reader/judge (LoCoMo `conv-26`, 152 questions):
**open-memory 69.1% vs OpenViking 39.5% vs mem0 OSS 14.5%** — a judge-free string-hit audit agrees
(35.3%) and the paired difference is significant (McNemar p=0.0003). Warm searches land in **~9 ms**, and
it holds **80 req/s with zero dropped requests** while another agent writes underneath. One process, no
Docker, and your history never leaves the machine.

- **Embedded DB**: SQLite via `node:sqlite` (`memory.db` single file, WAL), no Docker. `VectorStore` interface swappable to Qdrant/Chroma (ADR-0001).
- **Smart Search**: 2-stage — candidates are the **union** of the vector top-k and the term index (so an exact-word match competes even when its cosine is poor), scored `0.6*BM25 + 0.25*recency + 0.15*strength` (`vector` weight is `0` by default; see Embeddings), BM25 with real `df`/`avgLen` → MMR diversify → relevance floor `0.72` (empty allowed, and it is a floor on *relevance*, not on the total — an old exact match must never age out of reach) → **hard budget** (default 800 tokens) + projection into the leftover + overflow summary (ADR-0002, ADR-0012, ADR-0014). Deterministic, zero extra LLM call.
- **Hard Budget**: Every `search` returns `{memories, tokensUsed, truncated, summary}`. UI shows `420/800` bar.
- **Explainable recall** (R1): `?explain=1` (or `--explain`) returns where each score came from — `bm25 +0.37 · recency +0.24 · strength +0.12 = 0.737`. Off by default, because four extra numbers per hit is real payload on a response whose point is a token budget. Everyone returns results; this returns *why*.
- **Retrieval reinforcement** (R2): a memory that keeps getting retrieved gets stronger (`strength +0.02`, capped 0.95), its clock resets, and its `use_count` ticks up — so decay reads age as time-since-last-use and staleness as a *hotness* of count against age, not a used-once-never-again flag. `importance` stays the judge's write-time number; `strength` is what use has proven. No model call, no cost, and the store gets better the more it is used.
- **Project memory** (ADR-0020/0021/0022): every write carries a `project` (resolved from the git root, or `MEMORY_PROJECT`) and a `kind` — `decision`, `convention`, `gotcha` are *durable* and decay never archives them, `task` lives a week, `note` a month. `memory_brief` / `ai-memory brief` prints the whole project's standing memory in a fixed order (conventions → decisions → gotchas → open → recent) inside 600 tokens, without a query and without an LLM call. Projects are managed on the same dimension — `ai-memory project list | init | rename | forget` ([ADR-0042](docs/adr/0042-project-management-rides-the-dimension.md)).
- **Knowledge pages** (ADR-0023): markdown in `vault/` is indexed section by section — the file stays the truth, one row per heading (`knowledge sync` is idempotent: unchanged files write and embed nothing), and `[[links]]` are stored beside the rows as `knowledge_links` with dangling targets kept as null. `memory_knowledge`, `/knowledge` and `ai-memory knowledge` read the index; `neighbors` walks links explicitly, never implicitly.
- **Console** (`ui/`, built to `dist/src/ui-next`, served at `/`): the one browser UI over the API below — Recall, Memories, Sessions, Graph, Stats — in two themes (dark default, warm-white light). The old inspector is gone.
- **Vault graph** (`/graph.html`): Obsidian-style node graph over `vault/` — any markdown you point `VAULT_DIR` at. Edges come from `[[wikilinks]]` in the body plus the frontmatter `links:` that ingest writes — nothing is inferred, so the graph never lies about intent. Click a node for the local graph (depth 1-3), filter with `tag:x` / `path:x` / substring, colour by folder, drag nodes; positions persist to `vault/.positions.json`. Dangling and ambiguous links render as hollow nodes — hiding them would hide the maintenance debt.
- **CLI** (`ai-memory`): every subcommand works non-interactively, because hooks call it. Uses the daemon when one answers, otherwise opens the store in-process.
- **MCP server** (`src/mcp/tools.ts`): `memory_*` tools, every one accepting an explicit `scope` (`memory_knowledge` adds the vault index).
- **Wire it in** ([docs/integrations.md](docs/integrations.md)): one command for the agents it knows, and `agent add` for any other MCP client — no code.
- **Zero runtime dependencies.** `node:http`, `node:sqlite`, `node:crypto`. Dev-only: tsx, typescript, vitest.

## Quick start

**Requires Node 22+** — `node:sqlite` is still flagged experimental (Node 24 is what this is developed against).

**Platforms:** developed and used on Windows, and verified on Linux by CI, which installs
the packed tarball on a clean Ubuntu runner and exercises the CLI, the daemon and the
console there. **macOS is untested** — reports welcome.

```bash
npm i -g @franklinww/open-memory    # the package; the command is still `ai-memory`
ai-memory db info       # where the store lives, and why
ai-memory save "user prefers dark mode" --type semantic
ai-memory search "dark mode" --explain
```

Then hand it to your agent — one command, dry run until `--write`:

```bash
ai-memory agent link --write   # register with every coding agent detected on this machine
ai-memory agent doctor         # what it wrote, and whether it can work
```

Don't feel like typing it? **Copy this whole block and paste it into your agent** — it will
install, wire itself in, and prove it works:

```text
Set up Open Memory (local-first agent memory) on this machine for me:

1. Install it globally: `npm i -g @franklinww/open-memory` (the command is `ai-memory`; needs Node 22+).
2. Wire it into every coding agent it detects, then verify what it wrote:
   - `ai-memory agent link --write`
   - `ai-memory agent doctor`
3. Prove it works end to end:
   - `ai-memory save "user prefers dark mode" --type semantic`
   - `ai-memory search "dark mode" --explain`

It writes to a local SQLite file at ~/.ai-memory/memory.db — no Docker, and the default embedder
needs no API key. If `ai-memory` is already on PATH, skip step 1. Finish by showing me the output
of `ai-memory agent doctor` and the search.
```

Claude Code, Codex, DeepSeek Harness and pi are known by name. Any other MCP client is
one command away with no code: `ai-memory agent add cursor --mcp-file ~/.cursor/mcp.json`.
Full table, flags and the three mechanisms: [docs/integrations.md](docs/integrations.md).

From source, if you want the UI and the full suite:

```bash
git clone <repo> && cd ai-memory
npm ci
npm run seed     # 8 demo memories into the store the server reads
npm start        # API on http://127.0.0.1:3000  (PORT / HOST override; the console needs a build — see Console)
```

Dev with reload: `npm run dev`. Then open **http://127.0.0.1:3000**.

### Console

One UI, served by the same `node:http` process as the API, **at `/`**. `/app` still answers, kept for old deep links; the inspector is gone. Nothing is fetched from a CDN, so it renders fully with the network off.

```bash
npm --prefix ui install     # once
npm run ui:dev              # Vite on 127.0.0.1:5173, proxying the API on :3000
# or the served build at `/`:
npm run ui:build && npm start
```

An unbuilt console answers `/` with the command that builds it — an instruction, not a page.

Installed from npm there is no clone to `npm start` in; the server is the same entry point,
run directly:

```bash
node node_modules/@franklinww/open-memory/dist/src/api/server.js   # PORT / HOST / MEMORY_DB_PATH
```

`PORT` is read by the server **and** by the CLI's daemon probe, so a process that answers
`/health` on that port and is not this server (another app on `:3000`, say) makes every CLI
command report a confusing parse error instead of falling back to the in-process store. Point
`AI_MEMORY_SERVER` at the real daemon, or move it off `PORT`'s default.

![the same view in the light theme](docs/images/console-recall-light.png)

Six views:

- **Recall** — search, the per-hit score decomposition, and the token budget bar with its `truncated` badge and overflow summary. The `0.72` / `0.35` / `0.2` floors are preset buttons, so the same query visibly goes from zero hits to several.
- **Memories** — list, filters, a detail drawer, the supersede chain in both directions, and create / pin / status / supersede / soft-delete / restore.
- **Sessions** — a read-only timeline of pi's own `.jsonl` session files, with the memory tool calls marked.
- **Graph** — frames `/graph.html`, read-only over `vault/`.
- **Stats** — the `?full=1` numbers, histograms, the decay candidates and what a decay would prune, plus the `Embeddings` card that switches the provider.
- **Settings** — the provider keys, the judge's endpoint, model and floor, and the extractor's switch, written to `settings.json` and shown masked. The embedding settings are not here: they stay in the Stats card, which the page links to.

Two themes — dark (default) and warm-white light — behind an `auto | dark | light` control, `auto` following `prefers-color-scheme`. Keyboard: `/` focus search, `Esc` close drawer, `j`/`k` move selection, `Cmd`/`Ctrl`+`Enter` submit.

One honest limit: there is no token-savings figure, because recall results are not persisted, so the console does not show one.

### Knowledge: markdown pages, indexed

```bash
ai-memory knowledge sync --dir ./vault          # .md pages -> section rows + links (idempotent)
ai-memory knowledge ls                          # pages, section counts, links, dangling links
ai-memory knowledge show how-tokens-work        # sections + outgoing links + backlinks
ai-memory knowledge neighbors how-tokens-work --depth 2
ai-memory knowledge link alpha beta             # append [[beta]] to alpha.md, then re-sync
npm run wiki:ingest -- ./docs                   # docs -> ./vault/*.md, then the same sync
npm run wiki:links                              # graph: nodes, degrees, dangling links
```

The file is the truth and the row is its index (ADR-0023). `sync` splits each page on `#`/`##`/`###`
headings, derives a stable key from the heading (`how-tokens-work`), and keeps one row per section under
`knowledge_id` + `knowledge_section`. Editing one section updates one row and keeps its id; deleting a
section removes exactly that row; deleting a page soft-deletes its rows and clears its edges. Running
`sync` twice writes nothing and embeds nothing — the second run reports `inserted: 0, embedCalls: 0`.

Links are `[[wiki links]]` in the body or the frontmatter `links:` list, stored in `knowledge_links`
with the unresolved ones kept as `to_id = NULL`. Retrieval never walks them implicitly: a search result
carries its links as metadata, and `neighbors` is an explicit call with a bounded depth (default 1).

Whole documents are still not stored. One 1.5k-char blob is a file, not a memory: it matches on any
word it happens to share with the query and spends half the recall budget printing back a decision
record you could just read. Each row is one section, prefixed with `[page title] heading: `, so a hit
says which page and which part of it answered.

## API

| Method | Path | Body / Query |
|---|---|---|
| `POST` | `/memories` | `{namespace, type, text, project?, kind?, importance?, tags?, source?}` |
| `POST` | `/memories/bulk` | `{items: [...], reconcile?, raw?}` — up to 5000 rows, one transaction and one embed batch; a bad item fails the request with its `index`, and rows the bulk gate rejects or folds skip per row (`skipped`, `skipDetails[]` with input `index` + reason). `raw: true` excuses every reject except `secret` and empty text, and skips demotion — never the duplicate fold |
| `GET` | `/memories?namespace=&type=&q=&includeDeleted=` | list |
| `GET` | `/memories/:id` | |
| `GET` | `/memories/:id?drill=1` | the whole supersede chain + the row's write history: `{memory, ancestors, successors, events}` (nearest ancestor first, breadth-first successors, `memory_events` rows oldest first); a purged id answers `{memory: null, events}` — the history outlives the row ([ADR-0045](docs/adr/0045-write-history-and-two-clocks.md)) |
| `DELETE` | `/memories/:id` | soft-delete |
| `POST` | `/memories/:id/supersede` | `{namespace,type,text,...}` creates new + soft-deletes old via `supersedesId`; one transaction, and the old row's `invalid_at` + the supersede event (reason, judge) are written with it ([ADR-0045](docs/adr/0045-write-history-and-two-clocks.md)) |
| `POST` | `/memories/search` | `{query, namespace, namespaces?, k?, budgetTokens?, threshold?, type?, kind?, project?, explain?}` — `namespaces` is comma-separated and overrides `namespace`; it is how the CLI reads its own partition plus the legacy one. An empty result carries `diagnostics` (`{threshold, partitions:[{namespace,total}], nearMisses, outside?}`) — the key is **absent** when there are matches, so a non-empty response costs no tokens. `outside` lists the same user's partitions this read did not cover but which still hold matching rows, so a miss can say "the answer is one layer over" instead of "nothing was stored" ([ADR-0037](docs/adr/0037-explain-an-empty-search.md), [ADR-0039](docs/adr/0039-an-empty-result-reports-the-partitions-it-did-not-read.md)) |
| `GET`/`POST` | `/brief` | `{project?, namespaces?, budgetTokens?, sinceDays?}` → `{project, text, tokensUsed, budgetTokens, truncated, sections, counts}` — the project's standing memory with no query (ADR-0022) |
| `GET` | `/projects` | `{projects: [{project, rows, byKind, lastActivityAt}]}` — every project, live rows only (`(unscoped)` rides along as `project: null`) |
| `POST` | `/projects` | `{project?, note?}` → 201 `{project, created, rows, memory}` / 200 when it already exists — writes one durable marker row tagged `project:init`, skipped by the brief (ADR-0042) |
| `POST` | `/projects/:slug/rename` | `{to, merge?}` — moves every row (tombstones included) to the new slug; an occupied target is refused until `merge: true` |
| `DELETE` | `/projects/:slug?mode=` | `mode=delete` (default) soft-deletes the project's live rows, restorable; `mode=detach` sets `project = null`; unknown slug → 404 |
| `POST` | `/extract` | `{text, namespace, referenceDate?}` — heuristic (no LLM) or LLM if `ENABLE_EXTRACTOR=true` + `OPENAI_API_KEY`; the shape gate drops tables, bullets, headings, prompt XML and terminator-less slices |
| `POST` | `/decay` | `{archived, pruned, affected}` — archive-first: rows past their kind's window whose hotness `log1p(uses)·exp(−ln2·age/window)` fell under the keep line, with `importance < 0.6`, become `archived`. Deleting only happens in the opt-in hard pass, and the daemon's own `MEMORY_MAINTAIN_HOURS` sweep cannot reach it — the scheduler's entry takes no hard flag ([ADR-0016](docs/adr/0016-archive-first-decay.md)) |
| `POST` | `/compact` | `{bytesBefore, bytesAfter}` — VACUUM and report the file footprint (db + WAL + shm); `501` when the store has no file to rewrite |
| `GET` | `/graph` | wiki node graph: `{nodes, edges}` |
| `GET` | `/knowledge?namespace=` | pages: `{pages, dangling, edges}` (ADR-0023) |
| `GET` | `/knowledge/:id` | `{id, title, project, sections, links, backlinks, dangling}`; `404` for an unknown page |
| `GET` | `/knowledge/:id/neighbors?depth=` | `{id, neighbors}` — explicit link walk, depth 1..3 |
| `POST` | `/knowledge/sync` | `{dir?, dryRun?}` re-reads the vault and reports `{pages, sections, inserted, updated, unchanged, removed, adopted, embedCalls}` |
| `GET`/`POST` | `/positions` | read / write `{slug, x, y}` for the graph canvas |
| `GET` | `/health` | |
| `GET` | `/stats?namespace=` | |
| `PATCH` | `/memories/:id` | `{status?, pin?}` governance |

### Agent wiring (tool-first, ADR-0003)

Wiring an agent that already exists is a CLI command, not this snippet — see
[docs/integrations.md](docs/integrations.md). This section is for an agent you are writing.

```ts
import { MemoryService, createMemoryTool, autoInject } from "@franklinww/open-memory";

const svc = new MemoryService();
await svc.init();

// explicit tool (recommended)
const tool = createMemoryTool(svc);
// Vercel AI SDK: tools: { memory_search: tool }

// helper
const { injected } = await autoInject(svc, messages, { namespace: "agent1:user42", budgetTokens: 800 });
// injected is string to prepend to prompt, or null if no memories above threshold
```

HTTP alternative (any language):

```bash
curl -X POST http://127.0.0.1:3000/memories/search \
  -H "Content-Type: application/json" \
  -d '{"query":"where does user live?","namespace":"default:default","k":5,"budgetTokens":800,"threshold":0.72}'
```

### Retrieval floors

Two defaults, on purpose:

| Caller | Floor | Why |
|---|---|---|
| HTTP / UI (this server) | **0.72** | The ADR-0002 value, unchanged. Cleared by BM25/vector relevance, or by the total for a fresh, important, partially-matching memory. Zero shared terms never qualifies, so context pollution stays out. |
| pi `memory_search` (auto-memory extension) | **0.35** English / **0.2** Chinese | Measured against this corpus, 0.72 discarded real memories: an exact hit scores ~0.96, a reworded one ~0.33. The Chinese floor started below the English one because a Chinese query scored structurally low; since [ADR-0027](docs/adr/0027-cjk-relevance-by-coverage.md) it does not, and the two floors are kept apart only until the corpus has enough real Chinese memories to test the pair. |

This is a deliberate divergence, not drift. The agent is answering questions it was asked; the UI is you deciding what to inject into a prompt. Revisit when the corpus has enough real memories to judge `0.35` on its own.

## Write reconcile

Every save reconciles before it inserts. Since P5 the candidate window is a three-arm
union, deduped and capped at ten: the five nearest memories of the same partition **and
type** — the query the old exact-text dedup already ran — plus the rows sharing the
write's `entity:` facets (P4's `facetCandidates`, any type), plus the same partition with
the type wall down, so a contradiction filed as an event can reach a semantic write.
Reaching is still not admitting: every neighbour clears the same floors as before, and a
facet-sourced row carries `vectorScore = 0`, so it earns its way in on its own words. The
guards below outrank everything the window adds.

| Outcome | When | What happens |
|---|---|---|
| `reinforce` | the same claim, reworded (punctuation and case do not matter; a reordering does) | the existing row gains strength and its use clock resets; nothing is inserted |
| `supersede` | the new memory adds detail, contradicts the old one, or the judge says so | the new row is stored, the old one is soft-deleted and linked by `supersedes_id`, and the old claim is appended as `(previously: …)` when it carried something the new one does not |
| `insert` (`conflict-unjudged`) | the judge is **absent** — not configured or no key — and the surviving pair names one `entity:` subject while stating different claims | a new row, exactly like before — but both rows now carry a `conflict:<entity>` facet, and `/stats?full=1` counts them (`pendingConflicts`) with a **pending conflicts** panel in the console Stats view. The marker moves through the P4-maintained paths only: the new row's tags through the insert, the existing row's through `updateMeta`'s tags patch, so its facet postings follow the column |
| `insert` (`judge-failed`) | the judge was **asked and failed** — the wire returned nothing | a new row tagged `judged:failed`, and the failure counted on stderr; never a conflict marker — a failed call admits nothing about the pair ([ADR-0041 amendment](docs/adr/0041-the-write-gates-judgement-call-goes-to-the-model.md)) |
| `insert` | nothing near enough, or the neighbour is pinned, `episodic`, or written by `extractor` — those four guards answer before the judge or the marker ever could | a new row, exactly like before |

`memory_remember` says which happened: `stored`, `already known`, or
`superseded <oldId>: <newId>`. `MEMORY_RECONCILE=off` restores the old exact-text dedup
byte for byte, and is the rollback.

Knobs, all env-only and read per write: `MEMORY_RECONCILE_LEX` (`0.80`, token overlap),
`MEMORY_RECONCILE_COS` (`0.85`, only when a real embedder is configured — the hash
embedder returns ~0.9 cosine to everything), `MEMORY_RECONCILE_MARGIN` (`0.15`, how far
the top judgement must lead the runner-up before it may delete a row). Tags written by
this path carry facets: `entity:`, `topic:`, `path:` — and, since P5, `conflict:`,
minted only by the marker, never derived from text. All of them are indexed —
`memory_facets`, a posting list committed with the row and kept equal to the row's own
facet tags by construction ([ADR-0046](docs/adr/0046-facet-index-and-third-candidate-arm.md)) —
and `conflict:*` facets are what the pending-conflict count, the console panel and the
`facet:` filter on `list`/`vectorSearch`/`lexicalCandidates` read. A judge that answered
but cleared no label (`MEMORY_RECONCILE_MARGIN` held it back) stores unjudged and
untagged: cautious is not broken ([ADR-0047](docs/adr/0047-conflict-window-and-pending-conflicts.md)).

No benchmark claim is made for this stage: it changes what gets stored, not how multi-hop
is assembled. The read-time stage is a separate change (v0.4, [ADR-0012](docs/adr/0012-candidate-union-over-term-index.md))
and it is the one with a measured number behind it — see [Benchmarks](#benchmarks).
See [ADR-0011](docs/adr/0011-write-time-reconcile-schema-free-facets.md).

## Smart Search details

- **Stage 1**: candidates are the union of `vectorSearch` over the namespace partition (over-fetch `max(20, k*4)`) and `lexicalCandidates` from the term index — so a row whose exact words match competes even when the embedder ranks it outside the vector window. Score is `0.6*BM25 + 0.25*recency + 0.15*strength` (plus vector when a real embedder is configured), BM25 uses real `df`/`avgLen` over the candidate set, then the relevance gate and `score >= threshold` filter (allows empty → prevents context pollution). A row found only by words enters at `vectorScore = 0` and still has to clear both gates.
- **Stage 2**: MMR `lambda=0.6` diversify, sort, then `budgetEnforce` — skips rows that do not fit (it no longer stops at the first big one), then fills what is left by projecting one block to its most query-relevant lines *only when no later block would have fit whole* (the projection can never eat room a whole row needed). Rows that still do not fit become the extractive overflow summary. The result is then capped at `k`; `truncated` reports either cap. `MEMORY_ASSEMBLE=off` returns whole rows only ([ADR-0014](docs/adr/0014-project-into-leftover-budget.md)). A hit that replaced something carries one extra line — `前身(YYYY-MM-DD): ≤80 chars of the predecessor` — inside whatever budget is still unspent: never a pool row, never a `k` slot, the full chain only behind the explicit `?drill=1` / `--history` walk ([ADR-0045](docs/adr/0045-write-history-and-two-clocks.md); adding reachable rows to the pool is the ADR-0028 PRF trade that cost evidence-any 76% → 72%).
- **Tokens**: heuristic `cjkChars + latinChars/4` (CJK counts one token per character — `len/4` under-counted Chinese by 2-3x and budgets overflowed silently); swap to `js-tiktoken` by installing it (auto-detected).

## Embeddings

Default: `HashEmbeddingProvider` — 384-d, deterministic, offline, zero download.

**Be clear about what this is:** a hash embedder is a deterministic bucket of tokens, not a semantic model. It matches on shared vocabulary, not on meaning. It is the right default because it is instant, offline, free and needs no key — but if you expect "vector search" to mean "finds things that mean the same thing", that is the assumption to check.

Two real providers ship with it (ADR-0004), both over the same OpenAI-compatible `/embeddings` endpoint:

```bash
EMBEDDING_PROVIDER=openai  OPENAI_API_KEY=sk-...            # text-embedding-3-small, 1536d
EMBEDDING_PROVIDER=nim     NVIDIA_API_KEY=nvapi-...         # nvidia/nemotron-3-embed-1b, 2048d
EMBEDDING_DIM=1024                                          # for any other model
```

NIM gets the `input_type` (`query` on search, `passage` on save) and `truncate` body fields that E5/Nemotron score on; OpenAI rejects those, so they are sent only for NIM.

**A third path, from the console.** `Embeddings` in the Stats view picks a provider and writes `~/.ai-memory/settings.json`; `Settings` writes the provider keys there too, along with the judge's key and knobs and the extractor's. The file is flat — a setting key is an environment variable name — and only the console's own lists are accepted, so a name the console does not own is refused by name, never written. Precedence is **real environment > that file > built-in default**: an `EMBEDDING_PROVIDER` exported in your shell — or in `.env`, which is a real env value — beats the file, and the card says which of the three is in play (ADR-0010).

**What a save costs depends on the key.** The embedding settings (`EMBEDDING_PROVIDER`, the dim, the model, the base URL) take effect on the **next start** — the running process keeps its embedder (ADR-0009). A key, `MEMORY_JEV` / `MEMORY_JEV_MIN` / `JEV_ENDPOINT` / `JEV_MODEL`, or `ENABLE_EXTRACTOR` / `EXTRACTOR_MODEL` is **live on the next call**: those are read per use, not frozen at boot. The file is created `0600`, which is a POSIX mode — on Windows it is inert and the protection is your profile ACL. A saved key is never sent back in clear: the console shows `…` and its last four characters, and no response or error body carries more.

**If a value already sits in `.env`, the console cannot save over it.** The environment wins the merge, so the save is refused and names where the live value is; `adopt .env` is the way out. Adopt copies the values into `settings.json` first, then comments their `.env` lines out — never deletes them, never reorders the file — with `.env.bak` written once beforehand, so the pre-edit copy survives every later adopt. A line whose value cannot be read back exactly (a backslash the loader would expand, unusual quoting) is left in `.env` untouched and reported instead, because commenting it out would make a wrong `settings.json` the only copy.

The order is fixed: **write → dry run → migrate → restart.** Neither middle step is optional. A restart right after a write is refused by the startup guard, which names both dims — that is the guard working, not a crash. And migrating without restarting is the worse state: every row is at the new width while the running process still embeds at the old one, so searches return nothing until it restarts. The card counts the rows the running provider cannot read for exactly that reason, and says `restart now to restore search` when the migration ends. `ai-memory daemon restart` performs that last step: it probes `/health`, asks the daemon to shut down, waits for the port to stop answering, starts a replacement, and only says `daemon restarted` once the replacement answers `/health`.

**Measured on this corpus** (53 live rows, `nvidia/nemotron-3-embed-1b` via NIM, 2026-10-06). Three memories, each asked twice — once in its own words, once paraphrased with no shared vocabulary — and scored by where the right memory lands in the whole store:

| query | hash (384d) | nemotron (2048d) |
|---|---|---|
| literal | rank 1 / 2 / 6 of 53 | rank 1 / 1 / 1 of 53 |
| **paraphrased** | rank **13 / 21 / 9** of 53 | rank **1 / 1 / 2** of 53 |

That is the claim, confirmed in the direction that matters: a reworded query puts the right memory first with a real model, and mid-pack — effectively at random — with the hash embedder.

**What absolute cosine cannot do is gate.** On the same corpus the noise ceiling (highest cosine for three unrelated queries) was 0.12–0.26, while the paraphrases that *should* match scored 0.20–0.30 — overlapping ranges, so any absolute floor either admits the kubernetes query or drops a paraphrase. A *relative* test separates them: the noise never beat its partition's median cosine by more than 0.176, four of six paraphrases beat it by 0.231–0.345. So a memory with no shared words is admitted when it is the partition's best vector hit *and* leads that median by `MEMORY_SEMANTIC_MARGIN` (default `0.2`, the midpoint of those two measured numbers). End to end at the production floor of `0.72`: the four paraphrases above went from **0/4 hits with the hash embedder to 3/4 with nemotron**, while the unrelated query still returns nothing. The one miss is a memory the model ranked 2nd — a ranking failure the gate is not responsible for. The hash default is untouched: vector weight is `0` there, so no cosine can ever admit anything.

**The dimension is load-bearing.** The vector column holds raw JSON, so a provider swap without clearing the store makes every search return noise rather than an error. Startup therefore refuses on a mismatch and names both dims:

```
embedding dim mismatch: /home/you/.ai-memory/memory.db holds 384-dim vectors,
but the openai embedder produces 1536.
```

`ai-memory reembed` rewrites every stored vector with the current provider, and the mismatch error above names it:

```bash
EMBEDDING_PROVIDER=openai OPENAI_API_KEY=sk-... ai-memory reembed   # rewrite in place
ai-memory reembed --dry-run                                        # count first, write nothing
```

It covers archived, draft and soft-deleted rows too, so a later `restore` cannot hand the retriever a vector of the wrong width; a row left stale by an interrupted run is skipped by search rather than crashing it. `reembed` reads the same merged environment the console writes to — a real variable or `settings.json` — so the CLI and the console's migrate agree on which provider they are migrating to. `mv memory.db memory.db.bak` remains the start-fresh option.

The vector weight follows the embedder: `0.6` when a real provider is configured, `0` for hash (which returns ~0.9 cosine to everything, so the term would be noise). `MEMORY_VECTOR_WEIGHT` overrides either. A configured embedder that contributed nothing to ranking would cost a network hop per save and buy nothing — which is why this is not a number you have to discover.

## Retrieval

Score = `0.6*bm25 + 0.25*recency + 0.15*strength` (`vector` weight 0 by default — see below), plus `+0.3` for a pinned memory. Candidates come from **both** the vector top-`max(20, k*4)` and the term index (`memory_terms`, via `lexicalCandidates`): until v0.4 BM25 only re-ranked what the embedder had already chosen, so a row holding the query verbatim was invisible whenever its cosine fell outside the window — measured at 32.5% of known targets, which made recall@5 exactly P(target in the vector top-20) ([ADR-0012](docs/adr/0012-candidate-union-over-term-index.md)). Relevance gates first: a memory with no lexical overlap and no vector signal is not a match, it is just a recent important one, and recency+strength alone would clear the threshold on every row.

**`strength` vs `importance`.** `importance` is what the write-time judge thought (see "Smart write gate"). `strength` is what use has proven — it starts equal to `importance` and grows on retrieval. They are separate fields on purpose: if reinforcement wrote `importance`, then "the model thought this mattered" and "this keeps answering questions" would compete for one number and neither would be true. Ranking reads `strength`; the judge owns `importance`; decay prunes a row only when **both** are at or below the threshold (`importance <= x AND strength <= x`), so "this keeps answering questions" protects a row from a low write-time score ([ADR-0013](docs/adr/0013-honest-k-budget-and-decay.md)).

**`MEMORY_VECTOR_WEIGHT`** defaults to `0.6` once a real embedder is configured and `0` for hash: the hash provider returns ~0.9 cosine to everything, so the vector term would be noise, and with it lexical overlap is the only relevance signal that exists. Set the variable to override either way.

**Relevance is ordered by coverage.** The score above decides *whether* a row is relevant; it cannot always decide *which* of two relevant rows was asked for. In Chinese the filler shares the question's subject matter rather than its function words — nine rows in a partition say 「项目 <project> 的约定」, so those words look important to BM25 and the row holding the marker scores 0.008 above the noise. So each candidate also gets a `coverage` — the share of the query's own words it holds, counting a matched two-character word once — and that value leads the sort, feeds the relevance gate (a row holding three quarters of the words is relevant whatever its score), and is the relevance term MMR and the token budget see ([ADR-0027](docs/adr/0027-cjk-relevance-by-coverage.md)). On the real-time bench this took Chinese recall@5 from 0.65 to 1.00 with the English shapes unchanged.

**Coverage counts matched words, but weights them by rarity (ADR-0028).** For a corpus that is one ongoing conversation, coverage-as-a-count is backwards the other way: "What is Caroline's identity?" asks `{caroline, identity}`, and `caroline` sits in almost every chunk while the row that answers it says "transgender woman" — so half the store scores the same coverage as the answer and the ordering falls back on age and use. So the *sort* uses a df-weighted coverage (each asked word worth `log(1 + maxDf/df)` from `term_df`), while the *gate* still reads the unweighted share — a row holding one rare word would reach a weighted 1.0, and three-quarters-of-what-was-asked is the meaning the gate must keep. A second pass that expands on the top hits' shared terms (pseudo-relevance feedback) was built for the multi-hop remainder and **measured net-negative** — the merged rows crowd a fixed 800-token budget single-hop rows need (evidence-any 76 → 72%) — so it ships behind `MEMORY_PRF=on`, off by default, like the int8 shortlist. Measured on the model-free evidence ruler over all 152 LoCoMo questions, the weighted ranking plus a 1000-char chunk took evidence-all 57 → 66% and the honest current-tree LoCoMo accuracy 50.7 → 69.1% (same pinned reader).

**A third candidate arm joins rows by their facets — measured null, off by default.** Every write already carries facet tags (`entity:` / `topic:` / `path:`, ADR-0011); P4 turned them into a real index — `memory_facets(facet, memory_id, namespace)`, a posting list maintained in the same transaction as the term postings on every path that can move facets (insert, bulk insert, supersede, a tags relabel, a rewrite), with a startup anti-join that self-heals rows missing postings (chunked past the zero-facet rows that would otherwise shadow an injured row forever) and an invariant test pinning *facet postings == the row's facet tags* ([ADR-0046](docs/adr/0046-facet-index-and-third-candidate-arm.md)). The store capability `facetCandidates` answers "same entity, this partition" whether or not any search flag is on — that seam is what P5's conflict window consumes. Retrieval itself reads it only behind `MEMORY_LINKS=on` (default **off**): the query goes through the same `deriveFacets`, the joined rows enter the pool with `vectorScore = 0` and must clear the same relevance gate as everyone else (no free channel), and the `entity` term in `explain` defaults to weight 0 — visible, never felt. Measured on the evidence ruler, one variable: evALL/evANY **66/77 both ways**, cat1 multi-hop unchanged at 13/56 — 143 of 152 LoCoMo questions derive zero facets (the derivation is deliberately narrow, ADR-0011), and of the 102 rows the arm did propose, 72 were already in the pool and 29 were gate-dropped; on the controlled comparison — one store, one ingest, only the flag flipped — **no question's final five blocks change** (the two fresh-ingest runs' per-question diffs are tie noise that A/B cannot isolate). A null is not a negative: the flag stays, the index stays (P5 needs the store half), and the knob is there for a corpus whose questions name things the way the derivation expects. [ADR-0046](docs/adr/0046-facet-index-and-third-candidate-arm.md)

**An empty result explains itself.** "No memories matched" was one sentence for three different situations — the partition is empty, the caller is looking at the wrong partition, and the rows are there but the wording missed the gate — and the only move it teaches an agent is to reword and retry, which cannot work for the first two. One measured session spent 14 tool calls on a single question and the first 6 were reworded retries. An empty `SearchResult` now carries `diagnostics`: the threshold, the row count per searched partition, and the nearest misses that were rejected. The rendering lives in one place (`renderEmptySearch`), so the CLI, the MCP server (both the in-process and the daemon path) and the pi extension print the same explanation, and the last line is the one that ends the loop — `nothing was stored for this scope`, `rows exist but none shared a term with this query: different words, not a lower threshold`, or `rows exist but none matched: retry with threshold 0.52`. Three tails because there are three different next moves; the middle one exists because a query sharing no term with any of 363 rows still used to be told to lower a threshold that never ran. The first line stays `no memories matched` so callers that grep for it keep working, and a daemon built before this change still answers without the key, in which case every renderer falls back to the old one-liner ([ADR-0037](docs/adr/0037-explain-an-empty-search.md)).

**An empty result also says what it did not read.** A read covers the caller's own agent layer, the shared layer and `default:default` — and nothing else, which is the point of per-agent layers. The cost of that isolation is a sentence like "nothing was stored for this scope" being true and misleading at once: on this store `pi:frank` held 0 rows while `coding-agent:frank` held 4, one of them `The user lives in Tokyo.`, and a `pi` session asking for Tokyo got an empty result with no hint that the fact existed one layer over. `diagnostics.outside` now lists the same user's partitions the read did not cover and which still hold rows matching the same filters, so the message reads `outside this scope: coding-agent:frank (1 rows)` and the tail becomes `nothing was stored in this scope, but 2 rows exist outside it: widen the scope to include them`. That tail outranks the other three, because "never recorded" is the wrong conclusion and the one a caller acts on. Nothing becomes readable that was not readable before — `outside` names the door, `scope:"all"` or `agent:"..."` is still what opens it ([ADR-0039](docs/adr/0039-an-empty-result-reports-the-partitions-it-did-not-read.md)).

## Benchmarks

![LoCoMo conv-26: accuracy, context fed per question, retrieval latency, reader and judge input
 tokens, and ingest time for open-memory, OpenViking 0.4.23 and mem0 OSS 2.2.1](docs/images/locomo-memory-shootout.png)

Three memory systems, one reading model, one set of questions: LoCoMo `conv-26`, 152 questions
(the adversarial category 5 excluded, as OpenViking's own harness excludes it), the same pinned
answering model and the same embeddings everywhere. open-memory answers **50.7%** of them against
**39.5%** for OpenViking 0.4.23 and **14.5%** for mem0 OSS 2.2.1, while feeding each question
2,588 characters of context (OpenViking 17,701, mem0 748 — the trade that makes mem0 cheap and
least accurate) and ingesting the conversation in **15.1 s** instead of 140 s or ~2.5 h. The chart
carries retrieval latency and reader tokens as well; each bar has its own axis and unit.

The ordering is not an artifact of the LLM judge: a model-free string-hit audit agrees with it
(19.7% / 10.5% / 3.3%), every row has non-empty retrieved context, and the paired comparisons are
significant (open-memory vs OpenViking 37/20, p=0.033; vs mem0 62/7, p<0.001). A re-run of the
open-memory arm alone on the current tree reaches **69.1%** on the same pinned reader — see
[v0.5 re-run](#v05-re-run--the-current-tree-measured-honestly).

Read it with the caveats, which matter more than the bars:

- **One conversation, 152 questions.** Enough for this ordering to be significant; not a full
  LoCoMo result.
- **The answering model judges itself.** Symmetric across the three systems, and still a bias.
- **These are not the vendors' published numbers.** OpenViking reports 80-83% with a different
  reader; the mem0 figure here is what this harness reproduced, not what mem0 claims. Compare
  inside the table, never against their READMEs.
- The per-question rows and the harness that produced them are not published yet.

### v0.5 re-run — the current tree measured honestly

The v0.4 figure this section replaces was **59.2%**, and an audit found it cannot stand as a
measurement of v0.4: it posted to a long-lived daemon started *before* the v0.4 retrieval work landed —
its store (`bench/om-v04.db`) still carried the old JSON-vector schema with no `memory_vectors` table
and a leftover smoke-test row. So no honest number for the current tree existed until now. The reader
was never the problem (50.7%, 59.2% and 69.1% all used the same pinned `vyceai/deepseek-v4.1`); the
measured *binary* was.

Re-ran the open-memory arm alone on 2026-11-04 against the same 152 questions, the same pinned reader
and judge, a **fresh store built by the current tree** with NIM 2048-d embeddings and the ~1000-char
chunk [ADR-0028](docs/adr/0028-idf-weighted-coverage-and-prf.md) measured (the evidence ruler finds 800–1000
statistically tied and clearly ahead of 600 and 1200; `bench/results/om-v05.json`):

| | v0.3 | v0.5 | Δ |
|---|---|---|---|
| Accuracy (LLM judge) | 50.7% (77/152) | **69.1% (105/152)** | +18.4 pp |
| multi-hop (n=32) | 38% | 34% | −3.1 pp |
| temporal (n=37) | 35% | **81%** | +46 pp |
| open-domain (n=13) | 46% | 46% | — |
| single-hop (n=70) | 66% | **83%** | +17 pp |
| Model-free string hit | 20.0% | **35.3%** | +15.3 pp |
| Context per question | 2,526 chars | 3,102 chars | +23% |
| Memory tokens per question | 648 | 777 (of 800) | +20% |
| Ingest | 15.1 s | 33.4 s (85 chunks) | — |
| Retrieval mean | 585 ms | 822 ms | +237 ms |

Per question, 43 answers became correct and 15 became wrong (McNemar **p=0.0003**), so this is not a
shift in the judge's mood: the **judge-free string hit moves the same way** (20.0 → 35.3%), and the two
categories the change targets — temporal (a smaller, header-bearing chunk keeps the date near the top)
and single-hop (whole rows that fit the budget) — jump, exactly as [ADR-0028](docs/adr/0028-idf-weighted-coverage-and-prf.md)'s
model-free evidence ruler predicted (evidence-all 57 → 66%, evidence-any 68 → 76%).

Two categories did not move and are reported as-is, not smoothed: **multi-hop is still the frontier**
(34%; its evidence reaches the context only 13% of the time, and the PRF second pass that was built to
close it measured net-negative on a fixed budget and ships off by default), and open-domain is flat at
46%. Retrieval mean rose 585 → 822 ms because the second lexical arm and the weighted coverage now run
per query; it is still under the 700 ms-class budget for the store this is sized for and the real-time
gate holds at recall@5 1.00 ([docs/realtime-bench.md](docs/realtime-bench.md)).

On one harness, same reader, same embeddings: open-memory **69.1%** vs OpenViking **39.5%** vs mem0
OSS **14.5%** — the gap is no longer a single contested re-run but a judge-independent, significance-
tested current-tree number.

### Real-time — what it does while it is being used

Accuracy and size are measured with a quiet process. The third harness measures the case that is
actually normal — an agent searching while another is writing — **open loop** at a fixed request
rate, so queueing shows up instead of hiding behind a polite `await` ([ADR-0024](docs/adr/0024-realtime-benchmark.md),
[docs/realtime-bench.md](docs/realtime-bench.md)).

| offered | achieved | dropped | search p50 / p95 | recall@5 |
|---|---|---|---|---|
| 20 req/s | 20.1 | 0 | 10 / 17 ms | 0.944 |
| 40 req/s | 40.1 | 0 | 10 / 14 ms | 0.922 |
| 60 req/s | 60.1 | 0 | 9 / 14 ms | 0.922 |
| 80 req/s | 80.0 | 0 | 10 / 28 ms | 0.918 |
| 100 req/s | 96.4 | **222** | **126 / 312 ms** | 0.906 |

One core, hash/384d, 800 seeded facts + 12 vault pages, knowledge sync every 5 s, 20-60 s per row.
The knee is between 80 and 100 req/s: up to 80 the worst stall is 338 ms with zero errors and zero
drops; at 100 the offer exceeds capacity, writes degrade first (p50 3 → 52 ms) and searches pay in
queue time. Recall on the *original* facts stays flat while 1,000+ rows are inserted underneath,
i.e. the candidate union absorbs churn instead of displacing old answers. The knowledge index no
longer grows with the partition: it reads the page rows rather than listing the partition
([ADR-0030](docs/adr/0030-knowledge-index-reads-pages-not-partitions.md)), which took `knowledge`
p50 from 388 ms to 8.5 ms on a partition of 21,000 rows holding a 200-page vault.

Recall is reported per query shape because pooling hides the script: bare markers 100%, English
wording 97%, Chinese wording **71%** — the default hash embedder tokenises Latin only, which is why
every number above names its embedder (`--embedder nim` reruns the same harness on real vectors).

```bash
node scripts/realtime-bench.mjs --duration 60 --rate 60 --assert   # gates: drops, p95, per-mode recall, budget
```


## Smart write gate

Extraction is three stages, cheapest first.

**1. Shape gate** (*isNonMemoryShape*) — the half of the gate that cannot be fooled by good wording. A markdown table row, a list bullet, a heading, a *skill* wrapper, a fenced block or a *Session 3:* fixture header is not a fact however well it reads, and neither is a slice shorter than 40 characters with no sentence end (the one exception: a first-person fact like "I live in Berlin", because chat turns drop the period exactly there). Measured against a hand-classified copy of a real store: **165/180 junk rows rejected (91.7%) versus 5/180 before**, with 5 false kills in 335 rows ([ADR-0015](docs/adr/0015-shape-gate-and-dated-context.md)).

**2. Heuristic rules** (`Extractor.isWorthKeeping`) — free, deterministic, and wrong in one specific direction. "Run the tests before commit" is throwaway task scaffolding in one repo and a durable routine in another. No regex settles that, and both answers are defensible.

**Dates are resolved while the turn is still around.** `extract(text, referenceDate)` turns "yesterday" into `(at:2026-10-18)` — in the text, because that is what the term index and `LIKE` search — so a memory about time stays true after the reader has moved on. `POST /extract` takes `referenceDate` for replayed turns.

**3. Jev judge** (optional, `src/core/judgment/judge.ts`) — one `noul` per sentence that survived the two stages above, asking whether it will still be useful to an assistant weeks from now. The result is a probability, so a borderline memory is stored *weak* instead of being either certainly kept or certainly dropped:

```
keep 1.0 -> importance 0.90      keep 0.5 -> importance 0.65      keep 0.0 -> importance 0.40
```

`importanceFor()` is deliberately monotonic in confidence: decay then keeps what the judge was sure about and lets the shaky ones sink. Memories that went through it are tagged `judged:jev`.

**4. Curation** (`src/core/write/curation.ts`, [ADR-0040](docs/adr/0040-writes-are-curated.md)) — the verdict every write passes through in `saveDetailed`, before the embed: does this deserve to exist at all? The shape gate polices only the extractor's slices; the audited store's junk came in through every other door — the un-gated LLM extract pass, and explicit saves. Curation closes all of them with nine named classes, bilingual, zero model calls: **secrets** (vendor key shapes, `Bearer`/JWT, keyword assignments — refused on every path; the one class where a false kill is preferred), **table rows**, **colon headers** (a heading whose content went to the next line), **phatic filler** (Mem0 answers `Hi.` with no facts; so does the lexicon), **conversational repairs** (`我没说过我在 pi-desktop` — a correction without a replacement fact is conversation management), **code lines**, **prompt fragments** (`Task: TOOLBOX: your real tools are…`), and two weak classes — **progress narration** (`我刚做的:`, `Plan 已更新`) and **self-narration** (`I can only work with local files`) — which a caller may still store, demoted to `note` 0.35 with a `curation:*` tag.

A rejection is a verdict with one next move, never a bare no: the API answers `422 {error, curation}`, `memory_remember` returns `not stored (conversational): a correction without a replacement fact … — store the fact itself`, the CLI prints the advice and exits 1. `MEMORY_CURATE=off` restores the un-gated store per process. Measured by replaying all 515 rows of the audited store through the verdict: **68 rejected (13.2%), zero kills on the clean fixture set** ([ADR-0040](docs/adr/0040-writes-are-curated.md)).

**5. Write gate** (`jevWriteGate`, [ADR-0041](docs/adr/0041-the-write-gates-judgement-call-goes-to-the-model.md)) — the second LLM gate: the judgement call no regex settles, asked of the model for every write that survives curation. Curation's structural rules pass a config dump with no pipes and no colons; this gate asks two questions in one request — `keep` (the extractor's own durability question, now aimed at writes the extractor never saw) and `scaffold` (is this the agent's own instruction scaffolding or a session narration rather than knowledge about the world?). Below the floor (`MEMORY_WRITE_GATE_MIN`, default 0.5) an extractor-sourced write is refused as `low-value`; an explicit write is demoted, never refused — unless the caller named a kind or an importance, in which case the row stores as asked with a `judged:write-gate` tag, because the caller's own judgement wins. A clean verdict prices the derived importance (`importanceFor(keep)`, the extractor judge's mapping). Same endpoint and key as the jev judge, `MEMORY_WRITE_GATE=false` turns it off alone, and fail-open holds: no answer stores the write unjudged. Rows the extractor's jev already priced (`judged:jev`) never ask twice.

Below `MEMORY_JEV_MIN` (default 0.5) the sentence is dropped. **Fail-open**: no key, a 401, or the API being down means the memory is stored *unjudged* rather than lost. A store that silently stops recording because a judge API is down is worse than one that occasionally keeps a mediocre fact.

```bash
# in the environment (.env or an export):
JEV_API_KEY=ts-...                    # or JEV_API_KEY_FILE=~/.typesafe-key
MEMORY_JEV_MIN=0.5
MEMORY_JEV=false                      # turn it off, heuristic only
```

**Or in the console.** `Settings` has a field for `JEV_API_KEY` and for the four judge knobs, saved to `~/.ai-memory/settings.json` — live on the next memory, no restart, because the judge reads its key and its knobs per call. That is also the form that keeps `.env` shareable without a second file. The path form still works and is still the right one if you would rather the key live nowhere it could be pasted by accident:

```bash
echo -n 'ts-...' > ~/.typesafe-key && chmod 600 ~/.typesafe-key
# then, in .env:
JEV_API_KEY_FILE=~/.typesafe-key       # a path, so .env stays shareable
```

`JEV_API_KEY_FILE` and `TYPESAFE_API_KEY` stay environment-only: the console reports them, it never writes them. A key set directly wins over the path, whichever layer it arrives from, and the real environment wins over `settings.json` (ADR-0010).

Judge confidence outranks the regex importance: Jev read the whole sentence, the pattern only saw a verb. With no key configured, behavior is byte-identical to v0.2.0.

## Lifecycle

A store that only grows is not a memory, it is a log. Two passes share the same age clock (`COALESCE(lastUsedAt, createdAt)`) — recalling a memory resets it — and both refuse a row that is still earning its place:

- **Archive (default).** `runDecay(store)` demotes rows that have gone *cold* to `status = archived`: past their kind's window (`task` 7 days, `note` 30, `fact` 90 — the window doubles as the decay half-life, no new global constant), with judge-rated `importance` under `0.6`, and a hotness `log1p(use_count) × exp(−ln2 · age / window)` below the keep line of one use one window ago. The counter is what replaced the old binary flag: `lastUsedAt !== null` used to mean *immortal*, which made one retrieval forever ago indistinguishable from one yesterday's-worth of uses; `reinforce` now ticks `use_count` on both stores. The durable kinds (`decision`, `convention`, `gotcha`) are still never archived at all — only supersede or an explicit forget removes them ([ADR-0021](docs/adr/0021-kind-decides-retention.md)), and the `importance < 0.6` floor survives the swap: a row the judge rated highly is never demoted by the clock alone. Archived rows are hidden from search but still readable through `includeArchived`, so this is reversible, and re-running it is a no-op. The measured number belongs to the rule it was measured under: on a copy of a real 299-row store the *stricter binary rule* archived 2 rows and pruned nothing in October 2026 — a stale `current task:` note and a procedure for a UI that no longer exists ([ADR-0016](docs/adr/0016-archive-first-decay.md)). The hotness rule's set is a superset — every never-used row it demoted, judged the same way at the same window, plus the rows that were retrieved once and forgotten since — and the new rule's number on that store copy has not been re-measured yet.
- **Hard prune (opt-in).** `runDecay(store, { hard: true })` keeps the historical windows (episodic > 90d, working > 7d) and soft-deletes only when **both** `importance` and `strength` are at or below `0.5`. The floor moved 0.3 → 0.5 because the old rule could never fire: strength starts at importance, bottoms out at 0.4 in the real store, and only grows.
- **Automatic maintenance (`MEMORY_MAINTAIN_HOURS`, default 24, `0` off).** The daemon — the server main entry, which is what `ai-memory daemon` runs — sweeps the reversible pass on that interval. Its entry point `runScheduledDecay(store)` takes no options bag at all, so the hard pass is unreachable from the scheduler *by signature*, not by convention: an unattended run can only ever archive. `last_maintenance_at` and the pass's result live in a small `store_meta` KV, so opening an overdue store (a daemon that was down for a week) fires a catch-up pass in the background — no request waits on a sweep — and every pass logs `ai-memory maintenance: archived N cold rows` to stderr ([ADR-0016 amendment](docs/adr/0016-archive-first-decay.md)).
- **Retroactive curation (`ai-memory triage`, diff first).** Decay handles rows that went cold; it does nothing for the junk admitted before the gates existed — 89% of the audited store had never been retrieved, and ADR-0040 originally refused to rewrite the stock. That decision was reversed on 2026-11-08 ([ADR-0040 amendment](docs/adr/0040-writes-are-curated.md)): `ai-memory triage` sweeps the whole store — every partition, archived rows and tombstones included — and runs the same zero-network `curate` verdict per row. The default run **writes nothing**: it reports `would archive N / would demote N / merge candidates M` with ids, classes and reasons, and `--apply` is the only mode that touches rows. Applying archives the hard junk classes by a status flip (never a hard delete — the row stays readable and restorable) and sinks the weak classes (`progress`, self-narration) to importance 0.35, the write-time demotion floor. The contracts outrank the regexes: durable kinds (`decision`/`convention`/`gotcha`), pinned rows, drafts, knowledge rows and tombstones are never touched; live rows sharing an `entity:*` facet and the same normalized text are **listed** as merge candidates and never merged — picking a survivor is reconcile's guarded decision (ADR-0015). Rows carrying no `judged:*` tag are counted (`unjudged`) but not tagged — whether that becomes one is ADR-0041's pending amendment.

`memory_stats` (and the console's Stats view) reports `archived`, `archivedRatio`, `neverRetrieved` and `neverRetrievedRatio`; the decay preview lists each candidate with the action it would take and its retrieval count, and the panel says when the automatic pass last ran and what it did. Since P5 it also reports `pendingConflicts` — live rows wearing a `conflict:<entity>` facet from a write whose judge was absent, listed with their pairs in the Stats view's pending-conflicts panel ([ADR-0047](docs/adr/0047-conflict-window-and-pending-conflicts.md)). Before v0.4 the store had 308 of 335 rows never retrieved and a decay rule that pruned one row in its whole history ([ADR-0016](docs/adr/0016-archive-first-decay.md)).

Seeding is isolated: `npm run seed` writes to a fresh temp directory unless `MEMORY_DB_PATH` is set explicitly, so demo fixtures can no longer land in your real store (`tests/seed-isolation.test.ts`).

## Projects, kinds and the brief

A repository outlives the sessions that work on it. The namespace answers *who* wrote a row; it cannot answer *which effort* the row is about, because one agent works on several repositories and one repository is worked on by several agents. So a row carries two more things ([ADR-0020](docs/adr/0020-project-as-a-dimension.md), [ADR-0021](docs/adr/0021-kind-decides-retention.md)):

- **`project`** — a slug, resolved explicit → `MEMORY_PROJECT` / `AI_MEMORY_PROJECT` → the git work-tree root, slugged → `null`. Two agents in the same checkout derive the same slug without coordinating, which is what lets one agent's convention reach the next agent that opens the repository. Reconcile stays inside one project: the same sentence filed under two repositories is two facts, not a duplicate.
- **`kind`** — `decision | convention | gotcha | fact | task | note`, derived lexically (bilingual, zero model calls; an explicit `--kind` always wins). It answers "why does this deserve to survive": the first three are durable, `task` lives a week, `note` a month. An explicit kind also supplies the importance nobody gave (decision 0.8, convention/gotcha 0.75, task 0.5, note 0.4).

```bash
ai-memory save "We chose float32 blobs over JSON text because parsing was the cost" --kind decision
ai-memory save "Always run npm run lint before committing" --kind convention
ai-memory brief                    # what this repository already knows, ≤600 tokens
ai-memory project list             # every project this store holds, live rows per kind
ai-memory project init             # make this repository's project visible now (--note for a first decision)
```

Managing a project does not build a second thing to keep in sync — there is no `projects` table, and a project exists because rows carry its slug ([ADR-0042](docs/adr/0042-project-management-rides-the-dimension.md)). `project init` writes one durable marker row (tagged `project:init`, in the shared layer, skipped by the brief) so the project is visible before its first real write; `project rename <from> <to>` moves every row — tombstones included — and refuses an occupied target unless `--merge`; `project forget <slug>` soft-deletes the rows (restorable) and `--detach` unscopes them instead. MCP exposes the same four operations as one tool, `memory_project` (`op: list | init | rename | forget`); the daemon exposes `GET|POST /projects`, `POST /projects/:slug/rename` and `DELETE /projects/:slug?mode=`.

`memory_brief` (MCP), `GET|POST /brief` and `ai-memory brief` print one **deterministic** block — same store and same clock give byte-identical text, so it can be diffed and cached ([ADR-0022](docs/adr/0022-brief-assembly.md)). Sections are fixed: **conventions → decisions → gotchas → open → recent** (shares 0.25 / 0.30 / 0.20 / 0.15 / 0.10, unused shares pass down). A search ranks against a question; a brief guarantees coverage, which is what a session that starts with no question actually needs. The auto-injection hook uses the brief when the turn has no query and falls back to a search when it does.

Both dimensions are filters everywhere: `list`, `search`, `brief`, `prune`, `stats` (`byKind`, `byProject`), the console and the CLI (`--kind`, `--project`). `undefined` means no filter; `null` means "rows with no project", which is what every pre-v0.6 row is.

## Storage

- `SqliteVectorStore` via `node:sqlite` (`DatabaseSync`, Node 22+). Single file `memory.db` (WAL). `InMemoryVectorStore` is used in tests.
- For `LanceDB`/`sqlite-vec`/`Qdrant`, implement `VectorStore` interface and inject via `new MemoryService({store: myStore})`.
- **Vectors are float32 blobs, not JSON.** A row's embedding lives in `memory_vectors(memory_id, dim, vec BLOB, norm)`; `vectorSearch` scores `(id, vec, dim, norm)` first and only fetches full rows for the survivors. `memoryFromRow` hands back `embedding: []`; `getById`/`list` attach it when someone actually needs it. Older files are migrated on open, resumably, in batches of 5000 — measured 335 rows in 51 ms, 10k rows in 1.03 s ([ADR-0017](docs/adr/0017-vector-blob-layout.md)).
- **Batch writes:** `store.insertMany`, `service.saveMany(inputs, { reconcile, raw })` and `POST /memories/bulk` write one transaction and one embed batch. `reconcile` defaults to off in bulk mode — a 5-neighbour search per row would make a 10k import quadratic ([ADR-0018](docs/adr/0018-batch-writes-and-purge.md)). The cheap gates do run here (ADR-0018 amendment, 2026-11-07), in both branches (batch and `{reconcile: true}`): curation per row — rejected lines skip with `skipDetails` instead of killing or half-committing the batch, and `secret` plus empty text are refused even under `raw` — and exact-text duplicates fold on the derived `text_hash` column within one partition (namespace, project, type), against readable live rows only: tombstoned, archived and draft rows block nothing.
- **Write history and two clocks (ADR-0045).** Every write point — insert, reinforce, supersede, archive — commits an append-only `memory_events` row (old/new/reason/model/at, mem0's history-table shape) **in the same transaction as its write**, and nothing ever deletes one: `purgeDeleted` removes the row and not the story, so `ai-memory get <id> --history` still answers for a purged id. Two clocks ride on the row itself: `valid_at` — when the fact became true, parsed from the text's own `(at:YYYY-MM-DD)` stamp (NULL when the text names no date, backfilled once in a single atomic migration like `text_hash` before it) — and `invalid_at`, stamped by the supersede's invalidation UPDATE; a plain forget leaves it NULL because "removed" and "stopped being true" are different facts. Supersede is one transaction now: successor's insert, old row's tombstone + `invalid_at`, both history rows, then `noteChange` on both ids so the partition cache never serves the dead row (ADR-0034/0035).
- **Space:** `prune` is a soft delete and keeps the bytes. `store.purgeDeleted({ olderThanMs })` is the opt-in hard delete, and `ai-memory db compact [--purge <days>]` (or `POST /compact`) VACUUMs the file and reports the footprint (db + WAL + shm).

### Scale, measured

Single partition, 1100-char rows, real `insert`/`save` path, this machine, end-to-end `service.search` (k=5, budget 800, threshold 0.35):

| rows / dim | `vectorSearch` p50 | `search` p50 (before → after) | file | note |
|---|---|---|---|---|
| 2,000 / 384 | 10.4 ms | 30.2 → **15.3 ms** | 14.5 MB | harness, ADR-0019 |
| 4,000 / 384 | 1.0 ms | 28.6 → **4.7 ms** | 26.3 MB | + ADR-0029, ADR-0033, ADR-0035 |
| 10,000 / 384 | 2.3 ms | 64.6 → **7.7 ms** | 65.3 MB | |
| 20,000 / 384 | 4.4 ms | 148.9 → **11.9 ms** | 136.2 MB | linearity check |
| 4,000 / 2048 | 62.3 ms | 122.2 → **83.7 ms** | 54.3 MB | NIM-width vectors |

(The "before" column is the same harness on the tree that already had ADR-0017/0018 but not ADR-0019; the ADR-0017 section above carries the older JSON-vector `vectorSearch` numbers.)

Extrapolated to 10^5 rows: ~~2.8 s~~ → **~0.25 s / 0.63 GB** at 384 dims (0.3× the 700 ms budget), ~~6.0 s~~ → **~2.07 s / 1.31 GB** at 2048 dims. Those are linear extrapolations and should now be read as upper bounds — see the last paragraph of this section. The full harness, its limits and the phase breakdown are in [docs/scale-bench.md](docs/scale-bench.md) (`node scripts/scale-bench.mjs --rows 10000 --dim 384 --ns 1`).

**A vector index was built, measured, and reverted; the scan was fixed instead.** Binning rows along the principal axis — the only structure available with zero dependencies — kept the exact scan's top-1 79% of the time and its recall@5 only **43.8%** on clustered embeddings, so it was dropped. What the profiling found underneath is more useful: `SELECT ... JOIN memory_vectors` was 11.7 ms of an 18.6 ms search, and it is the *page load of the blob column*, not the bytes (`SELECT id` 1.3 ms, a 4-byte literal blob 2.5 ms, four bytes of the real column 8.1 ms). So the work went into not reading it twice: a candidate set is decoded once into one flat `Float32Array`, keyed by the resolved `WHERE` clause, LRU-bounded by `MEMORY_VECTOR_CACHE_MB` (default 64, `off` to disable), and invalidated per row on write. 4,000 rows × 384d: `vectorSearch` 22.4 → **1.4 ms**, `search` p50 28.6 → **10.3 ms**, and the 10^5 projection 706 → **254 ms**. The arithmetic is identical, so recall is untouched — with the vector phase that cheap, `lexicalCandidates` is once again the largest piece of a search. [ADR-0029](docs/adr/0029-partition-vector-cache.md)

**Then the lexical query was asking for the wrong plan.** `lexicalCandidates` was 14.6 ms of a 22.5 ms search at 10,000 rows, and not because its index was slow — `SELECT token, n FROM term_df WHERE token IN (...)` is 0.002 ms. `EXPLAIN QUERY PLAN` showed SQLite walking the partition index and probing `memory_terms` **once per row**, because the document-frequency list was written as a `UNION ALL` subquery and became the driving side of the join. A lookup that should read one posting record was doing 10,000 primary-key probes. `CROSS JOIN` forbids the reorder, so the plan becomes `SEARCH t (token=?) → SEARCH m (id=?)` — but pinning trades one partition walk for one `memories` probe *per posting*, which stops paying once the chosen words are held by thousands of rows (at df 2,500 the planner is 1.36× faster). The store therefore picks per call on the chosen words' total df, cutover at 2,000. Same rows, same scores, different access order: `lexicalCandidates` 14.6 → **2.0 ms** and `search` p50 22.5 → **7.4 ms** at 10,000 rows (4,000 rows: 10.4 → **5.0 ms**). [ADR-0033](docs/adr/0033-pin-the-lexical-join-order.md)

Search is no longer linear in partition size, which makes the 10^5 extrapolations above upper bounds rather than predictions: the vector arm still reads the whole partition (0.63 GB projection), while the lexical arm is now bounded by how many rows hold the query's words. The harness reports the two arms separately (`projection.vectorP50MsLinear`, `projection.lexicalP50MsAtThisSize`) so the distinction survives into the JSON.

**The write path was not slow — the cache was being thrown away.** `save` was said to cost a full partition scan because it reconciles against its 5 nearest neighbours, and it did: 123.1 ms at 20,000 rows. Instrumenting the call showed where that actually went. The neighbour search itself was **0.26 ms**; the same call inside `saveDetailed` was **113 ms**. `writeVectorSync` bumped a store-wide `vectorVersion` on every vector write, so inserting a row expired *every* cached partition, and the next save re-decoded 20,000 rows (31.8 MB) before its insert. The per-row `dropRow` that already existed was precise — the blanket version bump next to it was not. A plain insert now invalidates nothing (it changes no decoded row), a rewrite still invalidates exactly the partitions that held it, and a stale hit is charged as a miss so the stats can no longer report a healthy hit rate over a partition being rebuilt every save. `save` p50 27.5 → **4.25 ms** and `search` p50 10.4 → **5.5 ms** at 4,000 rows; `save` p50 **4.96 ms** at 10,000. [ADR-0034](docs/adr/0034-writes-expire-only-changed-partitions.md)

**Not invalidating turned out to be a correctness bug, and fixing it made the cache cheaper still.** "An insert touches no decoded row" is true and useless: an entry is a snapshot of *which rows matched*, so a row inserted after the decode was not in it and could not be returned — a row whose vector equalled the query scored **1.0** through the exact scan and was **invisible** through the cache. `updateMeta` had the same hole from the other side (it never touched the cache, and `status`/`is_deleted` are part of the candidate `WHERE`), and `prune` flipped 40 rows to deleted while the cached search still returned five of them. The fix is a log of changed row ids (the last 4,096, ids only) plus a `seq` on each entry: on a hit the store replays what changed since the decode, asks the database — with the same `WHERE` that built the entry — which of those ids belong here, and **appends them in place**. An insert now costs a memcpy instead of a decode. [ADR-0035](docs/adr/0035-a-partition-catches-up-instead-of-being-rebuilt.md)

**Then rewrites were the expensive shape.** `reembed` rewrites every row of a partition in turn through `updateEmbedding`, which marked the partition stale, so each rewrite paid a whole-partition decode: at 20,000 rows, one rewrite plus one search was **109.8 ms**, and forty rewrites produced forty-one misses — O(rows²) for a full re-embed. A rewrite is the one change the writer can describe completely: the row keeps its id and its membership, only the numbers move, and the new vector is in hand. `patchRow` overwrites it at the slot the entry already keeps for it — `dim` floats, no allocation, no invalidation — and nothing goes in the log. Rewrite-plus-search **109.8 → 5.06 ms** (21.7×) with **zero** misses over forty rewrites. [ADR-0036](docs/adr/0036-a-rewrite-patches-the-snapshot-in-place.md)

**The 2048-dim column was attacked and the attack was documented as a miss.** An int8 shortlist (one signed byte per dimension plus a `maxAbs` scale, ranked on those bytes, with the shortlist re-scored exactly against the float32 blob) buys **1.45×** — 181.6 → 125.5 ms at 10,000 rows — for **+25% disk**, and lands at ~1.09 s at 10^5 rows. It is therefore **off by default** (`MEMORY_Q8=on` opts in). The phase split says why it stops there: reading four times fewer bytes per row saved 26 ms of 116 ms, and the rest is per-row object construction and the JOIN — costs that only fall if fewer *rows* are read. That reading also settles the int8 question: four times fewer bytes saved 26 ms of 116 ms, because the cost is touching the column at all, so a narrower blob could never get there — [ADR-0029](docs/adr/0029-partition-vector-cache.md) explains how the same measurement led to caching decodes instead. [ADR-0025](docs/adr/0025-int8-shortlist.md) · [ADR-0026](docs/adr/0026-int8-off-by-default.md)

**The lexical index was moved to FTS5, measured, and moved back.** With the vector phase down to ~1.4 ms, `lexicalCandidates` became the largest line item in a warm search, and SQLite ships FTS5 — Node's bundled build has it compiled in. An FTS5 table over the same token stream was built to be *exactly* equivalent to the hand-rolled postings (same ids, same scores, same filters, enforced by a test, including a repeated-word row to catch tf read as 1 and a `snake_case_ident` row to catch tokenizer drift), and it was **9.3× slower** on the query shape this retriever actually issues: 8.0 ms through the postings against 74.9 ms through FTS5 at 20,000 rows. The reason is structural rather than a tuning miss — `MATCH` has to scan for phrase matches to discover which rows hold a token, while an inverted index answers the same question with an equality lookup on a primary key, and doing the former once per token per row multiplies it. So the postings stay, and the negative result is written down: [ADR-0031](docs/adr/0031-no-fts5-lexical-index.md)

## Project layout

```
CONTEXT.md              # ubiquitous language (Memory, Token Burning, etc.)
docs/adr/               # decision records 0001-0038
docs/DESIGN-node-graph.md
src/core/
  types.ts              # Memory, Namespace, SearchResult, Brief, KnowledgeEdge
  project.ts            # resolveProject: explicit / env / git root -> slug
  write/                # reconciler, kind, facets, text
  store/                # interface, sqlite (node:sqlite), partitionCache, memory (in-memory)
  retrieval/            # hybrid, bm25, terms (index/query terms + coverage), mmr, tokens/budget, assemble, brief
  knowledge/            # sections, view (pages/links/neighbours), sync
  extraction/           # heuristic + optional LLM extractor
  lifecycle/ decay.ts, maintenance.ts (the MEMORY_MAINTAIN_HOURS sweep), triage.ts (the retroactive curate pass)
  judgment/             # jev write gate (optional, opt-in)
  graph.ts              # wiki graph: parsePage, buildGraph, suggestPages
  memoryService.ts
src/api/ server.ts (node:http, routes inline, serves UI), tool.ts
src/adapters/           # agent config writers (claude, codex, pi, dsh)
src/mcp/ tools.ts       # memory_* MCP tools
src/cli/                # the ai-memory command
src/ui/                 # graph.html, graph.js — the vault graph, framed by the console
tests/                  # vitest: store, retrieval, api, cli, knowledge, scale
scripts/ seed.ts, cold-start.ts, wiki-ingest.ts, wiki-links.ts, scale-bench.mjs, realtime-bench.mjs
memory.db               # created on first run, gitignored
```

## Tests

```bash
npm test            # vitest — 50 files, 632 tests (7 skipped by design)
npm run lint        # tsc -p tsconfig.lint.json
```

Most tests use `InMemoryVectorStore`; the SQLite path (layout, migration, purge/compact, bulk HTTP) is covered by `tests/store-scale.test.ts` against real temp files.

## Domain language

See `CONTEXT.md`. Canonical terms: **Memory**, **Episodic/Semantic/Procedural/Working Memory**, **Namespace**, **Token Burning**, **Context Burning**, **Importance**, **Supersede**, **Hard Budget**, **Smart Search**, **Project**, **Kind**, **Brief**, **Knowledge page / section / link**.

## Decisions (ADRs)

- `0001-embedded-sqlite-vec-over-qdrant`
- `0002-deterministic-retrieval-no-llm-reranker-v1`
- `0003-explicit-tool-over-auto-middleware`
- `0004-pluggable-embedding-provider-local-default` (superseded in practice: the pluggable surface was cut to one provider in v0.2.0)
- `0005-flat-layers-via-tags`
- `0006-governance-lite-status-pin-visibility`
- `0007-react-console-beside-zero-dep-ui`
- `0008-console-replaces-inspector`
- `0009-embedding-switch-is-settings-plus-restart`
- `0010-console-writes-credentials`
- `0011-write-time-reconcile-schema-free-facets`
- `0012-candidate-union-over-term-index`
- `0013-honest-k-budget-and-decay`
- `0014-project-into-leftover-budget`
- `0015-shape-gate-and-dated-context`
- `0016-archive-first-decay`
- `0017-vector-blob-layout`
- `0018-batch-writes-and-purge`
- `0019-term-df-and-rarity-gate`
- `0020-project-as-a-dimension`
- `0021-kind-decides-retention`
- `0022-brief-assembly`
- `0023-knowledge-dimension`
- `0024-realtime-benchmark`
- `0025-int8-shortlist`
- `0026-int8-off-by-default`
- `0027-cjk-relevance-by-coverage`
- `0028-idf-weighted-coverage-and-prf`
- `0029-partition-vector-cache`
- `0030-knowledge-index-reads-pages-not-partitions`
- `0031-no-fts5-lexical-index`
- `0032-bench-measures-the-vector-path`
- `0033-pin-the-lexical-join-order`
- `0034-writes-expire-only-changed-partitions`
- `0035-a-partition-catches-up-instead-of-being-rebuilt`
- `0036-a-rewrite-patches-the-snapshot-in-place`
- `0037-explain-an-empty-search`
- `0038-all-is-a-question-about-the-store`
- `0039-an-empty-result-reports-the-partitions-it-did-not-read`
- `0040-writes-are-curated`
- `0041-the-write-gates-judgement-call-goes-to-the-model`
- `0042-project-management-rides-the-dimension`
- `0043-agent-chat-and-console-monochrome`
- `0044-vault-graph-in-the-console`
- `0045-write-history-and-two-clocks`
- `0046-facet-index-and-third-candidate-arm`
- `0047-conflict-window-and-pending-conflicts`
