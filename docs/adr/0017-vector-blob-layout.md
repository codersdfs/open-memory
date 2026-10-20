# ADR-0017: Vectors are float32 blobs, read in two phases

- **Status:** Accepted (2026-10-19) — measured on a single-partition probe with the real insert path; replaces the JSON-in-a-TEXT-column layout the store shipped with.
- **Options:** keep `embedding TEXT` (JSON) vs **`memory_vectors(memory_id, dim, vec BLOB, norm)` scanned by a JOIN** (chosen) vs `sqlite-vec` / an ANN index (ADR-0001 already keeps the extension out) vs a separate sidecar file.
- **Why not keep JSON:** three costs, all measured at 10k rows / 384 dims on this machine: the file was 113.9 MB (11,854 B/row — 6 KB of ASCII digits for 1.5 KB of floats), every search did `SELECT *` over the whole partition and `JSON.parse` on every row, and `vectorSearch` took 279 ms with a 10^5 projection of ~2.8 s / 1.1 GB. The store's whole premise is that recall runs inside an agent's turn; 2.8 s is not inside a turn.
- **Decision:** a row's vector lives in `memory_vectors` as `Float32Array` bytes (`packVector`) with its `dim` and precomputed L2 `norm`. `memory_vectors` has no secondary index — `memory_id` is the primary key and every access is by id or by a full scan that the JOIN drives.
- **Two-phase read:** `vectorSearch` first selects only `(id, vec, dim, norm)` from the JOIN — no text, no tags, no JSON — scores with `cosineFast` against a normalised query, sorts, slices to `limit`, and only then fetches the full rows for the survivors (`fetchByIds`, one `IN` query). The vectors already read during the scan are attached back onto those rows, so MMR and `&embedding=true` still see an embedding without a second visit.
- **`memoryFromRow` returns `embedding: []` on purpose.** Nothing on the hot path may assume a row carries its vector; `getById`, `list` and `attachVectors` are the three places that do pay for it.
- **Migration is a reverse join, not a version number:** `migrateVectors()` copies batches of 5000 rows where `embedding != ''` and no `memory_vectors` row exists, then blanks the old column. A crash mid-migration is resumable on the next open, and a row written by an older build is picked up the next time the file is opened. `PRAGMA user_version = 2` is set as a marker only; nothing branches on it.
- **Stale widths cannot poison a search:** the scan skips rows whose `dim` differs from the query's, so a partly re-embedded store degrades to "those rows do not match" instead of throwing.

## Measured (single namespace, 1100-char rows, real insert path)

| rows / dim | before `vectorSearch` | after | file before | file after |
|---|---|---|---|---|
| 2,000 / 384 | 45.2 ms | **12.4 ms** | 22.6 MB | **11.1 MB** |
| 10,000 / 384 | 279 ms | **64.7 ms** | 113.9 MB | **56 MB** |
| 4,000 / 2048 | 240.9 ms | **61.6 ms** | 91.7 MB | **47.7 MB** |

Extrapolated to 10^5 rows: 384 dims **~647 ms / 0.55 GB** (was ~2.8 s / 1.1 GB), 2048 dims **~1.5 s / 1.16 GB** (was ~6.0 s / 2.24 GB). The 2048-dim figure is still outside the 700 ms budget at 10^5 rows; that is an index problem, not a layout problem, and it is left to ADR-0019 (quantised shortlist + exact rescore, or IVF) rather than pretended away.

Migration of an existing JSON store: **335 rows in 51 ms** end-to-end `init()` on a copy of the live store; a synthetic 10k-row legacy file migrates in **1.03 s**, so ~10 s at 10^5 rows, once.

## Costs accepted

- **Two tables to keep in sync.** Every insert, supersede and `updateEmbedding` writes `memories` + `memory_terms` + `memory_vectors`; `insert`/`insertMany`/`updateEmbedding` do it inside one transaction, so a crash lands either all of a row or none of it.
- **`VACUUM` is required to give pages back** — see ADR-0018.
- **A vector no longer travels inside a row**, so any third-party code that read `memory.embedding` from a `list()`-shaped result must be told: `list` and `getById` still attach it, but the rows inside a search scan do not.
