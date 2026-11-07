# ADR-0018: One transaction per batch, and the delete half of soft delete

- **Status:** Accepted (2026-10-19) — the write-path half of the scale work; complements ADR-0017.
- **Options:** keep one `insert` per row (one connection, one commit each) vs **`insertMany` / `POST /memories/bulk` / `saveMany` behind one transaction and one embed batch** (chosen) vs a background write queue.
- **Why not a queue:** durability would move from SQLite's commit to the process's memory, and the failure mode — a crash loses writes an agent believes it made — is exactly what a memory system cannot afford. A transaction keeps the same promise and is 30 lines.

## The three entry points

1. **`SqliteVectorStore.insertMany(items)`** — one `BEGIN IMMEDIATE`, then per item the row, its `memory_terms` postings and its `memory_vectors` blob, then one `COMMIT`. On error it rolls back the whole batch: a half-import that reports success is how a re-run produces duplicates.
2. **`MemoryService.saveMany(inputs, { reconcile })`** — reconcile defaults to **off**. `save` runs a 5-neighbour vector search per write to decide insert/reinforce/supersede; doing that for 10k rows is 10k full scans on top of 10k commits, i.e. quadratic in the thing being optimised. A bulk import is new material by definition; a caller replaying history it already stored passes `reconcile: true`. Embeddings go through `embedBatch`, so a remote provider costs one round trip instead of one per row.
3. **`POST /memories/bulk`** — `{ items, reconcile? }`, capped at **5000** items per request (one transaction, one embed batch). A bad item fails the request with its `index` and writes nothing. `ai-memory import run --write` now calls `saveMany` per source instead of looping `save`.

## Soft delete only ever grew the store, so purge is the other half

Soft delete keeps a tombstone for audit (ADR-0006): the row, its text, its postings and its vector all stay. Nothing ever removed them, so the store had exactly one direction. On the real 335-row store, 36 tombstones were 10.7% of the file and 0 were ever purged. At 10^5 rows with a deletion rate, that is the difference between a file that plateaus and one that grows without bound.

- **`purgeDeleted({ olderThanMs })`** hard-deletes tombstones older than the cutoff, in chunks of 5000, deleting `memory_terms` and `memory_vectors` rows in the same transaction. It is deliberately **not** part of `prune`: `prune` has to stay reversible, `purgeDeleted` must not be.
- **`compact()`** runs `PRAGMA wal_checkpoint(TRUNCATE)` then `VACUUM` then another checkpoint, and reports the **footprint** (db + `-wal` + `-shm`), not `statSync(dbPath)`. There is no HTTP route for purge: it is destructive and stays in `ai-memory db compact --purge <days>`. `POST /compact` exists because compacting is not destructive, and it answers **501** for a store that cannot compact rather than pretending it reclaimed nothing.

## Costs accepted

- **`insertMany` holds the write lock for the whole batch.** Batches are capped at 5000 items, and a large import is a sequence of them; a concurrent writer waits on `busy_timeout` (5 s) instead of interleaving.
- **Reconcile is off by default in bulk mode.** Two identical rows can therefore be stored by a bulk import; that is the explicit trade for not being quadratic, and it is why the flag exists.
- **`VACUUM` rewrites the file** and briefly needs it to itself. The CLI refuses to route it through the daemon for that reason.

## Amendment (2026-11-07): the bulk door got a zero-cost lock

Two sentences of this record were reversed by the bulk gate (P1 of the memory-systems
research, `docs/research/memory-systems-notes-2026-11-07.md`):

- **"`saveMany` skips curation"** — it no longer does. The verdict is `curate()`
  (ADR-0040): pure regex, zero network, zero model calls, so the "deliberate act"
  excuse for leaving it out no longer holds, and an unfiltered bulk path was the door
  through which a 5,000-row import could put secrets back into the store. The old
  hostile-gate objection assumed a batch that dies on row 3; the gate now skips per
  row instead — rejected lines come back in `skipDetails` with their input index and
  advice, and the rest of the batch lands. This applies to the `{reconcile: true}`
  branch too: its old contract of dying on the first reject *after the earlier rows
  had each already committed* was the same hostile gate with a half-import welded to
  it. `{raw:true}` / `--no-curate` excuses every reject **except `secret` and except
  empty text** (ADR-0040 prefers the false kill there without exception) and skips
  both demotion ladders — the regex one and, on the `{reconcile: true}` path, the
  model write gate too (a raw caller should not pay a network call per row to be
  second-guessed anyway); `MEMORY_CURATE=off` remains the global switch.
- **"Two identical rows can therefore be stored by a bulk import"** (Costs accepted) —
  explicitly reversed, replacing the same trade. `memories.text_hash` is a derived
  column over `normalizeText(text)` — recomputed on every write that can change the
  text (`runInsert`, `updateEmbedding`) and backfilled once, ALTER-and-all, in the
  same transaction on first open (a crash rolls the whole migration back; NULL hashes
  only ever come from a foreign writer and read as "never seen"). `saveMany` folds
  exact duplicates within one partition — (namespace, project, type), the neighbour
  scope `reconcile` itself reads over, because the same sentence under two
  repositories is two facts with two lifetimes (ADR-0020) — and against readable live
  rows only: a row outside the population `list()` shows by default (tombstoned,
  archived or draft) is what no ordinary search returns, so it blocks no re-import
  (`store.findExistingHashes`). The cheap exact fold replaces the
  worst case of the quadratic trade; near-duplicates stay `reconcile`'s job, still
  opt-in.

The quadratic rationale for keeping `reconcile` off survives untouched — nothing the
amendment adds queries neighbours.
