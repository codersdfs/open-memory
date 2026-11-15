# Codebase Memory Roadmap

Status: living document, updated as phases land. Written 2026-11-14, one day after the
TS/JS index shipped ([ADR-0050](adr/0050-codebase-memory-derived-index.md) and the first
real-world comparison against a code-knowledge-graph MCP server, which found and fixed the
multi-line-signature line drift and named the gaps this roadmap closes).

The one-line promise stays: the repository's files are the truth, `memory.db` holds a derived,
honest index of them, and every read is deterministic, budgeted and dependency-free by default.
Every phase below is judged against that sentence — a phase that adds languages by adding a
mandatory runtime dependency, or adds precision by letting the graph invent edges, fails review.

## Where we are (Phases 1–2 shipped)

- Structural scanners behind a grammar registry (`src/core/codebase/languages/`): six languages —
  TypeScript/JavaScript, Go, Java, C#, Rust, Kotlin — each owning its blanker (comments and
  strings length-preserving), its declaration grammar, and its `resolveImport` where the language
  has a module system of its own (go.mod prefixes, Java/Kotlin packages-to-directories, Rust
  `crate::`/`super::`, tsconfig `paths`). One mixed index, every row stamped with its `language`.
- Evidence-labelled edges (`import` / `re-export` / `local` / `alias` / `name-match`), ambiguity
  builds nothing, incremental by content hash, atomic per sync, `fan_in` recomputed in-transaction.
- Deterministic symbol search (exact > prefix > substring > signature) under the hard token
  budget; three MCP tools, a CLI group, four HTTP routes.
- Phase 1 and Phase 2 are both landed; their ledgers record the rulings and the bugs each review
  round caught: [Phase 1](superpowers/plans/2026-11-14-codebase-phase1-ledger.md) and
  [Phase 2](superpowers/plans/2026-11-14-codebase-phase2-ledger.md).

## Phase 1 — TS/JS correctness ✅ shipped

The comparison against CodeGraph measured exactly where v1 is blind. Close those before
widening the surface:

- **Method-level callers.** `ctx.service.codebaseSync(...)` is invisible today because body
  refs skip identifiers after `.`. Resolution order: exact (the receiver's type is an imported
  class in the same project → its methods), then fall back to nothing — never a bare-name guess.
  This one gap makes every service-layer method's inbound graph empty, which is where agents ask.
