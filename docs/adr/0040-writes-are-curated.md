# 0040 — Writes are curated: the store refuses junk on sight

Date: 2026-10-31

Status: Accepted

Amends: ADR-0015 (write-time reconcile), ADR-0021 (kind derivation), ADR-0037 (an empty search explains itself — the advice pattern)

## Context

The store had a write gate, but only for one door. `Extractor.isWorthKeeping`
policed the sentences the heuristic extractor sliced out of a turn; every other
write path — the LLM extract pass, `tool+jev`, and every explicit
`memory_remember` / `POST /memories` / `ai-memory save` — landed verbatim. The
live store showed what that asymmetry produces. Audited 2026-10-31
(`default:default`, 515 active rows):

| signal | value |
| --- | --- |
| rows written by the extractor | 486 (94%) |
| kind `note` (the honest "no reason to keep this") | 235 (46%) |
| rows never retrieved once | 459 (89%) |
| supersession links | 0 |
| rows archived by decay | 0 |

A write-only junk drawer. The worst rows were not edge cases:

- `我没说过我在 pi-desktop。……不是我的工作目录。` — a conversational repair,
  stored as a fact, **with `judged:jev` on it**: the optional LLM judge passed it,
  because "is this useful?" is the wrong question for a sentence whose subject is
  the conversation itself.
- `| 网卡 | MediaTek Wi-Fi 6 MT7902LEN | ✅ 卡不差 |` — a table row; the shape gate
  rejects pipes, but the LLM extract path never ran it.
- `Task: TOOLBOX: your real tools are read, grep, find, ls, bash, write, …` and
  `18: export const PITCH = 48; // row height, px` — the agent's own prompt
  scaffolding and a diff line, stored as `fact` 0.72 and `note` 0.67.

Meanwhile the field had solved parts of this and left other parts unsolved. Mem0
answers `Hi.` with `{"facts": []}` and runs a second pass that may answer NOOP;
Letta's archival docstring says "self-contained facts, not conversational
fragments"; Memobase's validation kills "User did not state their name"; Zep
supersedes instead of deleting; Generative Agents rate poignancy at birth. Two
gaps are open across the whole field: **nobody filters secrets deterministically**
(the instructions say "never store secrets" and the store holds them anyway), and
nobody handles negation deterministically. Both gaps showed up in this store.

## Decision

A pure verdict module, `src/core/write/curation.ts`, answers one question for
every candidate: does this deserve to exist? It runs in `MemoryService.saveDetailed`
**before the embed** — a refused write must not cost a vector round trip — on every
origin. `MEMORY_CURATE=off` restores the un-gated behaviour per process.

The verdict is one of three actions:

1. **reject** — the write throws `CurationRejected`. Every interactive surface
   renders the verdict's advice (the ADR-0037 pattern: one next move, never a
   bare no) instead of an error: the API answers `422 {error, curation}`,
   `memory_remember` returns `not stored (<class>): <advice>` with
   `{stored: false, curation}` (deliberately *not* `isError` — a NOOP is a
   decision the model reads and acts on, the way Mem0 returns one), the CLI
   prints the advice and exits 1.
2. **demote** — weak classes from an *explicit* caller store anyway: kind
   `note`, importance 0.35, a `curation:<class>` tag, and `SaveResult.curation`
   so the caller can see it. Second-guessing intent entirely is how a memory
   system stops being trusted; sinking a row below every kind default is not.
3. **store** — unchanged.

The classes, each named for a measured junk shape:

| class | hard rule | example from the audit |
| --- | --- | --- |
| `secret` | vendor key shapes, `Bearer`/JWT, keyword assignments (`api_key =`, `密码:`) | the settings file's own keys |
| `table-row` | any `\|` | `\| 网卡 \| MediaTek …` |
| `colon-header` | ends with `：`/`:` | `……是渲染时机**：` |
| `phatic` | whole-text social lexicon, EN+CN | `好的`, `thanks!` |
| `conversational` | negation-of-saying, "you misunderstood", 别乱记 | the `pi-desktop` repair |
| `code-line` | `export const`, `const x =`, signature shapes | `export const PITCH = 48;` |
| `prompt-fragment` | second-person tooling, scaffold labels (`TOOLS_IMPLIED:`, `SKILLS:`), ≥3 tool tokens with no terminator, numbered slice + meta-language | `Task: TOOLBOX: …` |
| `progress` (weak) | `我刚做的:`, `Plan 已更新`, `I just fixed …` | `Plan 已更新（…）` |
| `self-narration` (weak) | `I can only work with …`, `我只能` | `I can only work with local files …` |

