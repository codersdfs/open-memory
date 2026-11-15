# ADR-0045: A write history that survives the row, and two clocks

Date: 2026-11-08

Status: Accepted

Implements P6 of the memory-systems research plan (`docs/research/memory-systems-notes-2026-11-07.md` §3, review verdict: approved — the premise corrected from "add irreversible auditing" to "add history that does not die between processes", which is what this builds). Amends ADR-0011 (Stage C, partially), ADR-0015 (dates).

## Context

Four facts, each verified in the research pass:

- A supersede — the one action that retires a fact — left exactly one line of evidence: a `console.warn` when the decision was model-made (`src/core/memoryService.ts`, the reconcile path). Every other write was silent.
- `purgeDeleted` hard-deletes the row, its postings and its vector (`sqlite.ts`). Soft delete kept the row for audit; the hard pass removed the audit too.
- The date a fact became true lived only inside the text as an `(at:YYYY-MM-DD)` stamp (ADR-0015) — findable with `LIKE`, unusable as a timeline.
- ADR-0011's Stage C — "read-time expansion over supersede chains" — was never built; the only chain walk was the console's in-page `chainOf` (`ui/src/lib/supersede.ts`), which cannot see past one page of rows.

## Decision

**1. `memory_events` — append-only, written in the write's own transaction.** One table, both stores (the SQL one in `sqlite.ts`, an array mirror in `InMemoryVectorStore`):

```sql
CREATE TABLE memory_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id TEXT NOT NULL,
  event TEXT NOT NULL CHECK (event IN ('insert','reinforce','supersede','archive')),
  old_value TEXT, new_value TEXT, reason TEXT, model TEXT,
  at INTEGER NOT NULL
);
```

Shape follows mem0's history table (`id/memory_id/old_memory/new_memory/event`, verified at `bench/.venv-mem0/.../storage.py:108-119`), minus its `is_deleted` flag — this log is never deleted, so the flag would always read 0. What each write point records:

| event | old | new | reason | model |
|---|---|---|---|---|
| `insert` | NULL | the stored text | the row's `source` | NULL |
| `reinforce` | NULL | NULL — the text did not change | NULL | NULL |
| `supersede` | the replaced text | the successor's text | the reconcile reason (`refinement`, `model-refines`, `model-contradicts`, …) | the judge that answered (`jev`, or the injected test judge) |
| `archive` | the prior status | `archived` | the rule that did it (`decay:hotness`, `triage:<class>`) | NULL |

`reinforce` recording no values is a decision, not an omission: the reinforcement is a single UPDATE with no read-modify-write race (one fsync per search — the shape the whole retrieval path leans on), and reconstructing an "old" strength for the log would put a read back on that path and open the race. The event itself is the record of the retrieval. Every event commits **inside the transaction of the write it describes** — `insert`/`insertMany` (row + postings + vector + event), `reinforce` (a `SELECT` of the ids that will actually move, the UPDATE, the events), `supersede` (successor's insert **and** old row's invalidation **and** both events, one transaction — the previous two-call shape left a window where the successor existed and the old row was live with no history), `updateMeta` archive (prior status read inside the same transaction, so a re-archive records nothing and no event can claim a flip that did not happen).

**2. Purge deletes the row, never the history.** `purgeDeleted` removes `memory_terms`, `memory_vectors` and `memories` and does not touch `memory_events`; nothing in the codebase deletes from that table. A purged id still answers `history(id)` — which is the corrected premise from the review: not "irreversible", but "the story outlives the row it is about".

**3. Two clocks as columns, migrated in the single-transaction pattern.** `valid_at` (event time) is parsed from the row's own `(at:…)` stamp — last match wins, because a merged supersede row can carry two, and the one at the end is the writer's — and `invalid_at` (invalidation time) is stamped by the supersede's UPDATE, the same UPDATE that sets `is_deleted = 1`. Both migrations run through `runMigrationTxn` (ALTER + backfill in one `BEGIN IMMEDIATE`, the `text_hash`/`use_count` precedent): a crash rolls the column back and the next open re-runs the migration. Two honest-unknown rules in the backfills: a row whose text names no date keeps `valid_at` NULL, and a plain tombstone keeps `invalid_at` NULL — only superseded tombstones recover `invalid_at` (from their successor's `created_at`), because "removed" and "stopped being true" are different facts and the column records only the second one. Unlike `backfillTextHashes` (whose hash exists for every text, so every selected row leaves the set), the `valid_at` backfill can *select a row it then refuses to update*, and a 2026-11-08 review reproduced the consequence: a store holding stamp-shaped but non-numeric text — a literal `(at:YYYY-MM-DD)` template — hung `init()` forever inside the migration's write lock, because the original `LIKE '%(at:____-__-__)%'` pre-filter's `_` matches any character while the numeric regex refuses the row. Two independent guards now close it: the pre-filter demands the numeric shape (`GLOB` `[0-9]` classes) and a pass that updated nothing ends the loop — selected-but-rejected rows are exactly the "no match does not move" population, left NULL by contract (`tests/history.test.ts` opens a legacy db holding both shapes and asserts it opens clean).