- **Test-callback refs.** `it("...", () => { syncCodebase(...) })` never reaches a declared
  symbol, so tests contribute no edges (measured: `syncCodebase` fan-in 1 of CodeGraph's 4).
  Collect refs from top-level arrow callbacks of `it/test/describe` and attribute them to the
  module node — imports stay exact, calls earn `name-match`.
- **`tsconfig.json` / `jsconfig.json` `paths` aliases.** The resolver is relative-only; alias
  specs resolve through the compiler options that sit in the repo anyway. Read them, map alias
  prefixes, and record `evidence: "alias"` — a fifth evidence value, still honest.
- **Dynamic `import()` and `require()`** produce `imports` edges to the target module node with
  `evidence: "import"`; the parser already sees the call site.
- **Re-export chains deeper than one hop.** The one-hop cap was a smell-guard; barrels in real
  repos chain 2-3. Follow with a depth cap (4) and a cycle guard; anything unresolved stays
  module-level, as today.

Acceptance (met): the self-index answers `codebaseSync` inbound callers with 3 of the 4 CodeGraph
reported, tests included, without a single unlabelled edge. The fourth (`cli/index.ts`) obtains its
service from an unannotated async factory — return-type inference, honestly out of reach.

## Phase 2 — the language framework, then the brace family ✅ shipped

Multi-language starts by making the scanner a **registry of per-language grammars behind one
interface**, not a copy of `parse.ts` per language:

- `src/core/codebase/languages/` with `interface LanguageGrammar`:
  `extensions`, `blank()` (comments/strings/regex forms, length-preserving), `declarations()`
  (statement-position grammar), `imports()` (specifier syntax), `resolve()` (specifier → repo
  file rules), `kinds` (the language's constructs mapped onto the shared `CodeSymbolKind` set).
  TypeScript/JavaScript becomes the first implementation; nothing about its output changes.
- **Schema**: `code_files.language` and `code_symbols.language` (symbols inherit the file's, so
  cross-language edges stay possible); no shape change to `code_edges`.
- **Brace family first** — the blanker and depth tracker are already language-agnostic:
  Go, Java, C#, Rust, Kotlin in that order (largest agent-footprint first). Per language:
  declaration grammar, its import/module resolution rules (Go: `go.mod` module prefix;
  Java/C#: package/namespace to directory; Rust: `mod`/`use` trees), and a fixture suite that
  pins symbols, edges and drift-freedom (the `multiLine` test pattern, per language).
- **C/C++ deferred on purpose**: namespaced templates, macros and header/unit split make a
  structural scanner lie more than it says; they wait for Phase 3.

Acceptance (met): every language ships a fixture suite proving (a) zero drift on multi-line
signatures, (b) import edges resolve in-repo through the language's own module rules, (c)
ambiguous names still build nothing. (d) measured on a real mixed corpus — 1,121 files
(949 TypeScript / 151 Rust / 21 Go, 11.7 MB, 12,484 symbols, 21,699 edges, 0 parse errors)
indexed in **2.2 s**; an incremental one-file sync in **0.7 s**. That number is this phase's
real lesson: the first version cost 33 s, and the profiler cleared every parser (all six parse
11.7 MB in 1.1 s) and blamed the project-wide `fan_in` recompute instead — a correlated subquery
that made SQLite read every calls edge for each of 11k symbols. Grouped once, written by PK seek,
the same index costs 3 s end to end. At index scale the derived-count recompute is the hot path.

## Phase 3 — indentation languages, then the optional tree-sitter backend

- **Python** needs its own scanner (indentation blocks, `def`/`class`/`async def`, decorators,
  `import x` / `from x import y` with dotted modules, `__init__.py` packages). Zero-dependency
  is feasible and worth it; Python is the second language of every real polyglot repo.
- **Tree-sitter as an optional backend, never a default.** A dynamically-imported
  `open-memory-parsers` package (WASM grammars) unlocks full-syntax parsing — C/C++, accurate
  TSX, decorator routes — for users who opt in (`ai-memory codebase index --parser treesitter`).
  The npm package stays zero-dependency: the extra package is a separate install, the capability
  is detected like any store capability, and a missing parser degrades to the structural scanner
  with the report saying so. Grammar output maps onto the same `LanguageGrammar` contract and the
  same evidence vocabulary — a tree-sitter edge that the structural scanner could not see is
  still labelled, so two indexes of one repo never disagree about what a line means.

Acceptance: with no extra package installed, every command behaves exactly as Phase 2; with it
installed, `codebase_stats` reports the backend per file and C/C++ lands behind the same
fixture bar as every other language.

## Phase 4 — graph quality and surfaces

Ordered by agent value, not by fun:

- **Symbol embeddings, off by default.** Semantic symbol search ("which symbol handles
  authentication retries?") as a third arm only when an embedder is already configured; the
  deterministic rank stays the floor, the same way vector search never overrides BM25's floor.
- **Console graph view** over `code_symbols`/`code_edges`, reusing the vault graph's renderer —
  the edges already carry evidence; the UI's job is to show it, not infer more.
- **Monorepos**: workspace roots (npm/pnpm/cargo workspaces) resolve as one project per package,
  sharing the store's project dimension; cross-package imports become `imports` edges with
  `evidence: "import"`.
- **Optional watcher** behind an explicit flag, batched through the same sync transaction; a
  degraded inotify/FSEvents is a delayed index, never a wrong one.
- **`codebase_brief`**: the session-opening block that names the entry points, the biggest
  fan-in symbols and the newest files, inside the standard budget — the code-side twin of
  `memory_brief`.

## Permanent non-goals

- No hosted service, no API key, no telemetry — the index never leaves the machine it built on.
- No mandatory parser dependency in the npm package, ever; Phase 3's backend is opt-in.
- No inferred edges without evidence labels; `name-match` stays the ceiling of what a heuristic
  may claim.
- No write access to the repository, ever — the index reads, forgets, and never touches a byte.
