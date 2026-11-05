# 0037 — Explain an empty search

Date: 2026-10-25
Status: Accepted
Amends: ADR-0020 (the read fan-out across own + shared + legacy), ADR-0027 (CJK relevance by coverage)

## Context

An empty result was a dead end. `search` returned `{ memories: [] }` and nothing else:
no count, no threshold, no evidence that the store had been consulted at all. The
caller could not tell three very different situations apart.

1. **The partition is empty.** Nothing was ever written where the tool looked.
2. **The partition holds rows, but the tool looked at the wrong one.** The tool
   extension hardcodes a single partition (`default:default`); a fact stored under any
   other agent's namespace is invisible no matter how the question is worded. This is
   the failure the store has already been bitten by once — the CLI answered "no
   memories matched" for data that was sitting in a partition nobody named — and the
   fix then was to make the *partition* visible, not to make the emptiness visible.
3. **The rows are there and the wording missed the gate.** The relevance gate is a
   floor (0.72 by default, plus the coverage floor, the semantic-top admission and
   pin), and it is deliberately allowed to return nothing: a query the store cannot
   answer should return nothing rather than the least-bad row.

All three rendered identically. That is the most expensive failure this tool can
have, because the only information the caller has is "empty", and the only move an
agent knows from "empty" is **retry with different words**. The retry cannot work for
cases 1 and 2, and for case 3 it is a guess about a number it was never shown.

Observed on a real session: one question cost **14 tool calls**, and the **first 6**
were re-tries of reworded queries against the same store. The agent was not confused
about the task; it was searching for a signal the tool refused to give it.

## Decision

1. **Diagnostics ride on the empty result only.** `SearchResult.diagnostics` is
   populated **only when `memories.length === 0`** — the key is absent otherwise, not
   `undefined`. The happy path pays nothing, because a response's whole purpose is a
   token budget and a caller that got an answer has nothing to explain. The test that
   asserts `"diagnostics" in r === false` is the one that protects that budget.
2. **The gate reports both sides.** `searchOne` returns
   `{ kept, rejected, threshold }` instead of `Scored[]`. The predicate is unchanged —
   the same expression decides which rows pass — but a rejected row is kept instead of
   discarded, carrying the relevance number the gate compared. `rejected` is captured
   *at the gate*, next to `relevanceOf(s)`, so the explanation reports the number that
   was actually used rather than a downstream recomputation of it.
3. **Counts come from `list({ limit: 1, withVectors: false })`, on the empty path
   only.** `total` is the count of rows matching the search's own filters (type,
   status, includeArchived/includeDraft, project, kind, knowledge) — not the whole
   partition, because "your filter excluded everything" and "the partition is empty"
   are different answers. `limit: 1` keeps it from reading rows it does not need, and
   `withVectors: false` keeps it from decoding 384 floats per partition to obtain a
   count. It is an extra query, which is exactly why it is not on the happy path.
4. **Two empty paths, one explanation.** The early return (`scored.length === 0`) and
   the final `memories.length === 0` both call `explainEmpty`. The first covers
   "nothing was even a candidate" and "everything was a candidate and lost"; the
   second covers "the gate let rows through but the budget or `k` emptied the answer".
   All three are empty results a caller cannot explain, and `nearMisses` being empty is
   what distinguishes the first from the others.
5. **Near misses are the best rejected rows, five at most, best first.** Sorted by
   `relevance` descending, ties keeping partition order and then the gate's own order,
   so the same search explains itself the same way twice — a diagnostic that reshuffles
   between retries is worse than none. Text is the **stored** text clipped to ~200
   characters, not the budget's projection: a rejected row never reached the budget, so
   there is no projection to report, and the caller is being shown what *nearly*
   matched.
