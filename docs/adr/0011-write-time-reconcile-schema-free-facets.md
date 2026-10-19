# ADR-0011: Write-time reconcile over schema-free facets

- **Status:** Accepted (stage A, 2026-10-18) — spec: `docs/superpowers/specs/2026-10-18-write-time-reconcile-design.md`, plan: `docs/superpowers/plans/2026-10-18-write-time-reconcile.md`
- **Options:** do nothing (`save` keeps exact-text dedup) vs **schema v2 with an edges table and a background consolidator** vs **reconcile at write time using the columns that already exist** (chosen).
- **Why not doing nothing:** `save()` folded a memory only when the text was byte-identical after trimming and lowercasing. Restating one fact five ways produced five live rows that all answer a fifth of a question, and nothing ever notices that the new claim contradicts the old one. The store measured this on itself: 70 chunk-shaped rows from one benchmark conversation (`bench/REPORT.md`).
- **Why not schema v2:** an edges table means a migration, a write path for edges, an invalidation story, and a second definition of "related" that the existing `supersedes_id` chain already covers for the one relation that matters (this replaced that). The published package then has to migrate every user's `memory.db` on upgrade. Stage B (an offline consolidator) can still add it later; nothing here blocks that.
- **Decision:** a pure `reconcile()` (`src/core/write/reconciler.ts`) receives the five nearest neighbours `save()` already fetched, plus an optional judge, and returns `insert` / `reinforce` / `supersede`. Structure is written into `tags` under a controlled vocabulary (`entity:`, `topic:`, `path:`) and a successor inherits the `entity:`/`topic:` facets of the row it replaced.

## Why auto-supersede is safe

- A supersede is a **soft delete plus a link**: the old row keeps its text, its tags and its id, `is_deleted = 1`, and the new row's `supersedes_id` points at it. `ai-memory restore <id>` (or the console) reads the tombstone back, so nothing is unrecoverable. MCP `memory_get` deliberately does not: it answers an agent, and a tombstone must not return as context.
- `pin = 1` is never auto-superseded. Pin is the one explicit signal that says "keep this".
- The merger is capped: past 600 chars, or when the old text is more than twice the new text, the row stores the new text only and the chain keeps the old one.
- A model answer is acted on only when the top label reaches 0.5 **and** leads the runner-up by `MEMORY_RECONCILE_MARGIN` (0.15). Every other answer, a timeout, a 401 and an unconfigured judge all fall through to `insert`. No failure mode drops a write.

## Why `episodic` and `source=extractor` are exempt

`episodic` memories are time-bound events: two similar sentences are two events, and folding them destroys exactly the temporal signal the benchmark scores worst on (temporal 35%, `bench/REPORT.md`). Auto-extracted text (`source: "extractor"`) is half a conversation, sliced by a sentence splitter; it may reinforce an exact duplicate but may never delete an agent-authored memory. Deleting data stays reserved for explicit `memory_remember`.

## Why the gate is lexical by default

`HashEmbeddingProvider` returns ~0.9 cosine to everything, so a cosine floor admits every neighbour and folds unrelated memories. On the default install the gate is token overlap (with a containment test, so "the same fact, longer" still counts); the cosine gate applies only when a real provider is configured (`MEMORY_RECONCILE_COS`, 0.85).

## Deferred

- **Stage B:** an offline `consolidate` pass for rows written before this existed. The write path cannot clean history it never saw.
- **Stage C:** read-time expansion over supersede chains and shared facets — the lever for multi-hop, and the only stage that should move a benchmark number.
- LLM entity extraction (costs a call per write for what four regexes already surface).
- FTS5 / ANN indexing. Brute-force over one partition is still fast at this corpus size.

## Rollback

`MEMORY_RECONCILE=off` restores the previous path exactly (exact-text dedup, no supersede), proven by `tests/save-reconcile.test.ts`. No migration and no data rollback is needed: facets apply to new writes only and every supersede is a soft delete.
