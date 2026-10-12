# Open Memory — local-first memory for pi agents

> **Status: `0.3.0-beta.1`** — first published build. The storage format is settled; the
> HTTP and MCP surfaces can still move between prereleases.

![the console: a query, the floor preset that made seven hits appear, the token budget,
and the score decomposition behind every hit](docs/images/console-recall-dark.png)

A **local-first, namespace-partitioned memory substrate** that stores *Episodic / Semantic / Procedural / Working* memories as vectors and retrieves them with **smart search + hard token budget** to prevent *Token Burning* (cost) and *Context Burning* (irrelevant dilution).

- **Embedded DB**: SQLite via `node:sqlite` (`memory.db` single file, WAL), no Docker. `VectorStore` interface swappable to Qdrant/Chroma (ADR-0001).
- **Smart Search**: 2-stage — `0.6*BM25 + 0.25*recency + 0.15*strength` (`vector` weight is `0` by default; see Embeddings) → MMR diversify → relevance floor `0.72` (empty allowed, and it is a floor on *relevance*, not on the total — an old exact match must never age out of reach) → **hard budget** (default 800 tokens) + overflow summarization (ADR-0002). Deterministic, zero extra LLM call.
- **Hard Budget**: Every `search` returns `{memories, tokensUsed, truncated, summary}`. UI shows `420/800` bar.
- **Explainable recall** (R1): `?explain=1` (or `--explain`) returns where each score came from — `bm25 +0.37 · recency +0.24 · strength +0.12 = 0.737`. Off by default, because four extra numbers per hit is real payload on a response whose point is a token budget. Everyone returns results; this returns *why*.
- **Retrieval reinforcement** (R2): a memory that keeps getting retrieved gets stronger (`strength +0.02`, capped 0.95) and its clock resets, so decay reads age as time-since-last-use. `importance` stays the judge's write-time number; `strength` is what use has proven. No model call, no cost, and the store gets better the more it is used.
- **Console** (`ui/`, built to `dist/src/ui-next`, served at `/`): the one browser UI over the API below — Recall, Memories, Sessions, Graph, Stats — in two themes (dark default, warm-white light). The old inspector is gone.
- **Vault graph** (`/graph.html`): Obsidian-style node graph over `vault/` — any markdown you point `VAULT_DIR` at. Edges come from `[[wikilinks]]` in the body plus the frontmatter `links:` that ingest writes — nothing is inferred, so the graph never lies about intent. Click a node for the local graph (depth 1-3), filter with `tag:x` / `path:x` / substring, colour by folder, drag nodes; positions persist to `vault/.positions.json`. Dangling and ambiguous links render as hollow nodes — hiding them would hide the maintenance debt.
- **CLI** (`ai-memory`): every subcommand works non-interactively, because hooks call it. Uses the daemon when one answers, otherwise opens the store in-process.
- **MCP server** (`src/mcp/tools.ts`): `memory_*` tools, every one accepting an explicit `scope`.
- **Zero runtime dependencies.** `node:http`, `node:sqlite`, `node:crypto`. Dev-only: tsx, typescript, vitest.

## Quick start

**Requires Node 22+** — `node:sqlite` is still flagged experimental (Node 24 is what this is developed against).

**Platforms:** developed and used on Windows, and verified on Linux by CI, which installs
the packed tarball on a clean Ubuntu runner and exercises the CLI, the daemon and the
console there. **macOS is untested** — reports welcome.

