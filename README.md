# AI Memory — local-first memory for pi agents

A **local-first, namespace-partitioned memory substrate** that stores *Episodic / Semantic / Procedural / Working* memories as vectors and retrieves them with **smart search + hard token budget** to prevent *Token Burning* (cost) and *Context Burning* (irrelevant dilution).

- **Embedded DB**: SQLite via `node:sqlite` (`memory.db` single file, WAL), no Docker. `VectorStore` interface swappable to Qdrant/Chroma (ADR-0001).
- **Smart Search**: 2-stage — `0.6*vector + 0.2*BM25 + 0.15*recency + 0.05*importance` → MMR diversify → threshold `0.72` (empty allowed) → **hard budget** (default 800 tokens) + overflow summarization (ADR-0002). Deterministic, zero extra LLM call.
- **Hard Budget**: Every `search` returns `{memories, tokensUsed, truncated, summary}`. UI shows `420/800` bar.
- **Explainable recall** (R1): `?explain=1` (or `--explain`) returns where each score came from — `bm25 +0.37 · recency +0.24 · strength +0.12 = 0.737`. Off by default, because four extra numbers per hit is real payload on a response whose point is a token budget. Everyone returns results; this returns *why*.
- **Retrieval reinforcement** (R2): a memory that keeps getting retrieved gets stronger (`strength +0.02`, capped 0.95) and its clock resets, so decay reads age as time-since-last-use. `importance` stays the judge's write-time number; `strength` is what use has proven. No model call, no cost, and the store gets better the more it is used.
- **Inspector UI**: plain `index.html` + `app.js` served by the same `node:http` process as the API. No bundler, no framework. List/filter by type, playground with `k / threshold / budget` sliders, budget preview, soft-delete, supersede chain.
- **Wiki graph** (`/graph.html`): Obsidian-style node graph over your own markdown. Edges come from `[[wikilinks]]` written into page frontmatter at ingest — nothing is inferred, so the graph never lies about intent. Drag nodes; positions persist to `wiki/.positions.json`. Dangling links render as hollow nodes — hiding them would hide the maintenance debt.
- **CLI** (`ai-memory`): every subcommand works non-interactively, because hooks call it. Uses the daemon when one answers, otherwise opens the store in-process.
- **MCP server** (`src/mcp/tools.ts`): `memory_*` tools, every one accepting an explicit `scope`.
- **Zero runtime dependencies.** `node:http`, `node:sqlite`, `node:crypto`. Dev-only: tsx, typescript, vitest.

## Quick start

**Requires Node 22+** — `node:sqlite` is still flagged experimental (Node 24 is what this is developed against).

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
npm start        # API + UI on http://127.0.0.1:3000  (PORT / HOST override)
```

Dev with reload: `npm run dev`. Then open **http://127.0.0.1:3000** for the inspector, or **/graph.html** for the wiki graph.

### Wiki to memory

```bash
npm run wiki:ingest -- ./docs            # markdown -> ./wiki/*.md + semantic sections
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
| `POST` | `/memories/search` | `{query, namespace, k?, budgetTokens?, threshold?, type?, explain?}` |
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
| HTTP / UI (this server) | **0.72** | The ADR-0002 value, unchanged. Keeps context pollution out. |
| pi `memory_search` (auto-memory extension) | **0.35** English / **0.2** Chinese | Measured against this corpus, 0.72 discarded real memories: an exact hit scores ~0.96, a reworded one ~0.33. A Chinese query scores structurally low because the hash embedder returns ~0 cosine for CJK and the vector term carries 0.6 weight. |

This is a deliberate divergence, not drift. The agent is answering questions it was asked; the UI is you deciding what to inject into a prompt. Revisit when the corpus has enough real memories to judge `0.35` on its own.

## Smart Search details

