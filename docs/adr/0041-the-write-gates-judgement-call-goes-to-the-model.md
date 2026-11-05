# 0041 — The write gate's judgement call goes to the model

Date: 2026-10-31

Status: Accepted

Amends: ADR-0040 (writes are curated), ADR-0015 (write-time reconcile)

## Context

Curation (ADR-0040) settles existence with regexes, and it drew its classes from
measured junk. But the audit's *survivors* made the boundary of that approach
plain: rows like `allowedAgents for planner.md is researcher, scout, designer…`
carry no pipe, no colon terminator, no tool-token manifest, no repair phrase —
every structural rule passes them, and they are still session scaffolding. The
repository's own gate comments have said this since ADR-0015: *"run the tests
before commit" is throwaway task scaffolding in one repo and a durable routine in
another. No regex settles that.*

The field runs this last mile on a model. Mem0's second pass answers NOOP for
facts not worth keeping; Letta's sleeptime agent is told to "be selective in your
memory editing"; Memobase's auto-validation filters "low-quality or irrelevant
information that the LLM might generate". This repository already owns the wire
for exactly that kind of question: the jev judge (ADR-0013) asks the extractor's
slices whether they will still be useful weeks from now, fail-open, one noul per
sentence. What it never reaches is everything that is not an extractor slice —
LLM-extract candidates, tool writes, and every explicit save, which is precisely
where the audited junk entered.

## Decision

A second gate, `jevWriteGate` in `src/core/judgment/judge.ts`, asked from
`MemoryService.saveDetailed` for every write that survives curation. Same
endpoint, same key, same fail-open wire — one new *question*, not one new
integration.

Two questions, one request (the protocol prices N questions at a single round
trip):

1. **`keep`** — the extractor's own durability question, now asked of writes the
   extractor never saw.
2. **`scaffold`** — the semantic complement of curation's structural rules: "is
   this the agent's own instruction scaffolding, a configuration dump, or a
   narration of what just happened, rather than knowledge about the world or the
   project?"

The verdict resolves on the same trust ladder as every other gate:

- **No answer** (gate off, no key, request failed after retries) → the write
  stores unjudged, untagged. Fail-open is not a fallback here; it is the
  contract — a store that stops recording because a judge API is down is worse
  than one that occasionally keeps a mediocre fact.
- **`keep < floor` (default 0.5) or `scaffold >= 0.5`**, extractor origin →
  rejected as the `low-value` class: the one junk class no regex assigns, carried
  through the same `CurationRejected` path, advice and all, so a model verdict
  and a lexical verdict render identically at every surface.
- Same verdict, explicit origin, values derived → demoted: `note` 0.35,
  `curation:low-value` tag, `SaveResult.curation` set. Priced, not refused — a
  caller who asked for the write is second-guessed about *rank*, never about
  *existence*.
- Same verdict, explicit origin, **caller-named kind or importance** → stored as
  asked, tagged `judged:write-gate`. The caller's own judgement about their row
  wins; the tag only confesses that the gate disagreed.
- Clean verdict, values derived → importance priced from the model's confidence
  (`importanceFor(keep)`, the same 0.4 + 0.5·keep mapping the extractor judge
  uses), tagged `judged:write-gate`.

Skip rules, so the gate never asks what has already been answered:

- Rows tagged `judged:jev` (the extractor's judge priced them in
  `heuristicExtract`) skip the gate — **one judgement per row, never two**.
- A curation demotion stands; the gate does not run on a row the structural
  verdict already sank. The structural answer outranks the model's optimism about
  the same sentence.
- Texts under 12 characters skip — below the extractor's own candidate floor.

`MEMORY_WRITE_GATE=false` turns this gate off alone;
`MEMORY_WRITE_GATE_MIN` is its floor; `MEMORY_JEV=false` remains the master
switch for all model judgment (it already gates `jevRelation`). Both knobs are
console-writable settings, applied per call like every judge knob.

## Consequences

- Explicit saves gain one network round trip when a key is configured — the same
  cost extraction already pays per sentence. Writes are rarer than reads; no
  read path gains latency. With no key, the gate is a no-op branch.
- The `low-value` class joins `JunkClass` although no regex produces it. That is
  deliberate: one verdict type, one renderer, one set of advice strings — the
  alternative was a second error type plumbed through three surfaces for no
  observable difference to the caller.
- The model can now refuse extractor output the regexes let through, which is
  the Mem0 NOOP answering in this repository's vocabulary. The floor is the
  extractor's own (`JEV_MIN_KEEP` default 0.5) re-exported under the gate's name;
  one knob per surface, not one knob per gate.
- Double judgment is impossible by construction, not by discipline: the skip is
  keyed on the tag extraction itself applies.

## What this does not fix

- **The gate is not a reconciler.** It prices and refuses single texts; what a
  write *does to its neighbours* stays with reconcile and its relation judge
  (`jevRelation`), which asked a different question on the same wire before this
  gate existed.
- **Fail-open means a broken judge is silent.** The console's key check
  (`validateJevKey`) remains the one moment a wrong key is named; a mid-session
  failure stores unjudged and logs a warning, by design.
- **No batch pricing.** A bulk import still bypasses the gate entirely
  (`saveMany`), for the same reason it bypasses reconcile and curation: an
  import is a deliberate act, and a 5,000-row file that fails on row 3 is a
  hostile gate.
