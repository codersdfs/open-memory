# AI Memory — local-first memory for pi agents

A **local-first, namespace-partitioned memory substrate** that stores *Episodic / Semantic / Procedural / Working* memories as vectors and retrieves them with **smart search + hard token budget** to prevent *Token Burning* (cost) and *Context Burning* (irrelevant dilution).

- **Embedded DB**: SQLite via `node:sqlite` (`memory.db` single file, WAL), no Docker. `VectorStore` interface swappable to Qdrant/Chroma (ADR-0001).
- **Smart Search**: 2-stage — `0.6*vector + 0.2*BM25 + 0.15*recency + 0.05*importance` → MMR diversify → threshold `0.72` (empty allowed) → **hard budget** (default 800 tokens) + overflow summarization (ADR-0002). Deterministic, zero extra LLM call.
- **Hard Budget**: Every `search` returns `{memories, tokensUsed, truncated, summary}`. UI shows `420/800` bar.
- **Inspector UI**: plain `index.html` + `app.js` served by the same `node:http` process as the API. No bundler, no framework. List/filter by type, playground with `k / threshold / budget` sliders, budget preview, soft-delete, supersede chain.
- **Zero runtime dependencies.** `node:http`, `node:sqlite`, `node:crypto`. Dev-only: tsx, typescript, vitest.

## Quick start

```bash
npm install
npm run seed     # seeds 8 demo memories into memory.db (default:default)
npm start        # API + UI on http://127.0.0.1:3000  (PORT / HOST override)
```

Dev with reload: `npm run dev`.

## API

| Method | Path | Body / Query |
|---|---|---|
| `POST` | `/memories` | `{namespace, type, text, importance?, tags?, source?}` |
| `GET` | `/memories?namespace=&type=&q=&includeDeleted=` | list |
| `GET` | `/memories/:id` | |
| `DELETE` | `/memories/:id` | soft-delete |
| `POST` | `/memories/:id/supersede` | `{namespace,type,text,...}` creates new + soft-deletes old via `supersedesId` |
| `POST` | `/memories/search` | `{query, namespace, k?, budgetTokens?, threshold?, type?}` |
| `POST` | `/extract` | `{text, namespace}` — heuristic (no LLM) or LLM if `ENABLE_EXTRACTOR=true` + `OPENAI_API_KEY` |
| `POST` | `/decay` | prunes `episodic >90d && importance<=0.3` + `working >7d` |
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

One provider: `HashEmbeddingProvider` — 384-d, deterministic, offline, zero download. It is the only thing that exists, on purpose: swapping in a hosted embedder means an API key, a network hop on every save, and a `dim` migration (`rm memory.db*`) the moment the model changes. Add a real one only when recall measurably misses, and give it a name + dim in `/health`.
## Storage

- `SqliteVectorStore` via `node:sqlite` (`DatabaseSync`, Node 22+). Single file `memory.db` (WAL). `InMemoryVectorStore` is used in tests.
- For `LanceDB`/`sqlite-vec`/`Qdrant`, implement `VectorStore` interface and inject via `new MemoryService({store: myStore})`.

## Project layout

```
CONTEXT.md              # ubiquitous language (Memory, Token Burning, etc.)
docs/adr/0001-0004.md
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
npm test            # vitest (13 tests: store, retrieval, api, entrypoint)
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
