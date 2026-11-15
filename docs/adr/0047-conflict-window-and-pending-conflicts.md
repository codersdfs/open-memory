# ADR-0047: The conflict window — judge absent, same subject, different claim: mark it

Date: 2026-11-08

Status: Accepted

Implements P5 of the memory-systems research plan (`docs/research/memory-systems-notes-2026-11-07.md` §3, review verdict: approved — "顺序依赖（P4 先行）与上轮硬伤修正均已落地"). Amends ADR-0041 (the relation judge's failure becomes a visible, tagged outcome — the amendment section there records the decision). Stands on ADR-0046 (the `memory_facets` index and `facetCandidates`, whose ADR named this work its downstream consumer), beside ADR-0011/0015 (write-time reconcile and its guards), ADR-0012 (the candidate union this widens at write time), ADR-0020 (the project wall this never crosses).

## Context

Two facts made one silent failure mode. First, the reconcile window was narrow by construction: every save asked about exactly the five nearest rows of its own partition **and type** (`memoryService.ts`'s single `vectorSearch`, `type: target.type`). A contradiction filed under another type — an episodic event against a semantic fact, a procedural routine against a decision — never reached the decision. Second, when no relation judge was configured, `reconciler.ts:162` answered the only question left with silence: `{ action: "insert", reason: "model-unavailable" }` — the new claim stored beside the old one with nothing on either row saying they disagree. The research plan named both halves gap3 and pointed at the dependency: "同 entity 的行必须等 P4 的 store 能力先行，P5 是 P4 的消费者".

The judgement this lands on was pending in ADR-0041's ledger (plan §4 item 6: "judge 失败是否落 tag 一项 ⚖️ 待决") and is decided here, recorded in that ADR's amendment: **a judge that was asked and failed does not mint a conflict marker — it reports only its own failure.** A failed call admits nothing about the pair except that it could not be read; tagging contradictions onto it would invent facts at the exact moment the system knows least.

## Decision 1: the window widens to three arms, capped at ten

`saveDetailed` builds the reconcile neighbour list from three arms, deduped by id in arm order and capped (`unionNeighbours`):

1. **Vector top-5, same type** — the query the old exact-text dedup already ran, byte for byte.
2. **Same entity, this partition** — `store.facetCandidates` over the `entity:` facets the incoming row itself will carry (the same `buildTags` the decision stores — a join key only joins if both sides hold it), any type, `vectorScore = 0`.
3. **Same partition, no type wall** — the same vector query without `type`, so a contradiction filed as an event or a procedure can reach a semantic write. Skipped when arm 1 already ran unfiltered.

Ten is the cap, not a target: the widened window must not turn every save into a wider scan than the guards can read, and the cap trims the weakest arm first (arm order is priority).

**Reaching is still not admitting.** Every neighbour faces the same `nearest()` floors as before — lexical ≥ `MEMORY_RECONCILE_LEX`, containment, or cosine ≥ `MEMORY_RECONCILE_COS` when a real embedder is configured. A facet-sourced row carries `vectorScore = 0`, so it clears only on its own words — the no-free-channel rule ADR-0046 set for the retrieval arm, kept at the decision floor. Measured consequence, pinned by test: a same-entity pair that shares only four of six tokens stores unmarked, while the fillers around it clear the cosine gate. A marker without support would flood every shared-entity store with pairs that are two facts about one thing, not two versions of one fact — the lexical/cosine floor is what makes "same subject, different predicate" mean *versions*.

## Decision 2: the judge-absent pair that names one subject takes a marker

When no relation judge is configured (`MEMORY_JEV=false`, **or jev enabled with no key** — the same reading ADR-0041's trust ladder gives the write gate: no key means no judge, not a failed call) and the gate-winning neighbour survives every check that precedes the judge — not the same claim (R1), not guarded (extractor, episodic, typed, pinned: those four return unchanged and never mark), not a refinement — one test remains:

- **Same subject**: the pair shares an `entity:` facet (the incoming row's tags against the neighbour's). Deliberately `entity:` only — a shared `topic:` says the sentences are about the same *thing*, not that they speak of the same *subject*.
- **Different predicate**: already established by reaching this line — the same claim was folded, a refinement superseded, the guards had their say.

A pair that passes both stores with a `conflict:<entity>` facet on **both** rows instead of a silent double write, `reason: "conflict-unjudged"`. The facet value is in the facet vocabulary (`conflict:` joined `FACET_PREFIXES`), so the marker lands in `memory_facets` through the same invariant as every other facet: postings count the facet tags the row carries.

**The marker must move through the P4-maintained paths, and only those.** The incoming row carries it in `decision.tags` through the insert, which indexes it. The *existing* row can only take a new tag through `updateMeta`'s tags patch — the path ADR-0046 already maintained for exactly this caller — which rewrites the postings in the same transaction as the column. Writing the column directly would leave the postings describing the old tags, and the invariant test would catch it as drift; `tests/conflict-window.test.ts` pins the postings == facet tags equality on both rows, on both stores, through a reopen of the SQL file.

Two deliberate non-behaviors:

- **No inherited markers.** `inheritFacets` keeps `entity:`/`topic:`; a successor of a marked row does not carry the conflict forward — the marker names a pair, and the pair's other half is what stays marked until adjudicated.
- **Markers survive a rewrite.** `rederiveTags` re-derives text-derived facets but keeps `conflict:*` — the marker describes a relationship, not the sentence, and a reembed that dropped it would silently resolve a pending adjudication. The marker is placed **ahead** of the re-derived facets in the rebuilt list, because the cap must spend a tag the row can get back: a derived facet recomputes from the new text, the marker does not. The first cut of this put the marker in the plain group *after* the derived facets, and on a full 8-tag row the cap ate the adjudication while the invariant (postings == facet tags) stayed true — the drift the tests could not see. Pinned by the full-row probe in `tests/conflict-window.test.ts`.

## Decision 3: the three unjudged outcomes stay distinguishable

The old wire collapsed them: `relationJudge` swallowed failures with `.catch(() => null)`, so a broken judge, a cautious judge and an absent judge all arrived as "no relation" and all read `model-unavailable` (or worse, `model-unrelated`). Three outcomes now:

| Outcome | What happens | Row tag | Reason |
| --- | --- | --- | --- |
| Judge **absent** (not configured, or no key) + same subject, different claim | both rows take `conflict:<entity>` | — | `conflict-unjudged` |
| Judge **failed** (asked; the wire returned nothing — request failed after retries) | stored unjudged, counted | `judged:failed` | `judge-failed` |
| Judge **answered, no label cleared** (the margin kept it from acting) | stored unjudged, nothing added | — | `model-unrelated` |

The wire makes the split mechanical: `relationJudge` maps "no answer at all" to a *rejection* and an answered-but-undecided verdict to a resolved `null`. The reconciler counts each failure and writes the running total to stderr — `[reconcile] relation judge failed (N this process): …` — the one side-channel in a module whose header still says pure: observability, never decision input. `judged:failed` joins the `judged:*` vocabulary ADR-0041 established (`judged:jev`, `judged:write-gate`), so a store's judge health is queryable the way its verdicts are.

## Decision 4: the count and the panel

`StatsSummary` gains `pendingConflicts` — readable-live (`is_deleted = 0`, `status = 'active'`) rows wearing a `conflict:*` facet — and `pendingConflictRows` (id, type, created, text, the conflict facets), computed by `summarize` from rows it already holds. Tombstones are excluded on purpose: a marker on a tombstone names a pair that no longer exists. `/stats?full=1` carries both additively. The console's Stats view gains a **pending conflicts** panel (a `StatCard` and a read-only table grouped by the facet the pair was named after); the adjudication itself stays out of it on purpose — resolving a conflict is a supersede or a tag strip, and both belong in the memories view where the whole row is visible.

The same facet slice is now a store filter: `MemoryFilter.facet` (`list`, `vectorSearch`, `lexicalCandidates`, and the shared `candidateWhere`/`candidates` plumbing behind `cosineSpread`/`facetCandidates`), both stores, matched case-insensitively over the postings — the read side of the window ("give me the rows one conflict entity named") and the test surface for "a filtered page and a filtered search agree".

## Cost

One save now runs up to three partition reads instead of one: two `vectorSearch` calls (the second hits the warm partition cache — the ADR-0029/0035 machinery — and is skipped entirely when the write has no type) and at most one indexed `facetCandidates` read (skipped when the write derives no `entity:` facet, which is most prose — ADR-0046 measured 143 of 152 questions deriving zero). No read path changes: `MEMORY_LINKS` still owns retrieval, and the conflict window is a write-time consumer of the capability, not a search setting.

## Consequences

- `tests/conflict-window.test.ts` pins: the three arms' query shapes and that the facet arm reaches a row outside the vector top-5; the ≤10 cap with arm priority and dedup; the no-free-channel outcome at the decision floor; the marker through `updateMeta` with postings == tags on both stores (SQL through a reopen); the marker surviving a reembed; the three unjudged outcomes distinguishable on the real jev wire (a mocked 500 endpoint vs a mocked undecided answer vs no key); the four guards refusing to yield their pairs to the marker; `MemoryFilter.facet` on `list`/`vectorSearch`/`lexicalCandidates` for both stores; the stats count over live rows only. `tests/reconciler.test.ts` now pins `judge-failed` + `judged:failed` where it pinned `model-unavailable`; `tests/facets-index.test.ts` resets its arm counter after saves, because the write path legitimately consults the capability now.
- Schema: none. `conflict:` facets live in the existing `memory_facets` postings and the existing `tags` column; a downgrade reads them as unknown-prefix tags.
- `saveMany({reconcile: true})` pays the window per row like `saveDetailed` always has — the bulk default stays off (ADR-0018), unchanged.
- The pending-conflict pair surfaces in three places that agree by construction: `summarize`'s count, the console panel, and a `facet: "conflict:<entity>"` filtered read — one vocabulary, one index.
- What this does **not** do: no adjudication flow beyond the panel (picking a winner stays a manual supersede), no marker resolution when one side of a pair is superseded (the tombstone keeps its tag; the count reads live rows, so the pair leaves the queue when both sides are retired), and no entity extraction beyond ADR-0011's narrow derivation — a contradiction between two texts that name no explicit entity stays unmarked, which is the honest limit of a marker that must name its subject.

## What would change the verdict

A corpus measure of how often `conflict:*` pairs are false alarms (two facts, one subject) versus real pending contradictions. If the panel floods, the subject test tightens (require the shared entity plus a measured similarity band) before any looser derivation is considered — the same order ADR-0046 recorded: fix the vocabulary before blaming the index.