Weak classes reject from the extractor's origin (nobody asked for the row) and
demote from an explicit one (somebody did). A caller who names a kind or an
importance outranks demotion — their verdict about their own write wins.

Three secondary decisions:

- **The demotion tag rides in the caller tags**, not only on the store target:
  reconcile builds the row's tags from the caller tags, so a tag attached only to
  the target silently vanishes on the insert path.
- **The LLM extract pass now runs the same gates as the heuristic one.** It
  shipped with none, which is where the table rows came from; a model's judgement
  of what is durable is a candidate, not a verdict.
- **CJK sentences split at their terminators** (`(?<=[。！？])`), which English
  never needed because it puts a space after the period. Audited rows like
  `在。它就是那个 MCP 服务里的第三个项目……` slid past the split whole,
  confirmation token and fact welded together; the `在。` fragment now separates,
  falls under the 12-char floor, and the fact behind it stands alone.

`extractAndSave` returns `{memories, rejected}` and `POST /extract` reports the
count — Mem0's `{"facts": []}` is a success, and "the turn held nothing durable"
must be distinguishable from "the extractor was off". `saveMany` kept curation off
when this ADR was written — "a 5,000-row import that fails on row 3 because one line
ends in a colon is a hostile gate." That sentence is superseded (2026-11-07, P1 of
`docs/research/memory-systems-notes-2026-11-07.md`, ADR-0018 Amendment): the bulk
path now runs this same zero-network verdict and *skips* a rejected row instead of
killing the batch, so row 3's colon costs one line of `skipDetails` and the import
keeps its gate. `secret` and empty text are refused on every write path —
`{raw:true}` excuses neither — short of the explicit `MEMORY_CURATE=off` switch that
turns the whole verdict off.

## Consequences

- Replaying all 515 audited rows through the verdict at the extractor origin:
  **68 rejected (13.2%)** — conversational 1, prompt-fragment 17, colon-header 16,
  table-row 30, code-line 2, progress 1, self-narration 1 — with zero kills on
  the clean fixture set (durable conventions, gotchas, facts, procedures from the
  same store). The remaining rows are dominated by config-file notes that carry
  real decisions; pushing further would trade false kills for marginal recall,
  which is the trade this repository's gate has always refused to make.
- Secrets are refused by shape, not by listing: the vendor prefixes age, and the
  keyword-assignment rule (`密码: …`, `api_key = …`) is the durable half. This is
  the only class where a false kill is *preferred* — a mangled credential in a
  memory store is worse than a missing memory.
- The 46% `note` population does not shrink retroactively. Curation is a write
  contract; the stock decays through the archive policy (30 days, never
  retrieved) and the demote ladder sinks new arrivals below real knowledge.
- The advice strings are user-facing contract, like `renderEmptySearch`'s three
  tails. They are tested word-for-word on the class boundary, not the sentence.
- Zero model calls, bilingual by contract, pure module — the same constraints as
  every lexical rule here. The optional jev judge keeps running where it ran
  before; curation is what answers when no judge is configured, and the floor
  when one is.

## What this does not fix

- **Explicit writes are trusted with weak classes.** `我刚修好了登录的 bug`
  stored deliberately lands as a demoted note; if the caller wants it durable,
  they name a kind — the same bargain `deriveKind` makes.
- **No retroactive curation.** A `curate` pass over the existing 515 rows is a
  one-off audit, not a feature; the store does not silently rewrite its stock.
  (Reversed 2026-11-08 by the user's decision, P3 of the memory-systems research —
  see the Amendment below. The pass exists now, and "diff first" is what keeps it
  from being silent.)
- **Paraphrase dedup is still reconcile's job.** Curation decides existence,
  reconcile decides effect; the two stay separate verdicts on purpose, because
  the guards that make supersede safe (`episodic-no-delete`, `pinned-no-delete`)
  do not belong to a gate that runs before neighbours are known.
