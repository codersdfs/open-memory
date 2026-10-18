# Write-time reconcile — design spec

- **Status:** draft, awaiting approval. No code written yet.
- **Date:** 2026-10-18
- **Scope:** stage **A only** — the write path. Read-time structure assembly (C) and offline consolidation (B) are deliberately out of scope, and stay open as later stages.
- **Hard constraint:** no schema change (no new table, no new column, no migration). `memories` stays as it is.
- **Hard constraint:** published as the `open-memory` npm package — existing DBs and MCP tool names must keep working unchanged.

## 1. Problem, with evidence

Two user-reported pains, both traceable to specific lines:

**P1 — writes are noise, the store gets dirtier over time.**

- `src/core/memoryService.ts` `save()` is the only write gate: it keeps a memory if `vectorScore > 0.92` **and** `text.trim().toLowerCase()` is *exactly* equal (`dedupThreshold = 0.92`). Anything reworded is a new row. Restating one fact five ways yields five active memories that all answer half the question.
- There is no merge, no consolidation, and no contradiction handling. `store.supersede()` exists (`src/core/store/sqlite.ts:350`) but inserts a new row then soft-deletes the old one — only when a caller voluntarily passes `supersedesId`.
- The write path never reads old memories for judgement; importance/strength reinforcement (`reinforce()`) only runs on the *read* side.
- `bench/REPORT.md` shows the shape of it: one LoCoMo conversation was ingested as **70** ~1.2k-char episodic chunks. Those are slices, not memories. Multi-hop answers then have to be reassembled by the reader from four near-duplicate chunks.

**P2 — no structure, only isolated sentences.**

- The only edge in the store is `supersedes_id`: single direction, only ever written by hand.
- `tags` is a free-form string array with no controlled vocabulary and no entity resolution.
- The `/graph` view is derived from `wiki/*.md` files on disk (`docs/DESIGN-node-graph.md`), so the *graph and the memories table never meet*.
- Retrieval is flat: brute-force JSON-vector scan inside one namespace (`sqlite.ts:292-302`), plus in-JS BM25 over the over-fetched pool (`retrieval/bm25.ts`). A query cannot say "all memories about this entity", "this fact's version chain", or "that time window".
- The benchmark's two weakest categories are exactly the structural ones: **multi-hop 38%**, **temporal 35%** (`bench/REPORT.md`).

**P3 — the layer that should own write policy does not exist.**

- `MemoryService` owns store + embedder + retriever + extractor + scope, and write policy is buried inside `save()`. Any change to write quality means editing the class everything else also imports.

## 2. Decision summary

| # | Decision | Why |
|---|---|---|
| D1 | New module `src/core/write/reconciler.ts` exporting a **pure decision function**; `MemoryService` keeps orchestration and delegates policy to it. | Write policy becomes testable without SQLite, a network, or an embedder. Fixes P3 with one file. |
| D2 | Reuse the neighbour query `save()` **already runs** (`vectorSearch` top-5, same namespace + type). Reconciler adds **zero** extra queries. | The cost is already paid today for dedup; the information is thrown away. |
| D3 | The near-hit **gate is lexical by default**, with cosine only when a real embedder is in use. | `HashEmbeddingProvider` returns ~0.9 cosine to *everything* (`retrieval/hybrid.ts:10-14`), so a cosine gate is meaningless on a default install. A gate that silently does nothing on the default config is worse than no gate. |
| D4 | **Rules first, model only on an undecided near-hit.** One jev call maximum per save, fail-open, never on a cold miss. | Matches the existing judge pattern (`judgment/judge.ts`), keeps the common case at 0 extra latency. |
| D5 | Contradiction and refinement **auto-supersede** the old row, and the new row carries a **merged text** (see 4.3). Old row soft-deletes, `supersedes_id` links the chain. | User decision. Soft delete = recoverable and auditable; the chain is the version history. |
| D6 | **`episodic` is never superseded.** Episodic memories are time-bound events; two similar-sounding ones are two events. Episodic only gets exact-duplicate reinforcement. | Protects temporal reasoning (already the weakest bench category) and protects chunk-style ingest (LoCoMo) from being eaten. |
| D7 | Facets live in `tags` under a controlled prefix vocabulary, normalised on write, inherited by a successor. | Structure without a schema: `entity:` / `topic:` / `path:` are queryable today via `search` + `list`, and give stage C something to expand on. |
| D8 | Every new knob is env-only, read through `runtimeEnv()`, and `MEMORY_RECONCILE=off` restores today's path exactly. **Deviation from the first draft:** they do *not* join `SETTING_KEYS`. | Every existing tuning knob (`MEMORY_VECTOR_WEIGHT`, `MEMORY_SEMANTIC_MARGIN`) is env-only and the console has never owned one; adding four numeric knobs to the console's writable list buys a UI nobody asked for and a settings test to maintain. Register them when a console card exists. |
| D9 | `save()` keeps its `Promise<Memory>` contract; a new `saveDetailed()` returns the decision. The MCP `memory_remember` response states what happened. **No new persisted counters.** | Backward compatible for API/CLI callers; the agent needs to know its write was folded, not stored. |
| D10 | Writes with `source = "extractor"` get **one** privilege: exact-duplicate reinforcement. They never supersede, and they never trigger a model call. | Auto-sliced sentences are half-context. Giving them the power to delete an agent-authored conclusion trades a clean store for a wrong one. Deleting data stays reserved for explicit `memory_remember`. |

