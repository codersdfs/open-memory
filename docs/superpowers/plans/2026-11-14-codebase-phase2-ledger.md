# Codebase Memory Phase 2 — Execution Ledger

Plan: [docs/roadmap-codebase-memory.md](../../roadmap-codebase-memory.md) §Phase 2.
Base: the Phase 1 working tree (917 tests green). Same rules as Phase 1: no worktree,
no per-task commits (operator convention), sequential dispatch for shared files,
parallel dispatch only for disjoint new files.

## Rulings

- Ruling 1 (scope): Phase 2 = the grammar registry refactor (TS/JS becomes the first
  implementation with BYTE-IDENTICAL behaviour), the `language` schema columns, and
  the brace family Go → Java → C# → Rust → Kotlin. C/C++ stays deferred (roadmap).
- Ruling 2 (parallelism): the five grammar tasks create disjoint new files only
  (their own `languages/<lang>.ts` + their own test file) and are dispatched in
  parallel after Task A lands; the controller wires the one-line registrations into
  `languages/index.ts` afterwards and runs the gates. Schema task runs in the same
  parallel wave (touches types.ts/stores/sync.ts — disjoint from grammar files).
- Ruling 3 (kinds mapping): languages map constructs onto the SHARED `CodeSymbolKind`
  set (no wire additions): Go struct → `type`, Go interface → `interface`, Java/C#/
  Kotlin classes → `class`, Rust struct → `type`, trait → `interface`. A grammar
  that cannot say a kind honestly leaves the symbol out rather than lying.

## Tasks

| # | Task | Files | Status |
|---|------|-------|--------|
| A | Grammar registry refactor — TS/JS as first implementation, zero behaviour change | languages/types.ts, typescript.ts, index.ts, scan.ts, sync.ts, parse.ts | complete (920 tests, zero behaviour change) |
| B | `language` columns + resolveImport wiring + SQLite reload test | types.ts, sqlite.ts, memory.ts, sync.ts, tests | complete — **implemented by the controller** (Ruling 4) |
| C1 | Go grammar | languages/go.ts, tests/codebase-lang-go.test.ts | complete (13 tests) |
| C2 | Java grammar | languages/java.ts, tests/codebase-lang-java.test.ts | complete (9 tests) |
| C3 | C# grammar | languages/csharp.ts, tests/codebase-lang-csharp.test.ts | complete (11 tests) |
| C4 | Rust grammar | languages/rust.ts, tests/codebase-lang-rust.test.ts | complete (18 tests; Qwen qwen3.8-flash after 3 provider aborts) |
| C5 | Kotlin grammar | languages/kotlin.ts, tests/codebase-lang-kotlin.test.ts | complete (21 tests; Qwen qwen3.8-flash) |

Acceptance (plan §Phase 2): per language — (a) zero line drift on multi-line
signatures, (b) in-repo import edges resolve, (c) ambiguity builds nothing; all
existing tests pass unchanged; registry routes by extension.

## ACCEPTANCE — MET

- (a)(b)(c) per language: 72 grammar fixture tests (go 13, java 9, csharp 11, rust 18, kotlin 21)
  plus the shared sync/languages suites.
- Real mixed corpus (`bench/OpenViking`: 949 TS / 151 Rust / 21 Go, 11.7 MB): 1,121 files,
  12,484 symbols, 21,699 edges, 0 parse errors, **2.2 s** full / **0.7 s** one-file incremental —
  inside the roadmap's 10 s bar.
- Full suite: **993 passed / 0 failed** (917 baseline + 76). `tsc` clean for `src/`.
- Probe project forgotten afterwards; the two third-party `bench/` files touched for the
  incremental measurement were restored to their exact prior content.

## Ruling 4 (controller takeover, Task B)

The schema agent survived three provider aborts (free-plan concurrency caps: "3 requests at a
time", "1 request at a time") and eventually reported completion with no on-disk effect — while
Task B sat on the critical path the five grammar agents were already waiting on. I implemented
Task B myself against the same brief, then kept its regression tests as the gate. Cost if wrong:
the takeover bypassed task-review for that one task; mitigated because the mixed-language reload
test (SQLite reopen) and the sync-level hook test both came from the review round that followed,
and both fail when the wiring is reverted.

## Defects the acceptance probe caught (post-implementation, all fixed + tested)

1. **Read path dropped the column I had just wired the write path for.** `codeFiles()` and
   `codeSymbolSql()` still selected without `language`, so a real re-index stamped every row
   `typescript`-null and the probe reported `{"null":206}`. Found by querying the DB instead of
   trusting the code; fixed and now pinned by the SQLite-reload test.
2. **`//` inside a SQL template.** A comment I added to the fan_in statement used a JS idiom
   SQLite does not accept — every sync would have died with `near "/": syntax error`. Caught by
   the very next run; comments moved out of the SQL.
3. **Grammar hook overwritten by the default machinery.** My first wiring ran the hook and then
   let the alias/relative block assign `landed` again; the fix guards the default path with
   `if (!landed)`. (An intermediate `if (landed) continue` was wrong too — it skipped edge
   building entirely. Kept as a note: the landing is a precondition for the edge, not a bypass.)
4. **`fan_in` recompute was quadratic (33 s for 1,121 files).** The correlated subquery made
   SQLite read every calls edge per symbol. Measured in isolation: 32.3 s for one UPDATE on
   11k symbols while the counts next to it took 1 ms. Rewritten as one grouped read + PK-seek
   writes, scoped to the project, plus the `(to_id, kind)` index. Same index now costs 3 s
   end to end. The roadmap's 10 s bar is what surfaced it — the measurement was the point.
5. **A test assertion of mine was wrong, not the code.** I expected a Go `pkg.Helper()` call edge
   to hang off the module node; the shared cascade correctly attributes it to the calling symbol
   (`main`). Probed the real shape first, then fixed the expectation — the honest order.

## Parked / deferred (with reasons)

- Python (roadmap Phase 3): needs an indentation-based scanner, not a brace grammar; deferred as
  planned rather than folded into this phase.
- Per-grammar `code_symbols.language` filtering in search: no consumer yet; the column exists so
  a later `--lang` filter is a where-clause, not a migration.
- `go.mod` is read per import statement by the Go grammar (agent-documented; page-cache cheap at
  v1 scale, memoize per repoRoot if a corpus ever shows it).
- SQLite-backed codebase capability tests: the reload test now covers the SQL read/write path for
  `language`; the edge-ownership keystone tests remain the main SQL-path coverage.