```bash
npm i -g open-memory    # the package; the command is still `ai-memory`
ai-memory db info       # where the store lives, and why
ai-memory save "user prefers dark mode" --type semantic
ai-memory search "dark mode" --explain
```

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
node node_modules/open-memory/dist/src/api/server.js   # PORT / HOST / MEMORY_DB_PATH
```

![the same view in the light theme](docs/images/console-recall-light.png)

Five views:

- **Recall** — search, the per-hit score decomposition, and the token budget bar with its `truncated` badge and overflow summary. The `0.72` / `0.35` / `0.2` floors are preset buttons, so the same query visibly goes from zero hits to several.
- **Memories** — list, filters, a detail drawer, the supersede chain in both directions, and create / pin / status / supersede / soft-delete / restore.
- **Sessions** — a read-only timeline of pi's own `.jsonl` session files, with the memory tool calls marked.
- **Graph** — frames `/graph.html`, read-only over `vault/`.
- **Stats** — the `?full=1` numbers, histograms, the decay candidates and what a decay would prune.

Two themes — dark (default) and warm-white light — behind an `auto | dark | light` control, `auto` following `prefers-color-scheme`. Keyboard: `/` focus search, `Esc` close drawer, `j`/`k` move selection, `Cmd`/`Ctrl`+`Enter` submit.

One honest limit: there is no token-savings figure, because recall results are not persisted, so the console does not show one.

### Wiki to memory

```bash
npm run wiki:ingest -- ./docs            # markdown -> ./vault/*.md + semantic sections
npm run wiki:links                       # graph: nodes, degrees, dangling links
npm run wiki:links -- --suggest <slug>   # link candidates (shared title terms, no model call)
npm run wiki:links -- --add <from> <to>  # append [[to]] to <from>
```

Whole documents are not stored. One 1.5k-char blob is a file, not a memory: it matches on any word it happens to share with the query and spends half the recall budget printing back a decision record you could just read. `wiki:ingest` splits on headings and stores each section with its heading attached.

## API

| Method | Path | Body / Query |
|---|---|---|
| `POST` | `/memories` | `{namespace, type, text, importance?, tags?, source?}` |
| `GET` | `/memories?namespace=&type=&q=&includeDeleted=` | list |
| `GET` | `/memories/:id` | |
| `DELETE` | `/memories/:id` | soft-delete |
| `POST` | `/memories/:id/supersede` | `{namespace,type,text,...}` creates new + soft-deletes old via `supersedesId` |
| `POST` | `/memories/search` | `{query, namespace, namespaces?, k?, budgetTokens?, threshold?, type?, explain?}` — `namespaces` is comma-separated and overrides `namespace`; it is how the CLI reads its own partition plus the legacy one |
| `POST` | `/extract` | `{text, namespace}` — heuristic (no LLM) or LLM if `ENABLE_EXTRACTOR=true` + `OPENAI_API_KEY` |
| `POST` | `/decay` | prunes `episodic >90d && importance<=0.3` + `working >7d` |
| `GET` | `/graph` | wiki node graph: `{nodes, edges}` |
| `GET`/`POST` | `/positions` | read / write `{slug, x, y}` for the graph canvas |
| `GET` | `/health` | |
| `GET` | `/stats?namespace=` | |
| `PATCH` | `/memories/:id` | `{status?, pin?}` governance |

### Agent wiring (tool-first, ADR-0003)

```ts
import { MemoryService } from "./src/core/memoryService.js";
import { createMemoryTool, autoInject } from "./src/api/tool.js";

const svc = new MemoryService({ dbPath: "memory.db" });
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
| pi `memory_search` (auto-memory extension) | **0.35** English / **0.2** Chinese | Measured against this corpus, 0.72 discarded real memories: an exact hit scores ~0.96, a reworded one ~0.33. A Chinese query scores structurally low because the hash embedder returns ~0 cosine for CJK and the vector term carries 0.6 weight. |

This is a deliberate divergence, not drift. The agent is answering questions it was asked; the UI is you deciding what to inject into a prompt. Revisit when the corpus has enough real memories to judge `0.35` on its own.

## Smart Search details

- **Stage 1**: `vectorSearch` over namespace partition (over-fetch `max(20, k*4)`), score hybrid, filter `score >= threshold` (allows empty → prevents context pollution).
- **Stage 2**: MMR `lambda=0.6` diversify, sort, then `budgetEnforce` — keeps heads until budget, summarizes overflow (extractive first-sentences).
- **Tokens**: heuristic `len/4`; swap to `js-tiktoken` by installing it (auto-detected).

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

**A third path, from the console.** `Embeddings` in the Stats view picks a provider and writes `~/.ai-memory/settings.json` — the non-secret keys only (`EMBEDDING_PROVIDER`, the dim, the model, the base URL), **never an API key**. Precedence is **real environment > that file > built-in default**: an `EMBEDDING_PROVIDER` exported in your shell — or in `.env`, which is a real env value — beats the file, and the card says which of the three is in play. The change takes effect on the **next start**; the running process keeps its embedder (ADR-0009).

The order is fixed: **write → dry run → migrate → restart.** Neither middle step is optional. A restart right after a write is refused by the startup guard, which names both dims — that is the guard working, not a crash. And migrating without restarting is the worse state: every row is at the new width while the running process still embeds at the old one, so searches return nothing until it restarts. The card counts the rows the running provider cannot read for exactly that reason, and says `restart now to restore search` when the migration ends.

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

It covers archived, draft and soft-deleted rows too, so a later `restore` cannot hand the retriever a vector of the wrong width; a row left stale by an interrupted run is skipped by search rather than crashing it. A key still has to come from the environment; `reembed` reads the same merged settings the console writes, so the CLI and the console's migrate agree on which provider they are migrating to. `mv memory.db memory.db.bak` remains the start-fresh option.

The vector weight follows the embedder: `0.6` when a real provider is configured, `0` for hash (which returns ~0.9 cosine to everything, so the term would be noise). `MEMORY_VECTOR_WEIGHT` overrides either. A configured embedder that contributed nothing to ranking would cost a network hop per save and buy nothing — which is why this is not a number you have to discover.

## Retrieval

Score = `0.6*bm25 + 0.25*recency + 0.15*strength` (`vector` weight 0 by default — see below), plus `+0.3` for a pinned memory. Relevance gates first: a memory with no lexical overlap and no vector signal is not a match, it is just a recent important one, and recency+strength alone would clear the threshold on every row.

**`strength` vs `importance`.** `importance` is what the write-time judge thought (see "Smart write gate"). `strength` is what use has proven — it starts equal to `importance` and grows on retrieval. They are separate fields on purpose: if reinforcement wrote `importance`, then "the model thought this mattered" and "this keeps answering questions" would compete for one number and neither would be true. Ranking reads `strength`; the judge owns `importance`; decay prunes on `strength`.