6. **`relevance` is the gate's own number.** `Math.max(bm25, vectorWeight > 0 ?
   vector : 0)`, captured where it is computed. A rejected row means none of the five
   admissions held: not `relevance >= threshold`, not `coverage >= COVERAGE_FLOOR`, not
   `score >= threshold`, not the partition's semantic top, not a pin.

## Consequences

The tool call now answers the question the caller was asking implicitly. An empty
result says either *"this partition holds 0 rows"* — stop rewording, the fact is not
here, and the partition is the problem — or *"this partition holds 412 rows and the
best of them scored 0.41 against a 0.72 gate"* — the wording was close, here are the
five nearest things the store does hold. Those are actionable in different directions,
which is the whole point.

What it costs:

- **One `list` per partition, on the empty path.** Two partitions that both miss is two
  extra queries on a search that already ran a vector scan and a lexical scan over each.
- **A `Scored[]` per rejected candidate, held until the merge.** The rows were already
  scored; this is a reference and one float each, not a second pass.
- **Up to 5 × 200 characters on an empty response.** An empty response carries no
  memories, so it has the whole budget free.

What it does not fix:

- **The hardcoded partition.** Diagnostics make the wrong-partition case *visible*
  ("`default:default` holds 3 rows"), they do not make the fact findable. That is a
  scope-resolution change, not a diagnostics one. *(Amended by
  [ADR-0039](0039-an-empty-result-reports-the-partitions-it-did-not-read.md): the claim
  was half wrong. Diagnostics cannot make a sibling layer readable — that is still a
  scope decision — but they can report the partitions the read never covered, which is
  what makes "your fact is one layer over" sayable without widening the read. The
  original claim assumed diagnostics could only describe what had already been
  visited.)*
- **A projection of what the budget would have produced.** Not required, and it would
  mean running the projection for rows that were never going to be shown.
- **The console UI.** `GET /memories/search` already returns the whole `SearchResult`
  and `stripEmbedding` removes only `embedding`, so the field reaches the wire
  unchanged; the browser console still renders an empty list as an empty list. The
  measured 14-call session was against the tool's structured payload, so the text
  surfaces came first.

## Amendment: one renderer for every text surface

The decision above left rendering to a follow-up. Writing that follow-up found the same
defect in **four** places, not one — the CLI (`renderMemories`), the MCP in-process
renderer (`renderSearch` in `src/mcp/tools.ts`), the MCP daemon path (`callViaDaemon` in
`src/mcp/server.ts`) and the pi extension (`emptyMessage` in `auto-memory.ts`). Four
copies of "no memories matched" is four chances to drift, so the explanation moved into
one function, `renderEmptySearch` in `src/core/retrieval/explain.ts`, which all four now
call. It keeps `no memories matched` as its first line so callers that match on that
string keep working, and returns that bare line when `diagnostics` is absent — an
extension may be talking to a daemon older than this record.

Two details are worth pinning down, because they were decisions rather than accidents:

- **The last line is the whole point, and there are three of them** — one per correct
  next move, because there are three different reasons a search comes back empty:
  - every searched partition reports `total: 0` → `nothing was stored for this scope.`
    The fact is not here; stop rewording.
  - rows exist but no row is even a candidate → `rows exist but none shared a term with
    this query: different words, not a lower threshold`. Nothing was rejected by the
    gate here, so lowering it cannot change the answer.
  - rows exist and the gate rejected them → `rows exist but none matched: retry with
    threshold 0.52`. This is the only case where a number is the right advice.
- **The suggested threshold is `max(0.05, threshold - 0.2)`.** Low enough to admit a
  weak match, floored so it never reaches zero — a threshold of 0 turns the relevance
  gate off entirely and would return the least-bad row for any query, which is the
  behaviour this whole record exists to prevent.

The third tail was added after the first version shipped with only two, and the case
that exposed it is the reason it exists: a query sharing no term with any of the 363
rows in `default:default` came back with `retry with threshold 0.7`. No threshold can
fix that query — the rows never became candidates, so the gate never ran — and the
advice pointed at the one lever that does nothing. `nearMisses.length === 0` is exactly
the evidence that distinguishes the two "rows exist" cases, which is why it is the
condition for the new branch rather than a heuristic on the score.

Measured against a daemon running this code, a query whose words share nothing with a
2-row partition reports `searched: default:default (2 rows)` and no near misses (a row
with no shared term is not a candidate at all — correctly so); a query sharing one word
reports `closest 1 below 0.9: 0.13` with the row and its text. All three tails were
verified end to end through the pi extension, which now also reads its own layer, the
shared layer and the legacy partition instead of a single hardcoded namespace.
