# Codebase Memory Phase 1 — Execution Ledger

Plan: [docs/roadmap-codebase-memory.md](../../roadmap-codebase-memory.md) §Phase 1.
Base: `863562c` (plus the uncommitted ADR-0050 feature in the working tree — this
execution continues that tree; no worktree, no per-task commits: the operator's
convention is explicit-request-only commits, and the feature under construction is
itself uncommitted).

## Rulings

- Ruling 1 (setup): no worktree, no per-task commits — work directly in the current
  tree, all four tasks share it sequentially. Cost: a task regression can only be
  unwound by edit, not revert; mitigated by the test gate after every task.
- Ruling 2 (scope): Phase 2+ of the roadmap is out of scope for this run; only the
  five Phase 1 items, grouped into four tasks (tsconfig aliases + dynamic import()
  share the import-resolution surface, so they dispatch together).

## Tasks

| # | Task | Files | Status |
|---|------|-------|--------|
| 1 | Method-level call resolution (receiver bindings → typed member calls) | parse.ts, sync.ts, tests | complete (57/57 targeted, src lint clean, review APPROVED) |
| 2 | Test-callback refs (`it`/`test`/`describe` bodies at file scope) | parse.ts, sync.ts, tests | pending |
| 3 | tsconfig `paths` aliases (`evidence: "alias"`) + dynamic `import()`/`require()` | parse.ts, resolve.ts, sync.ts, types.ts, tests | pending |
| 4 | Re-export chains to depth 4 with cycle guard; alias threading into barrel hops; longest-prefix + bare `*` alias keys; REQUIRED: persist field maps into `code_files` (both stores) so imported two-level chains resolve in incremental syncs | resolve.ts, types.ts, sqlite.ts, memory.ts, sync.ts, tests | dispatched |

Acceptance (plan): after re-index, `codebaseSync` inbound callers ≥ 3 of the 4
CodeGraph reported (server.ts, cli/index.ts, mcp/tools.ts, codebase-api.test.ts),
every edge evidence-labelled, full suite green.

## Task 1 review adjudication (verdict: APPROVED, 0 Critical / 0 Important / 4 Minor)

- Minor 1 (collectBindings is a superset of the three spec sources — constructor
  parameter properties and function-type-annotation params also bind, last-wins):
  parked — deferred to a per-function-scope tightening; the project-wide uniqueness
  guard on the qualified target keeps the worst case a plausible-but-wrong edge,
  never a crash. Cost if wrong: one mislabelled edge in an unusual file.