## 3. Write flow

```
MemoryService.saveDetailed(input)
  1. resolve namespace + scope            (unchanged)
  2. embed text                           (unchanged, 1 call)
  3. neighbours = store.vectorSearch(top-5, same namespace+type, active only)
                                          (already happens today)
  4. facets  = normaliseFacets(input.tags) + deriveFacets(text)
  5. decision = reconcile({ candidate, neighbours, embedderKind, judge })
     ├─ "insert"     -> store.insert()
     ├─ "reinforce"  -> store.reinforce([old.id]); return old       (existing row wins)
     └─ "supersede"  -> text = mergeText(old.text, newText)   (4.3)
                          re-embed only when text != newText
                          store.supersede(old.id, {...tags inherited, text})
  6. return { memory, decision, reason, oldId? }
```

`save()` = `(await saveDetailed(input)).memory`. `extractAndSave()` switches to `saveDetailed()` and only logs decisions.

## 4. Decision table

Inputs per neighbour: `vectorScore`, `lexical` (see 4.1), `type`, `pin`, `namespace`.

**Gate (near-hit).** A neighbour participates only if:

- `lexical >= RECONCILE_LEX` (default `0.80`), **or**
- embedder is not `hash` **and** `vectorScore >= RECONCILE_COS` (default `0.85`).

Best neighbour only. Never act on two neighbours in one write — one write, one supersede.

| Case | Condition | Decision |
|---|---|---|
| R1 exact duplicate | normalised text equal (`trim`, collapse whitespace, strip trailing `.!?`) | `reinforce` — bump the existing row, return it. Identical to today's behaviour. |
| R2 refinement (rule) | type `semantic`/`procedural`, old tokens ⊆ new tokens, and `len(new) - len(old) <= 40%` | `supersede` — new row, old soft-deleted, tags inherited. |
| R3 episodic | type `episodic` | `insert` unless R1. No model call. |
| R4 needs judgement | gate passed, not R1/R2/R3, type `semantic`/`procedural`, `old.pin = 0`, jev available | one `jevRelation()` call → see 4.2 |
| R5 anything else | no gate hit, or model unavailable, or `old.pin = 1` | `insert` |

Guards, all mandatory: same `namespace` only (dedup is per partition, unchanged); `old.pin = 1` is never auto-superseded; `episodic` never superseded; `source = "extractor"` may only reach R1 (D10); a failed model call **always** falls through to `insert` (never drop a write).

### 4.1 lexical score

`lexical = |A ∩ B| / |A ∪ B|` over lowercased word tokens, stopwords removed, CJK handled by character bigrams (same reasoning as the retrieval floor divergence: a CJK sentence must not score 0 by construction). Pure function, no dependency.

### 4.2 `jevRelation(old, new)`

