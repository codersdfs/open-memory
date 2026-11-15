# ADR-0015: A shape gate at write time, and dates carried into the text

- **Status:** Accepted (2026-10-19) — implements WP2 of the v0.4 plan; measured against a 335-row copy of the live store.
- **Options for junk:** keep grading sentences by wording (v0.3) vs **reject by structure first, wording second** (chosen) vs let a judge model decide vs clean the store afterwards.
- **Why not wording:** measured. The v0.3 gate rejected 5 of 180 hand-classified junk rows (2.8%) and 7 of 335 rows overall. Wording cannot see a markdown table, a list bullet, a `<skill>` wrapper or a `Session 3:` fixture header — and `STATES_HOW` even read `"| 层 | 位置 | 状态 |"` as knowledge because it has a space and a colon.
- **Why not a judge model:** the write path must not depend on a key (ADR-0002/0004). The judge stays optional.
- **Decision:** `isNonMemoryShape(sentence)` runs first in `isWorthKeeping`: table rows, headings, bullets, prompt XML, code fences, `Session N:` fixtures, strings with no word in any script, and lines shorter than 40 characters with no sentence terminator. It is the first half of the gate and the only half that is structural.

## Measured on the audited store (335 rows, 180 junk by a predicate frozen *before* this gate)

| | junk rejected | false kills (whole store) |
|---|---|---|
| v0.3 wording gate | 5/180 (2.8%) | 7 |
| v0.4 shape gate | **165/180 (91.7%)** | **5** |

The 13 rows that still pass are short sentences with a terminator and no structural tell (`"The user lives in Berlin."`) — the audit's `<40 chars` predicate over-labels those as junk. Structural classes (tables, headings, bullets, XML, fences, `Session N:`) are rejected at 100%. `tests/gate-audit.test.ts` reproduces this from a read-only copy (`MEMORY_AUDIT_DB`) using a verbatim copy of the audit predicate, so the number cannot drift with the gate.

## One exception, measured too

`"I live in Berlin"` is 16 characters, has no terminator, and is exactly the row the store exists for. Chat turns drop the period precisely there, so `SELF_FACT` (first-person opening + marker verb, not the hedged `"I am not sure"` form) is exempt from the length rule and also decides the `semantic` type — the two uses share one constant so they cannot disagree. Cost measured: junk rejection 165/180 instead of 167/180; the two rows it readmits are `"i prefer vitest over jest in this repo"` and `"i am out of the wait list"`, both first-person statements, not scaffolding.

## Dates

A relative time word ("yesterday", "last month") decays with the reader; an absolute date does not. `extract(turnText, referenceDate)` resolves the relative word against the moment the turn was said and stamps `(at:YYYY-MM-DD)` into the stored text plus an `at:` tag, because the term index and `LIKE` both search `text`, not tags. `MemoryService.extractAndSave(text, namespace, referenceDate?)` passes the caller's date through; omitting it means "now", which is what every current caller does. `src/adapters/inject.ts` renders that date next to the memory (`- (where/type) [YYYY-MM-DD] text`) for episodic and semantic rows only — a procedure does not become truer by being dated. Since 2026-11-08 the stamp is also read back out into a column at write time (`valid_at`, the event-time clock of [ADR-0045](0045-write-history-and-two-clocks.md)) — the text stays the truth, the column is the timeline.

## Facets

`topic:` is now actually derived: known domain nouns first (in order of appearance, at most two), then words repeated at least twice in the sentence; paths are stripped first and entity values are never reused as topics. `entity:` additionally learns 《中文书名》, CamelCase, and acronyms, with `CI/CD`-style slash pairs and `and/or` excluded. `MAX_TAGS` stays 8 and `inheritFacets` still carries `entity:`/`topic:` across a supersede.

## Scope of the gate

Only the heuristic slice path calls `isWorthKeeping`, because only it produces slices. Explicit writes (`save`, `POST /memories`) bypass it by design — a caller that says "store this" has already decided. The LLM extraction path (default off, needs a key) gets date stamping but not the shape gate: it does not emit sentence slices, and it is unmeasured.