- Minor 2 (same-file static receiver `Widget.create()` resolved as `local` exceeds
  the brief's "imported only" wording): ruled intentional — ADR-0050's principle is
  "same-file reference is exact", so the symmetric case belongs. Noted here; the
  code comment already states it.
- Minor 3 (no test pins the ambiguous-qualified-target → no-edge behaviour): carried
  into Task 2's dispatch as a required test.
- Minor 4 (indentation at parse.ts:521): parked, cosmetic.

## Ruling 3 (Task 2 evidence): the roadmap's "test-callback calls earn name-match"
predates Task 1's binding machinery. A callback-body call that resolves through the
same file-scope bindings/imports as any other call earns the SAME evidence
(import/local); only bare-name-only refs stay "name-match", attributed to the module
node. More honest than a blanket label, and consistent with the ADR's evidence rule.

## Task 2 review adjudication (verdict: APPROVED with ledger conditions, 0 Critical / 1 Important / 3 Minor)

- Important 1 (field maps are not persisted, so an imported two-level chain whose
  interface file was not re-parsed this run silently builds no edge; full re-index
  resolves everything): REQUIRED follow-up — merged into Task 4 as its second item,
  mirroring the re_exports persistence pattern in `code_files` (ADR-0050 Decision 3
  already establishes "a chain pointing into an unchanged file must resolve").
  Cost if deferred: incremental syncs miss edges the next full rebuild restores.
- Minor 1 (a user-defined top-level `test(...)` whose last arg is a function is
  structurally indistinguishable from a harness call and will be collected): parked —
  name-contract boundary, documented here per the reviewer's suggestion. Cost: a
  stray module-node ref in a repo that shadows vitest's names.
- Minor 2 (indentation drift of the Task-1 Minor-4 spot, now parse.ts:693): parked,
  cosmetic — same ruling as before.
- Minor 3 (pre-existing: `codeDeleteEdges` removes inbound edges of a re-parsed
  file's dead symbol ids, and an unchanged caller's replacement edge waits until
  that caller itself is re-parsed): ledgered as a known incremental-sync gap of the
  edge-ownership model; full rebuilds are always correct. Fixing it means
  re-resolving unchanged callers' edges on every sync — out of Phase 1 scope, noted
  for the roadmap's Phase 4 watcher work.
- Design note accepted (moduleRefs full cascade import→local→name-match instead of
  blanket name-match): consistent with Ruling 3 — precise evidence wherever a
  precise resolution exists.

## Task 3 review adjudication (verdict: APPROVED, 0 Critical / 0 Important / 6 Minor)

- Barrel second-hop alias miss: carried into Task 4 (same function being rewritten
  for chain depth).
- Longest-prefix alias precedence (TS's `findBestPatternMatch` semantics vs
  declaration order): carried into Task 4 — declaration-order first-match is an
  honest miss but a one-line specificity sort fixes it.
- Bare `*` alias key (`"*": ["src/*"]`) unsupported: carried into Task 4.
- Calls-edge alias propagation: Ruling 4 — parked. Evidence layers describe
  mechanisms: `calls` says how the CALL was bound (import/local/name-match);
  "alias" says how an IMPORT statement landed. Threading alias into calls would
  duplicate that fact on every edge from the file. Cost if wrong: an import edge
  between two files says "alias" while calls between their symbols say "import" —
  both true, different questions.
- Corrupted tsconfig → null without jsconfig fallback: accepted as documented —
  matches tsc's own behaviour; "first that exists wins" is the deterministic rule.
- Doc drift (CLI help evidence list, `codebase_symbol` description, ADR-0050
  Consequences still saying aliases/dynamic are out of scope): to be revised by the
  controller at Phase 1 wrap-up, after the final review.

## Task 4 fix rounds + wrap-up

- Round 1 (2 Important, fixed + regression-tested): bare `*` alias hijacked relative
  specifiers → `aliasMappedPaths` refuses `./`/`../`/`/`; NodeNext `.js` specifiers
  never landed on `.ts` files (this repo's entire src/** importMap was empty — the
  root cause of the controller's 1/4 probe) → `specifierCandidates` maps
  `.js`→`.ts/.tsx`, `.mjs`→`.mts`, `.cjs`→`.cts`. Plus `let`/`var`/bare-assignment
  bindings and removal of the controller's five debug probes.
- Round 2 re-review Important (changed files destroyed inbound edges they do not
  own — reviewer-proven fanIn 1→0, never self-healing): fixed in BOTH stores —
  changed files delete only from-side edges; removals keep both-sides deletion;
  reviewer's repro mechanized as 4 keystone tests (both stores, sensitivity-checked).
  Ruling 5: the round-2 formal re-review was replaced by the mechanized keystone
  tests (a reverted fix fails them) plus the controller's full-suite and acceptance
  verification — a budget call, the evidence is executable, not narrative.
- Parked: binding pass-order vs strict line order (var-hoisting pathology only);
  sqlite-backend capability has no dedicated test file (review-covered); ADR text
  lag fixed this round. CLI/MCP evidence-list doc drift: fixed by the controller at
  wrap-up.

## ACCEPTANCE — MET

`codebaseSync` inbound callers: **3 of 4** (server.ts#handle, mcp/tools.ts#callTool,
codebase-api.test.ts module node; cli/index.ts honestly missed — return-type
inference, out of scope). Full suite **917 passed / 0 failed** (881 baseline + 36).
Self-index: 192 files, 1559 symbols, 4285 edges, 0 parse errors, 571ms, idempotent.
