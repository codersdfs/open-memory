# ADR-0020: A project is a dimension, not a partition

- **Status:** Accepted (2026-10-19) — the first piece of direction B ("memory that survives a repository's lifetime"), after direction A made the store hold 10^5 rows.
- **Options:** put the repository in `namespace` (`repo:memory:<agent>:<user>`) vs **add a `project` column and keep `namespace` for *who*** (chosen) vs one database per project vs derive the project from tags (`project:foo`).
- **Why not the namespace:** the namespace is the isolation key and the read fan-out (`own + shared + default:default`, `--all`) is built on it. Encoding a repository into it would either fork the fan-out (a repository's rows stop being visible from the shared layer) or make every agent need to know the repository to read anything. The two questions are orthogonal: *who wrote this* and *which effort is it about*. A convention learned by one agent in one repository must reach the next agent that opens the same repository — that is the whole point — and it must not reach a different repository.
- **Why not one database per project:** the shared layer, the brief, and one search across "this project plus what I already know" would each need a merge layer, and cross-repository reads are exactly where a project dimension earns its keep.
- **Why not tags:** `project:` would be a facet like any other; filtering by it would still be a full scan with a `LIKE '%project:foo%'`, and `tags` is a list with an 8-entry budget shared with entities and topics. A first-class column gets an index and a `WHERE`.
- **Resolution order, explicit first:** an explicit argument → `MEMORY_PROJECT`/`AI_MEMORY_PROJECT` → the git work-tree root of the process's directory, slugged → `null`. The git lookup is memoized per directory and capped at 2 s; "not a checkout" is an answer (`null`), not an error. A write with no project is legitimate — a personal preference does not belong to a repository — and it is exactly what every row written before this ADR is.
- **The slug, not the path, is the key:** paths move (a clone lands elsewhere), a slug is what a human says out loud, and two agents in the same checkout must derive the same string without coordinating or the brief splits in half. `projectSlug` is deterministic: lowercase, `[a-z0-9._-]`, everything else collapsed to `-`, capped at 40 chars.
- **Reconcile stays inside one project.** The neighbour query that decides insert/reinforce/supersede is filtered by project, because the same sentence filed under two repositories is two facts with two lifetimes; reinforcing one into the other would delete the loser from the brief of the project that needed it. This was caught by a test that saved identical text under two projects and got one row.

## Consequences

- `memories.project TEXT` (nullable) plus `idx_memories_project(project, created_at)` and `idx_memories_project_kind(project, kind, created_at)`.
- `list`, `vectorSearch`, `lexicalCandidates`, `cosineSpread`, `prune` and the lexical `MemoryFilter` accept `project`; `undefined` means "no filter" and `null` means "rows with no project", so the two cannot be confused.
- Unscoped rows (`project = null`) stay reachable: a search or brief without a project filter sees them, which is what keeps pre-ADR memories useful.
- `stats` reports `byProject`, with unscoped rows under `(unscoped)`.