- **Stage 1**: `vectorSearch` over namespace partition (over-fetch `max(20, k*4)`), score hybrid, filter `score >= threshold` (allows empty → prevents context pollution).
- **Stage 2**: MMR `lambda=0.6` diversify, sort, then `budgetEnforce` — keeps heads until budget, summarizes overflow (extractive first-sentences).
- **Tokens**: heuristic `len/4`; swap to `js-tiktoken` by installing it (auto-detected).

## Embeddings

One provider: `HashEmbeddingProvider` — 384-d, deterministic, offline, zero download.

**Be clear about what this is:** a hash embedder is a deterministic bucket of tokens, not a semantic model. It matches on shared vocabulary, not on meaning. It is the right default because it is instant, offline, free and needs no key — but if you expect "vector search" to mean "finds things that mean the same thing", that is the assumption to check. `.env.example` documents NVIDIA NIM and OpenAI keys; wiring one in is an interface, not a rewrite, but the `dim` change requires `rm memory.db*`.

It is the only provider that exists, on purpose: a hosted embedder means an API key, a network hop on every save, and a `dim` migration the moment the model changes. Add a real one only when recall measurably misses.

## Retrieval

Score = \`0.6*bm25 + 0.25*recency + 0.15*strength\` (\`vector\` weight 0 by default — see below), plus \`+0.3\` for a pinned memory. Relevance gates first: a memory with no lexical overlap and no vector signal is not a match, it is just a recent important one, and recency+strength alone would clear the threshold on every row.

**\`strength\` vs \`importance\`.** \`importance\` is what the write-time judge thought (see "Smart write gate"). \`strength\` is what use has proven — it starts equal to \`importance\` and grows on retrieval. They are separate fields on purpose: if reinforcement wrote \`importance\`, then "the model thought this mattered" and "this keeps answering questions" would compete for one number and neither would be true. Ranking reads \`strength\`; the judge owns \`importance\`; decay prunes on \`strength\`.

**\`MEMORY_VECTOR_WEIGHT\`** defaults to \`0\`. The hash embedder returns ~0.9 cosine to everything, so the vector term is noise until a real embedder is wired in — with the hash provider, lexical overlap is the only relevance signal that exists.

## Smart write gate

Extraction is two stages, cheapest first.

**1. Heuristic rules** (\`Extractor.isWorthKeeping\`) — free, deterministic, and wrong in one specific direction. "Run the tests before commit" is throwaway task scaffolding in one repo and a durable routine in another. No regex settles that, and both answers are defensible.

**2. Jev judge** (optional, \`src/core/judgment/judge.ts\`) — one \`noul\` per sentence that survived stage 1, asking whether it will still be useful to an assistant weeks from now. The result is a probability, so a borderline memory is stored *weak* instead of being either certainly kept or certainly dropped:

\`\`\`
keep 1.0 -> importance 0.90      keep 0.5 -> importance 0.65      keep 0.0 -> importance 0.40
\`\`\`

\`importanceFor()\` is deliberately monotonic in confidence: decay then keeps what the judge was sure about and lets the shaky ones sink. Memories that went through it are tagged \`judged:jev\`.

Below \`MEMORY_JEV_MIN\` (default 0.5) the sentence is dropped. **Fail-open**: no key, a 401, or the API being down means the memory is stored *unjudged* rather than lost. A store that silently stops recording because a judge API is down is worse than one that occasionally keeps a mediocre fact.

\`\`\`bash
echo -n 'ts-...' > ~/.typesafe-key && chmod 600 ~/.typesafe-key
# in .env:
JEV_API_KEY_FILE=~/.typesafe-key       # a path, so .env stays shareable
MEMORY_JEV_MIN=0.5
MEMORY_JEV=false                     # turn it off, heuristic only
\`\`\`

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
src/ui/ index.html, app.js, graph.html, graph.js, style.css   # static, no build step
tests/                  # 155 tests
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
src/ui/ index.html, app.js, style.css  # static, no build step
tests/ store.test.ts, retrieval.test.ts, api.test.ts
scripts/ seed.ts
memory.db               # created on first run
```

## Tests

```bash
```bash
npm test            # vitest — 155 tests, 18 files
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