One HTTP call, no new protocol. `systemOneBody()` in `judgment/judge.ts` is currently hardcoded to the `keep` question; extract the POST loop into `systemOneCall(text, questions, opts)` and express `keep` through it. Then:

```
state: "OLD: <old text>\nNEW: <new text>"
questions: { duplicate|refines|contradicts }   // type: noul, one question each
```

Pick the argmax **only if** `top >= 0.5` **and** `top - second >= 0.15`; otherwise `null` (→ `insert`). `duplicate` → `reinforce`, `refines`/`contradicts` → `supersede`. The margin matters: an unconfident model that deletes a memory is the one failure mode this feature cannot afford.

### 4.3 merged text

`mergeText(old, new)` — pure, no model:

1. Tokenise both. If every old token is already present in the new text, **nothing is lost**: merged = `new` (tag inheritance still happens).
2. Otherwise merged = `` `${new} (previously: ${old})` `` — the earlier claim travels with the row that replaced it, marked as earlier, so a reader can tell which half is current.
3. Cap: if merged exceeds 600 chars, or 2x the new text, merge is abandoned — text = `new`, and the old text stays recoverable through the soft-deleted row in the chain. A merge that triples a memory's token cost is not worth the detail.
4. A merge that changed the text requires **one extra embed call** at save time. Cold misses and pure duplicates still cost exactly one embed, as today.

The merge marker is ASCII (`previously:`) on purpose: the corpus is bilingual and this string must survive tokenisation as a plain signal, not a locale-dependent phrase.

## 5. Facets (structure without a schema)

`src/core/write/facets.ts`, two sources, no model:

1. **Normalise what the caller sent.** Allowed prefixes: `entity:`, `topic:`, `path:`. Value lowercased, trimmed, spaces → `-`, max 40 chars. Dedupe. Cap total at 8. Tags without a recognised prefix are kept verbatim (backward compatible) but do not count toward structure.
2. **Derive from text, conservatively.** Regex only: backticked identifiers and `CamelCase`/`snake_case` symbols → `entity:`; path-like tokens (`a/b/c`, `C:\\...`) → `path:`; nothing else. Cap 5 derived, skip tokens seen in >10% of the partition? No — that needs a scan. Skip generic tokens from a small built-in stoplist.

A successor inherits the superseded row's `entity:`/`topic:` facets that the new text does not itself produce. That inheritance is what makes a version chain readable: the entity tag survives every rewrite, so "all versions of this fact" is one tag query.

**Deferred on purpose:** LLM entity extraction. It costs a call per write and duplicates what the reconciler's one call already sees. Add only if the derived facets measurably fail to cluster.

## 6. Config

| Key | Default | Meaning |
|---|---|---|
| `MEMORY_RECONCILE` | `on` | `off` reverts to today's exact-text dedup, byte for byte. |
| `MEMORY_RECONCILE_LEX` | `0.80` | Lexical gate for a near-hit. |
| `MEMORY_RECONCILE_COS` | `0.85` | Cosine gate, ignored when the embedder is `hash`. |
| `MEMORY_RECONCILE_MARGIN` | `0.15` | Confidence margin required from the relation model. |

All four join `SETTING_KEYS` so the console can write them, and all four are read per call through `runtimeEnv()` (a saved value applies to the next write, no restart).

## 7. Failure modes and ceilings

- **No jev key / jev down** → rules only. Exact duplicates and strict refinements still fold; paraphrased contradictions insert. Documented, and the `memory_stats`-facing text says which mode is active.
- **Hash embedder** → cosine gate disabled by design (D3). Lexical only. A fully paraphrased duplicate inserts. This is the honest ceiling of a 384-d bucket embedder; the README already says so.
- **Concurrency.** Two agents writing the same fact at the same instant both see an empty neighbour set and both insert. No unique index is available without a schema change; the sweeper for this class of mess is stage B (offline consolidate). `// ponytail: last-write-wins race, B sweeps it`.
- **Model rejects a refinement that carried information.** The old row is soft-deleted, not destroyed: it stays in the chain and `memory_get` still reads it. Recall is recoverable; a *wrong* memory that was never folded is not.
- **Write latency.** +0 ms on a cold miss, +1 HTTP round trip (≤20 s timeout, 1 retry) on a near-hit. The retry budget comes from `judge.ts` unchanged. If this ever hurts, the gate is the knob, not the timeout.