**`MEMORY_VECTOR_WEIGHT`** defaults to `0.6` once a real embedder is configured and `0` for hash: the hash provider returns ~0.9 cosine to everything, so the vector term would be noise, and with it lexical overlap is the only relevance signal that exists. Set the variable to override either way.

## Smart write gate

Extraction is two stages, cheapest first.

**1. Heuristic rules** (`Extractor.isWorthKeeping`) — free, deterministic, and wrong in one specific direction. "Run the tests before commit" is throwaway task scaffolding in one repo and a durable routine in another. No regex settles that, and both answers are defensible.

**2. Jev judge** (optional, `src/core/judgment/judge.ts`) — one `noul` per sentence that survived stage 1, asking whether it will still be useful to an assistant weeks from now. The result is a probability, so a borderline memory is stored *weak* instead of being either certainly kept or certainly dropped:

```
keep 1.0 -> importance 0.90      keep 0.5 -> importance 0.65      keep 0.0 -> importance 0.40
```

`importanceFor()` is deliberately monotonic in confidence: decay then keeps what the judge was sure about and lets the shaky ones sink. Memories that went through it are tagged `judged:jev`.

Below `MEMORY_JEV_MIN` (default 0.5) the sentence is dropped. **Fail-open**: no key, a 401, or the API being down means the memory is stored *unjudged* rather than lost. A store that silently stops recording because a judge API is down is worse than one that occasionally keeps a mediocre fact.

```bash
echo -n 'ts-...' > ~/.typesafe-key && chmod 600 ~/.typesafe-key
# in .env:
JEV_API_KEY_FILE=~/.typesafe-key       # a path, so .env stays shareable
MEMORY_JEV_MIN=0.5
MEMORY_JEV=false                     # turn it off, heuristic only
```

Judge confidence outranks the regex importance: Jev read the whole sentence, the pattern only saw a verb. With no key configured, behavior is byte-identical to v0.2.0.

## Storage

- `SqliteVectorStore` via `node:sqlite` (`DatabaseSync`, Node 22+). Single file `memory.db` (WAL). `InMemoryVectorStore` is used in tests.
- For `LanceDB`/`sqlite-vec`/`Qdrant`, implement `VectorStore` interface and inject via `new MemoryService({store: myStore})`.

## Project layout

```
```
CONTEXT.md              # ubiquitous language (Memory, Token Burning, etc.)
docs/adr/0001-0006.md   # decision records
docs/DESIGN-node-graph.md
src/core/
  types.ts              # Memory, Namespace, SearchResult
  embedding/            # provider, hash
  store/                # interface, sqlite (node:sqlite), memory (in-memory)
  retrieval/            # hybrid, bm25, mmr, tokens/budget
  extraction/           # heuristic + optional LLM extractor
  lifecycle/ decay.ts
  judgment/             # jev write gate (optional, opt-in)
  graph.ts              # wiki graph: parsePage, buildGraph, suggestPages
  memoryService.ts
src/api/ server.ts (node:http, routes inline, serves UI), tool.ts
src/adapters/           # agent config writers (claude, codex, pi, dsh)
src/mcp/ tools.ts       # memory_* MCP tools
src/cli/                # the ai-memory command
src/ui/                 # graph.html, graph.js — the vault graph, framed by the console
tests/                  # 173 tests
scripts/ seed.ts, cold-start.ts, wiki-ingest.ts, wiki-links.ts
memory.db               # created on first run, gitignored
```
src/core/
  types.ts              # Memory, Namespace, SearchResult
  embedding/            # provider, hash
  store/                # interface, sqlite (node:sqlite), memory (in-memory)
  retrieval/            # hybrid, bm25, mmr, tokens/budget
  extraction/           # heuristic + optional LLM extractor
  lifecycle/ decay.ts
  memoryService.ts
src/api/ server.ts (node:http, routes inline, serves UI), tool.ts
src/ui/ graph.html, graph.js  # framed by the console
tests/ store.test.ts, retrieval.test.ts, api.test.ts
scripts/ seed.ts
memory.db               # created on first run
```

## Tests

```bash
```bash
npm test            # vitest — 173 tests, 19 files
npm run lint        # tsc --noEmit
```
npm run lint        # tsc --noEmit
```

All tests use `InMemoryVectorStore` (no `memory.db` needed). SQLite path is verified via `npm run seed`.

## Domain language

See `CONTEXT.md`. Canonical terms: **Memory**, **Episodic/Semantic/Procedural/Working Memory**, **Namespace**, **Token Burning**, **Context Burning**, **Importance**, **Supersede**, **Hard Budget**, **Smart Search**.

## Decisions (ADRs)

- `0001-embedded-sqlite-vec-over-qdrant`
- `0002-deterministic-retrieval-no-llm-reranker-v1`
- `0003-explicit-tool-over-auto-middleware`
- `0004-pluggable-embedding-provider-local-default` (superseded in practice: the pluggable surface was cut to one provider in v0.2.0)