**4. Visibility does not move.** `getActive` still reads only `is_deleted`; the tombstone flow (soft delete, restore-by-flag) is untouched; a forget writes no event and no `invalid_at`. What the supersede change adds is the missing half of ADR-0034/0035 discipline: the invalidation UPDATE, the supersede event and the successor's insert land in one transaction, and **both** ids go through `noteChange` after the commit — the old row left every decoded partition and the new one joined them, and skipping either noteChange is how the partition cache serves a dead row. `tests/history.test.ts` warms the cache before the supersede and searches after, to pin exactly that.

**5. Stage C, chain half: one pointer line, never a chain in the pool.** A search hit whose `supersedesId` is non-empty may carry one line — `前身(YYYY-MM-DD): <≤80 chars of the predecessor>` — dated from the predecessor's own `valid_at` (falling back to `created_at`). Two rules it inherits from the budget's projection (`tokens.ts`): it spends only the space nothing else could have used (the budget leftover after every kept row has taken its whole text; the summary clips to fit, and below a stub threshold it is dropped), and it adds no row to the candidate pool and no slot to `k`. The second rule is the PRF lesson, measured: ADR-0028's second pass merged reachable rows into the pool and the fixed budget got crowded — evidence-any fell 76% → 72% — which is why PRF ships off by default. A predecessor is, by definition, the row just proven out of date; giving it a line of leftover space is the most it can be worth. The full chain stays behind the explicit walk: `GET /memories/:id?drill=1` and `ai-memory get <id> --history`, which return `{memory, ancestors, successors, events}` and, for a purged id, `{memory: null, events}` — the walk is `MemoryService.drill`, one indexed `successorsOf` query per level where the store has the capability (both built-ins do), a partition sweep where it does not (the `listProjects` trade: correct at any size, only slow).

## Alternatives considered

- **Full bi-temporal event sourcing** (every mutation an event, rows derived by replay): the store is a search index, not a ledger; the four write points cover every mutation that changes what a row means, and replaying 10^5 rows per search is a cost nobody asked for. The `text_hash`/`use_count` amendments set the additive-column precedent this follows.
- **Recording the judge's raw answer** on `supersede`: the reconciler already distilled it into `reason`; two copies drift.
- **Auto-expanding chains in search** (ADR-0011 Stage C as originally imagined): rejected above — the PRF measurement is direct evidence against it, and the pointer plus explicit drill covers the audit need without spending budget the row earned.

## What this deliberately does not do

- No FTS or index over `memory_events` — one id-indexed seek answers the only question asked ("what happened to this id"); a query surface over all events does not exist yet and a partial index guessing at it would be waste.
- No retention cap on events: they are one row per write point, `reinforce` being the common one — an app that reads a memory a million times holds a million reinforce rows. Honest growth, revisit if it is ever measured as a problem.
- No console/UI change: the wire shapes are additive (`?drill=1`, the new `Memory` fields ride along), the console keeps its in-page chain walk.
- No restore semantics change: restoring a superseded row revives it with its `invalid_at` intact — the column is history, not state.

## Consequences

- `VectorStore` gains two optional capabilities (`history`, `successorsOf`) and two optional write parameters (`supersede(…, meta)`, `updateMeta(…, meta)`) — a third-party store written against v0.3 keeps compiling and `drill` degrades to the sweep fallback without events.
- `Memory` gains `validAt`/`invalidAt` (NULL on stores/rows that predate the columns); the wire adds both fields everywhere a memory is serialized, plus the `drill` envelope.
- Every supersede now lands one transaction instead of two — the two-call window (successor live, old row live, no event) is closed by construction. On SQLite that is the single `BEGIN IMMEDIATE`; on the in-memory store it is the supersede body containing **no `await`** — an async method runs synchronously to its first await, so the whole block is atomic on the runtime. The 2026-11-09 final review caught the earlier in-memory shape (`await this.insert(…)` first, then the old-row invalidation) as a real window at that await boundary; `tests/history.test.ts` pins the fix by reading the map synchronously at the call's return.

## Tests

`tests/history.test.ts` (16): the four write points land and are readable on both stores; a bulk insert writes one event per row; a tombstoned id earns no reinforce event; purge keeps the events of purged ids (byte-identical before/after); the `valid_at`/`invalid_at` migration on a pre-P6 database (dated rows stamped, undated NULL, superseded tombstones recover `invalid_at` from their successor), including the crash-rolls-back-and-re-runs property; `drill` walks a three-row chain both directions on both stores and answers purged ids; over HTTP, `?drill=1` returns the chain while a bare GET stays the row; the search pointer appears only when budget remains, clips to fit, never displaces a row and never breaks the cap; a plain forget leaves `invalid_at` NULL and writes no event.