## 8. Compatibility, rollback, migration

- **No migration.** Existing rows are untouched; new columns none. Facets apply to new writes only.
- **Rollback** is one env var: `MEMORY_RECONCILE=off` restores today's path exactly. No data rollback needed — supersedes are soft deletes, restorable with `memory_get` + `updateMeta({isDeleted:0})`.
- **MCP contract:** tool names, schemas and `memory_remember` args are unchanged. Only the response text gains one line naming the decision.
- **Acceptance for stage A does not include bench re-runs**, but a pre-release run is required (see 9.5).

## 9. Acceptance

1. `tests/write-reconciler.test.ts` — pure decision tests, injected embedder/judge, no network: R1/R2/R3/R4/R5 each asserted once.
2. `tests/save-reconcile.test.ts` — through `MemoryService` with `InMemoryVectorStore`: three restatements of one fact leave **1** active row; a contradiction leaves 1 active + 1 soft-deleted with `supersedes_id` set and tags inherited; two unrelated facts sharing words leave **2** active rows.
3. Behavioral probe by hand: `ai-memory remember` three times, then `ai-memory list` and `ai-memory get <old-id>` must show the chain.
4. Episodic protection: ingest 5 chunk-shaped texts that share vocabulary → row count exactly 5 (no supersede).
5. Extractor privilege (D10): five chunk-shaped texts sharing vocabulary, all with `source: "extractor"` → 5 active rows, 0 supersedes, 0 model calls.
6. Merge cap: a contradicting pair whose merged text would exceed 600 chars → row stores the new text only, old row still soft-deleted in the chain.
7. Pre-release only: re-run `bench/run-locomo.mjs` on `conv-26`; **single-hop must not drop below the recorded 66%** and multi-hop must not regress. If it does, the gate is too loose on chunks — tighten `RECONCILE_LEX` before shipping.

## 10. Stages (each independently shippable)

| Stage | Content | Ships |
|---|---|---|
| **S1** | `facets.ts` + normalisation + derivation + tests. Tags change, decisions do not. | safe, no behaviour risk |
| **S2** | `reconciler.ts` rules R1/R2/R3/R5 (no model), wired into `saveDetailed()`, `MEMORY_RECONCILE` knob, tool response line. | the actual dedup win |
| **S3** | `systemOneCall` refactor, `jevRelation`, R4 + guards + margin, `MEMORY_RECONCILE_MARGIN`. | contradiction handling |
| **S4** | ADR-0011, README section, CHANGELOG, bench re-run. | release |

## 11. ADR-0011 outline

`0011-write-time-reconcile-schema-free-facets.md`: options considered (do nothing / schema v2 with edges table / reconcile over existing fields), why auto-supersede is safe (soft delete + chain), why `episodic` is exempt, why the gate is lexical under the hash embedder, what is explicitly deferred (B, C, LLM entity extraction, ANN/FTS index).

## 12. Non-goals

No new table or column. No FTS5, no ANN index, no embeddings change. No background daemon job. No LLM on every write. No automatic entity extraction. No change to retrieval scoring. No change to `memory_search`'s returned shape.

## 13. Decisions taken (2026-10-18)

1. **Merge on supersede**, yes — with the 4.3 rule: append the old claim only when it adds information the new text does not already carry, and abandon the merge past 600 chars. A contradiction therefore reads as one row whose second half is explicitly labelled `previously:`.
2. **`extractor` writes cannot supersede** and cannot call the model (D10). They participate in exact-duplicate reinforcement only. Rationale: a half-context sentence must not be able to delete an explicit memory.
3. **`session:` is dropped from the facet vocabulary.** No caller can supply a session id today, so the prefix would be a permanently empty convention. Add it back in the same commit that teaches `memory_remember` a `session` argument.

Remaining open: none blocking S1 and S2. S3 needs a jev key in the environment it is tested against.