- **The daemon applies this on restart.** A long-running daemon serves the code
  it booted with; the gate is live in every new process, MCP client, and CLI
  invocation that constructs a `MemoryService`.

## Amendment (2026-11-08): retroactive curation exists now — `ai-memory triage`, diff first

This record took two "the stock is never rewritten" positions, and both are now
reversed by the same research (`docs/research/memory-systems-notes-2026-11-07.md`),
one apiece:

- **"`saveMany` kept curation off"** (Decision section) — reversed 2026-11-07 by
  P1 (ADR-0018 amendment): the bulk path runs this same zero-network verdict per
  row, skipping rejected lines instead of killing the batch. The inline note at
  the end of the Decision section carries it.
- **"No retroactive curation"** (the bullet above) — reversed 2026-11-08 by P3,
  on the user's explicit decision (the research notes listed it as ⚖️ needing
  sign-off; P1's reversal and this one were settled together). The verdict stops
  being a write contract only: the stock gets the same judgement through
  `ai-memory triage` (`src/core/lifecycle/triage.ts`), an explicit operator
  command — never a silent rewrite, which is the part of the original decision
  that survives unchanged.

What shipped, in the order the command promises it:

- **Diff first.** The default run writes nothing: it reports *would archive N /
  would demote N / merge candidates M* with ids, classes and reasons as samples,
  and `--apply` is the only mode that touches rows. The dry-run comparison in
  `tests/triage.test.ts` is over every mutable column including `updated_at`, not
  spot checks.
- **Junk → archive, never a hard delete.** The seven hard classes flip
  `status = archived` through `updateMeta` — the same reversible demotion decay's
  default pass makes (ADR-0016); the row, its vector and its audit trail stay,
  and `purgeDeleted` remains as unreachable from here as it is from the
  scheduler.
- **Weak classes → importance sinks, the row survives.** `progress` and
  `self-narration` get the write-time explicit-write bargain: importance to 0.35
  (`DEMOTE_IMPORTANCE`), kind untouched. A row already at or under the floor is
  where the ladder would have put it, so it is neither written nor counted.
- **`updateMeta` gained an `importance` patch — both stores.** The prerequisite
  gap the research named (the patch had no way to move the judge's number) is
  closed in `SqliteVectorStore` and `InMemoryVectorStore` alike; the SQLite path
  keeps its trailing `noteChange`, so a demoted or archived row leaves every
  decoded partition snapshot it sat in (ADR-0034) — pinned by a cache-counter
  test, not assumed.
- **The contracts outrank the regexes.** The pass skips durable kinds
  (`decision`/`convention`/`gotcha` — ADR-0021, the same skip P2 preserved when
  decay swapped to hotness), pinned rows (pin is the one explicit "keep this" —
  ADR-0011), drafts (a governance state — ADR-0006), knowledge rows (an index of
  a file, which the next sync would re-insert — ADR-0023), tombstones and rows
  already archived. Only rows a read can still hand out are candidates.
- **Merge is a report line, not an action.** Live rows sharing an `entity:*`
  facet and the same `normalizeText` are listed as merge candidates in both
  modes; picking a survivor rewrites identity, and that decision stays with
  reconcile and its guards (ADR-0015), the same split the original "no
  retroactive curation" bullet argued for — it was the *silence* it objected to
  keeping, not the boundary itself.
- **The judge's absence is counted, not recorded.** Live rows carrying no
  `judged:*` tag are counted in-process (`unjudged`) — "the judge priced this row
  low" and "the judge never ran" are indistinguishable after the fact (ADR-0041
  stores unjudged rows untagged, fail-open), and whether a triage-visible tag
  fixes that is ADR-0041's pending amendment (P5), deliberately not written here.

Verified by `tests/triage.test.ts` (both stores: dry-run byte-identical; apply
archives junk and idempotently re-reports zero; durable kinds, pin, draft,
knowledge rows and tombstones unmoved; merge candidates listed and never merged;
`updateMeta` importance on both stores plus the partition-cache invalidation) and
by `tests/cli.test.ts` (dry-run prints the diff and writes nothing; `--apply`
writes; the machine shape is stable under `--json`).
