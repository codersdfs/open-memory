# 0039 — An empty result reports the partitions it did not read

Date: 2026-10-26

Status: Accepted

Amends: ADR-0020 (the read fan-out across own + shared + legacy), ADR-0037 (an empty result explains itself)

## Context

A read fans out over a fixed set of partitions: the caller's own agent layer, the
shared layer, and the legacy `default:default` partition. Which partitions those are
is decided by *who is asking*, not by where the rows are. Every agent therefore owns
a private layer that no other agent reads.

The isolation is deliberate and stays. But ADR-0037 left a hole in it: the empty-result
diagnostics could only describe the partitions the read had already visited. A caller
asking as `pi` was told, truthfully, that `pi:frank` held nothing — while the same
user's `coding-agent:frank` partition held the answer. The message said "nothing was
stored for this scope", which is exactly the sentence that sends a caller off to
reword a query against a partition that will never contain the fact.

This was not hypothetical. Measured on the live store (2026-10-26):

| partition | rows | note |
| --- | --- | --- |
| `default:default` | 366 | legacy; every read includes it |
| `coding-agent:frank` | 4 | **invisible to a `pi` read** |
| `pi:frank` | 0 | what a `pi` read reports as "this scope" |

One of the four invisible rows is `The user lives in Tokyo.` A `pi` session asking
`Tokyo` gets zero results and, before this change, no hint that the fact exists one
layer over. The store was not missing the fact; the read scope simply did not cover
the partition holding it, and nothing in the response could say so.

The gap is structural, not a bug in the fan-out: widening the default read would
either (a) make every agent read every other agent's private layer, which is what the
layers exist to prevent, or (b) make the read scope depend on where the data happens
to be, so the same query returns different partitions on different days. Both were
rejected. The read scope stays as it is; what changes is that the *empty* result can
now tell the caller what it did not look at.

## Decision

`SearchDiagnostics` gains an optional `outside` field: the partitions belonging to the
same user that this read did **not** cover and that still hold rows matching the
search's own filters.

```ts
interface SearchDiagnostics {
  threshold: number;
  partitions: SearchPartitionCount[];   // searched, with row counts
  nearMisses: SearchNearMiss[];
  outside?: SearchPartitionCount[];     // not searched, still holding rows (ADR-0039)
}
```

Four rules govern it:

1. **Same user only.** `outside` is computed with `allPartitions(store)`, the same
   helper the CLI's `--all` uses, which filters by the resolved user id. A partition
   belonging to another user is never listed — the diagnostics must not become a
   cross-tenant enumeration.
2. **Empty partitions are omitted.** A partition with zero matching rows is not
   evidence of anything, and listing every partition the user has ever written to
   would turn a one-line explanation into an inventory.
3. **The search's own filters apply.** A row counts toward `outside` only if it would
   have matched the `type`/`status`/`project`/`kind`/`knowledge` filters the caller
   passed. `outside` answers "you would have found it there", not "there are rows
   somewhere".
4. **Absent, not empty, when unknowable.** If the store cannot enumerate its
   partitions (`distinctNamespaces` missing), the key is omitted entirely. An empty
   array would assert "nothing exists outside this scope", which is a claim the
   retriever cannot make without looking.

The renderers follow, in `src/core/retrieval/explain.ts` (`renderEmptySearch`), the pi
extension (`emptyMessage`), the MCP tools and the CLI — all four share the shape:

```
no memories matched
  searched: pi:frank (1 rows), shared:frank (0 rows), default:default (0 rows)
  outside this scope: coding-agent:frank (1 rows)
  → rows exist but none shared a term with this query: different words, not a lower threshold.
```

And when the scope itself is empty:

```
no memories matched
  searched: shared:frank (0 rows)
  outside this scope: coding-agent:frank (1 rows), pi:frank (1 rows)
  → nothing was stored in this scope, but 2 rows exist outside it: widen the scope to include them.
```

The `outside` tail **outranks** the existing three. When the scope holds nothing but
rows exist beside it, every in-scope diagnosis is true and useless at the same time:
"nothing was stored for this scope" is accurate, and it is the wrong thing to say,
because the caller reads it as "this fact was never recorded". The new branch fires
first so that sentence is never printed while a neighbouring partition can answer the
query.

`outside` is populated only when `memories.length === 0`, like the rest of
`diagnostics`: a non-empty response pays nothing for it.

## Consequences

- A caller whose fact is filed under another agent now learns that, and learns which
  partition to name (`scope:"all"`, or `agent:"coding-agent"`). The isolation stays
  exactly as strict — nothing becomes readable that was not readable before. Only the
  *knowledge that it exists* becomes available.
- The empty path costs one extra `distinctNamespaces()` query plus one row count per
  partition outside the scope. That is bounded by the number of partitions the user
  owns, and it runs only on a miss.
- `outside` deliberately reveals the *names and sizes* of a user's other partitions to
  a caller scoped to one of them. That is the intended disclosure — it is the same
  user's own data, and the partition names are already visible to `--all` — but it is
  a disclosure, and rule 1 is what keeps it from crossing tenants.
- The remaining gap is not addressed here: an agent still cannot *read* another
  agent's private layer without naming it. `outside` says the door exists and where it
  is; it does not open it.

## What this does not fix

- **Cross-agent reads stay opt-in.** `scope:"all"` and `agent:"..."` remain the only
  ways to read a sibling layer. Making the default read wider is the thing this ADR
  explicitly declines to do.
- **`outside` is not a search.** It reports row counts, not candidate texts. A caller
  who sees `coding-agent:frank (1 rows)` must still issue a second search with the
  wider scope; the diagnostics cannot inline the answer, because doing so would mean
  reading partitions the caller did not ask for.
- **Console UI.** The web console still renders its own empty state; it does not use
  `renderEmptySearch` and does not show `outside` yet.
