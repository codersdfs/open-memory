# ADR-0050: Codebase memory is a derived index; the repository's files are the truth

Date: 2026-11-14

Status: Accepted

Adds codebase memory: the repository's files, symbols, imports and call references indexed into `memory.db`, readable over three MCP tools (`codebase_index`, `codebase_search`, `codebase_symbol`), a CLI group (`ai-memory codebase index | search | symbol | forget`) and four HTTP routes. Modelled on what code-knowledge-graph MCP servers (DeusData/codebase-memory-mcp among them) give an agent, but built the way this store builds everything: one SQLite file, zero runtime dependencies, deterministic reads, hard token budgets. Stands on ADR-0020 (the project dimension this rides), ADR-0023 (the vault sync whose shape this mirrors), ADR-0018 (the batch-write atomicity the sync reuses), ADR-0044 (the graph-must-not-lie precedent the edges follow), and ADR-0047 (the optional-capability pattern the store interface extends).

## Context

An agent that knows what happened here (the memories) still does not know what lives here: which file holds the function it must change, what calls it, what breaks when it moves. Code-intelligence MCP servers answer that with a parsed graph, but every one we surveyed ships a native binary or a language runtime — against a store whose entire pitch is `node:http`, `node:sqlite`, `node:crypto` and nothing else. Meanwhile half the answer already exists in this schema: knowledge pages proved that "the file is the truth, the store holds an index of it" is a shape this codebase can maintain honestly, incrementally and idempotently.

## Decision 1: derived tables, parsed by a structural scanner, never a dependency

`code_files`, `code_symbols`, `code_edges` (ADR-0050 schema in `src/core/store/sqlite.ts`) are **derived state** — the repository's files are the truth, exactly as `vault/*.md` is for knowledge rows. Nothing in retrieval reads them implicitly; only the explicit `codebase_*` surfaces do.

The parser is a structural scanner, not a grammar: comments and strings blanked length-preserving, brace depth tracked, declarations matched by statement position, import specifiers recovered from the original offsets. It extracts what an agent navigating a repository needs — functions, classes with their methods, interfaces, type aliases, exports — and it says nothing it cannot support. A structural surprise surfaces as a `parse_error` on the file row and the sync moves on; the truth (the file) is untouched either way.

Languages arrive through the registry (`src/core/codebase/languages/`): a `LanguageGrammar` owns its blanker, its declaration shapes, and its `resolveImport` when the language has a module system of its own (`go.mod` prefixes, Java/Kotlin packages-to-directories, Rust `crate::`/`super::`, tsconfig `paths`). TypeScript/JavaScript, Go, Java, C#, Rust and Kotlin ship; the scan's extension set and the sync's per-file parse both derive from that one list. `language` is persisted on every file and symbol row, because an index written by six scanners has to say which one wrote each row — a mixed index nobody can attribute is an index nobody can trust.

## Decision 2: edges carry evidence; ambiguity builds nothing

`code_edges(kind, from_id, to_id, evidence)` — `evidence ∈ {import, alias, re-export, local, name-match}`. Import statements and re-export chains (followed to a bounded depth — 4 hops — with a cycle guard, so a file may be entered once per resolution walk) are exact; a specifier the tsconfig `paths` map claims lands on the file the compiler options point at (`alias`, exact through the compiler options); same-file references are exact; a name that resolves to **exactly one** exported symbol anywhere in the project earns `name-match`, the honest heuristic. Two exported symbols with the same name build **no** edge — the graph would rather miss a link than invent one (ADR-0044's rule, applied to code). Module nodes (one per file, `kind = 'module'`) carry file-level import edges so the graph stays connected without pretending a file "calls" a function.

## Decision 3: the sync is incremental, atomic and idempotent

`src/core/codebase/sync.ts` is the only writer. Content hash decides everything: an unchanged file writes nothing; a changed file rebuilds only its own symbols and the outbound edges it owns (only those old edges are deleted by the same transaction — inbound edges to a changed file's surviving symbols stay valid, symbol ids being deterministic); a removed file's symbols and every edge touching them go. Re-export statements and type-field maps persist on the `code_files` row, so a chain or a two-level call pointing into an *unchanged* file still resolves without re-parsing it. All of one sync lands in one `BEGIN IMMEDIATE` transaction, `fan_in` recomputed over the live edges inside it (ADR-0018's shape). A crash lands all of a sync or none of it.

Indexing is **explicit** — `codebase_index` / `ai-memory codebase index`, with `--dry-run` first, exactly like the vault sync. No watcher: the store is a record of "what was indexed when", not a live mirror.

## Decision 4: symbol search is deterministic, not hybrid

A symbol's name is its content, so `codebase_search` scores exact > prefix > substring > signature, ties broken by exported, then fan-in, then path. No embedding call, no BM25 corpus, no threshold — the same query always returns the same rows, which is what navigation needs and what `memory_search`'s probabilistic ranking would get wrong. Results still answer under the hard token budget, the same contract every other read keeps.

## Consequences

- `codebase?` joins `knowledge?` as an optional store capability; a third-party store written before this keeps compiling, and the service reports the missing capability instead of pretending.
- The scanner's heuristics (name-match edges, method signatures capped at 120 chars, expression-arrow bodies read to statement end) are documented in the parser and pinned by `tests/codebase-parse.test.ts`. tsconfig `paths` aliases (evidence `alias`), dynamic `import()`/`require()` module-node edges, NodeNext `.js`→`.ts` specifier landing, method-level call edges through bindings and field chains, and harness-callback references have shipped; multi-language support and the rest of the wishlist remain planned in [docs/roadmap-codebase-memory.md](../roadmap-codebase-memory.md).
- A repository index is worth the same as any derived state: rebuildable from the files alone, and `codebase forget` deletes it without touching a byte of the repository.
