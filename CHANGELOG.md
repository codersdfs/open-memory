# Changelog

Notable changes. The package is `open-memory`; the command stays `ai-memory`.

Prereleases (`-beta.N`) may still move the HTTP and MCP surfaces between builds. The
on-disk format is the part that does not.

## 0.4.0-beta.2 — 2026-11-05

A real-time retrieval pass plus a correctness fix, and the first build whose committed tree
actually matches the 0.4.x work the beta.1 notes already described (the storage cache, curation,
project memory, knowledge dimension and explainable-recall code landed here rather than at the
beta.1 tag).

### Changed

- **Coverage is now idf-weighted for ranking** ([ADR-0028](docs/adr/0028-idf-weighted-coverage-and-prf.md)).
  ADR-0027 made plain `coverage` the sort/gate/budget key, but on a single-conversation corpus a question
  that names the protagonist ("What is Caroline's identity?") scores half the store identically to the row
  that answers it, because the name sits in every chunk. The *sort*, MMR and budget now weight each asked
  word by its document frequency (`term_df`), while the relevance *gate* still reads the unweighted share —
  so admission semantics are unchanged, only ordering. Measured on a new model-free evidence ruler
  (`bench/evhit.mjs`, LoCoMo conv-26, 152 questions, NIM embeddings): evidence-any 68 → 76%,
  evidence-all 57 → 66%.
- **A pseudo-relevance second pass was built, measured net-negative, and shipped off** (ADR-0028). It
  reaches rows that hold a multi-hop answer's second half without the question's vocabulary, but the merged
  rows crowd a fixed token budget single-hop rows need (evidence-any 76 → 72%), so `MEMORY_PRF` is `off`
  by default; `MEMORY_PRF=on` opts in — the same disposition the int8 shortlist got.
- **`realtime-bench` no longer calls a model on every write.** A judge key in `settings.json` was silently
  putting an LLM round-trip inside each `save` (write p50 3 → 209 ms), moving the run's saturation point with
  an unrelated service. The bench pins `MEMORY_JEV=off` before starting (a real env value still wins).

### Fixed

- **`memory_list` now merges the scope fan-out into one recent-first page** (issue #1). It used to call
  `list({limit})` per resolved namespace and concatenate the pages, so it returned up to `limit × layers`
  rows and put every private row ahead of every shared one regardless of age — the opposite of "list the
  most recent memories in the resolved scope(s)." It now fetches each layer at `limit`, sorts the merged set
  `pin DESC, created_at DESC, id ASC`, and slices to `limit` once (`total` stays the per-layer sum). The `id`
  tie-break is pushed into both stores' `ORDER BY` so a page is deterministic when rows share a millisecond
  (Windows clock granularity makes exact ties routine on bulk import), which is what makes the per-layer-top-
  `limit` subset claim hold literally. `limit` is clamped to 1..1000 like the HTTP route; a non-finite limit
  is refused rather than failing open differently per backend.

## 0.4.0-beta.1 — 2026-10-20

Five passes in one release: recall, scale, project memory, the knowledge dimension, and a
real-time benchmark. The on-disk format changes are additive — open any 0.3.x store and the
rows, embeddings and namespaces are kept; new columns are backfilled in place.

### Added

- **Candidate union over a term index** — search could only ever return rows the embedder had
  already ranked into the top `max(20, k*4)`; BM25 re-ranked that list and never added to it.
  Measured on the live store, 32.5% of known targets sat outside that window and recall@5 was
  *exactly* P(target inside it), so the candidate set — not the scoring — was the ceiling.
  A `memory_terms(token, memory_id, tf)` posting table is now maintained in the same transaction
  as every text write (and backfilled once at `init`), and `lexicalCandidates()` feeds a bounded
  second list into the same gates, MMR and budget. A row found only by words enters with
  `vectorScore = 0`, so it has to compete on the same terms. `BM25` also gained real `df`/`avgLen`
  over the candidate set: the hardcoded `avgLen = 20` had been calibrated on one-sentence rows and
  divided every term by ~14 on a 1,200-character chunk, collapsing exact-match evidence to ~0.01.
  Measured on 152 LoCoMo questions with the hash embedder: any gold evidence in context
  27.6% → **62.5%**, all evidence 21.1% → **54.6%**, single-hop 18/70 → **55/70**; search p50
  0.9 → 4.0 ms in memory, 10.8 ms on the real 299-row store.
  [ADR-0012](docs/adr/0012-candidate-union-over-term-index.md)

- **`k` is a cap, the budget is honest, decay is reachable** — `k` used to only size the
  over-fetch (148 of the benchmark's 152 queries asked for 5 and got fewer than 5);
  `countTokens` used `len/4` (a 68-character Chinese memory was budgeted at 17 tokens and cost
  ~60); `budgetEnforce` stopped at the first row that did not fit, so one long memory hid every
  shorter one behind it; and `prune`'s `maxImportance` compared `strength`, which made the decay
  rule structurally unreachable — strength starts at importance and only grows, so `strength <=
  0.3` matched 0 of 335 rows and `runDecay` pruned one row in the store's history. Results are now
  sliced to `k`, CJK counts per character, the budget skips instead of breaking, and pruning
  requires `importance <= x AND strength <= x` (both low), so reinforcement protects a row.
  [ADR-0013](docs/adr/0013-honest-k-budget-and-decay.md)

- **Write-time reconcile.** A save now decides what it does to the store instead of only
  inserting: an identical claim (punctuation and case included, word order not) reinforces the row
  that already exists, a refinement or a contradiction supersedes it through the existing
  `supersedes_id` chain with the old claim kept as `(previously: …)`, and everything else
  inserts as before. The neighbour query was already being run for the old exact-text
  dedup, so a write costs one extra model call only when it lands near an existing memory.
  Pinned rows, `episodic` memories and auto-extracted text are never superseded. `tags`
  now carry `entity:`/`topic:`/`path:` facets, inherited across a supersede. No schema
  change and no migration; `MEMORY_RECONCILE=off` is the rollback.
  [ADR-0011](docs/adr/0011-write-time-reconcile-schema-free-facets.md)

- **A shape gate at write time, and dates in the text.** The extractor graded sentences by
  wording, so a markdown table row, a list bullet, a `<skill>` wrapper or a `Session 3:` fixture
  header could all pass as knowledge — measured on a 335-row store, the old gate rejected 5 of
  180 hand-classified junk rows. `isNonMemoryShape()` now rejects by structure first (tables,
  headings, bullets, prompt XML, fences, fixtures, scripts with no word, and terminator-less
  slices under 40 characters, with a narrow first-person exception for `"I live in Berlin"`),
  and the measured rejection is **165/180 (91.7%)** with 5 false kills in 335 rows. Relative
  times are resolved against the turn's date and stamped `(at:YYYY-MM-DD)` into the stored text
  — the term index and `LIKE` search text, not tags — and `topic:` facets are actually derived
  (domain nouns, then words repeated in the sentence) instead of never appearing.
  [ADR-0015](docs/adr/0015-shape-gate-and-dated-context.md)

- **Decay archives instead of deleting, and the stats view can see it.** The only decay rule as
  `episodic > 90d AND strength <= 0.3` was structurally unreachable — strength starts at the
  written importance, bottoms out at 0.4 and only grows — so a store where 308 of 335 rows had
  never been retrieved pruned exactly one row in its history. `runDecay()` now demotes
  never-retrieved rows older than 30 days with `importance < 0.6` to `status = archived`
  (reversible, still readable through `includeArchived`, idempotent); deleting survives only
  behind `hard: true`, with the importance floor at 0.5 so the rule can fire. `POST /decay`
  answers `{archived, pruned, affected}`, `memory_stats` reports archived and never-retrieved
  counts, and the console preview lists each candidate's action. `npm run seed` writes to a temp
  directory unless a path is passed, so fixture rows can no longer land in a real store.
  [ADR-0016](docs/adr/0016-archive-first-decay.md)

- **Leftover budget is filled by projection, never at another row's expense.** `budgetEnforce`
  used to return a row whole or not at all, leaving the tail of the 800-token budget as an
  extractive summary. It now offers a non-fitting row to a `project()` callback only when at
  least 64 tokens remain *and* no later row would have fit whole (a suffix minimum makes that
  check O(n)). `assembleFragment()` keeps the most query-relevant line, its neighbours and the
  block's dated header. Projecting every row up front was measured and is worse — single-hop
  55/70 → 43/70 — because the gold line is not reliably the most query-similar one; only
  leftover space is safe to spend. `MEMORY_ASSEMBLE=off` restores whole rows.
  [ADR-0014](docs/adr/0014-project-into-leftover-budget.md)

- **LoCoMo re-run: 50.7% → 59.2%** (77 → 90 of 152 questions, same pinned reader, same NIM
  embeddings, fresh store). Multi-hop 38 → 43.8%, temporal 35 → 45.9%, open-domain 46 → 61.5%,
  single-hop 66 → 72.9%; the judge-free string hit moves with it (19.7 → 22.4%). 30 answers
  flipped wrong-to-right against 17 right-to-wrong. Context per question grew to 3,081 chars
  because the retriever now returns the volume `k` and the budget always claimed; retrieval p50
  held at ~580 ms. Numbers, method and caveats: [bench/REPORT.md](bench/REPORT.md).

- **`ai-memory agent add <id> --mcp-file <path>`** — plug in an MCP client that has no
  adapter class, with no code. The declaration (config file, key path, optional env and
  instructions file) lands in `~/.ai-memory/agents.json`; `link`, `unlink`, `status`,
  `doctor` and the registry treat it exactly like a built-in. `agent remove` drops the
  declaration, `agent specs` lists them. Built-in ids are refused rather than overridden:
  those adapters write more than a config path (Claude Code's hooks, Codex's managed
  block), so a declaration would drop that work silently — `agent specs` marks a
  hand-written collision and `agent doctor` fails on it.
- **`ai-memory setup --link`** — the command that exists to set this up now also
  registers the agents it finds, instead of printing a reminder that it did not.
- **The package is importable.** `exports` and `types` point at `dist/src/index.js`, which
  re-exports `MemoryService`, `createMemoryTool`, `autoInject` and the adapter registry —
  so an agent written in TypeScript can `import { MemoryService } from "open-memory"`
  instead of reaching into `dist/src/`. The README snippet that told you to import
  `./src/core/memoryService.js` was a path no installed user has.
- [docs/integrations.md](docs/integrations.md) — the four ways in (MCP, CLI, hook, library),
  what `link` writes for each agent, and how to add one that is not on the list.

- **The console can hold your keys.** `#/settings` writes `OPENAI_API_KEY`, `NVIDIA_API_KEY`, `NIM_API_KEY` and `JEV_API_KEY` — plus the judge and extractor knobs — into `~/.ai-memory/settings.json` instead of asking you to hand-edit `.env`. Settings stay flat (a setting key is still an env-var name), a secret is never echoed back (only an ellipsis and the last four characters), and every row says whether it takes effect on save or needs a restart. A key the real environment already provides is refused with the name of where it lives, rather than silently shadowed by it. [ADR-0010](docs/adr/0010-console-writes-credentials.md) supersedes ADR-0009's "never an API key".
- **Adopt.** A key sitting in `.env` shadows every console write, so `POST /settings/adopt-env` copies the whitelisted ones into `settings.json`, comments those lines out (never deletes, never reorders), keeps a one-time `.env.bak`, and reports the entries it could not read back exactly instead of persisting a value that is subtly wrong.
- **`ai-memory daemon restart`** — probe, stop, start, and confirm the replacement answers `/health` before claiming success; a restart that cannot start one says so and exits non-zero. From a source checkout it prints the exact command instead of pretending.

- **Vectors are float32 blobs, read in two phases.** A row's embedding used to be JSON text in
  `memories.embedding`, so every search parsed ~6 KB of ASCII digits per row and the file paid
  11,854 B per 1.5 KB of floats. Vectors now live in `memory_vectors(memory_id, dim, vec BLOB,
  norm)`; `vectorSearch` scores `(id, vec, dim, norm)` first and fetches full rows only for the
  survivors. Existing files migrate on open in resumable batches of 5000 (335 rows in 51 ms; a
  synthetic 10k-row legacy file in 1.03 s). Measured, single partition, 1100-char rows: 2k rows
  45.2 → **12.4 ms** and 22.6 → **11.1 MB**; 10k rows 279 → **64.7 ms** and 113.9 → **56 MB**;
  4k rows at 2048 dims 240.9 → **61.6 ms**. At 10^5 rows that is ~2.8 s → **~647 ms** (384 dims)
  and ~6.0 s → **~1.5 s** (2048 dims — still needs an index, ADR-0019 is open).
  [ADR-0017](docs/adr/0017-vector-blob-layout.md)

- **One transaction per batch.** `store.insertMany`, `service.saveMany(inputs, {reconcile})` and
  `POST /memories/bulk` (≤5000 rows) write a whole batch in one transaction with one embed batch;
  `reconcile` defaults to off in bulk mode because a 5-neighbour search per row makes a 10k import
  quadratic. `ai-memory import run --write` now goes through it instead of one commit per row.
  Bulk delete also got its other half: `store.purgeDeleted({olderThanMs})` hard-deletes tombstones,
  and `ai-memory db compact [--purge <days>]` / `POST /compact` VACUUMs and reports the real
  footprint (db + WAL + shm — measuring just the main file showed 4 KB while 1 MB sat in the WAL).
  [ADR-0018](docs/adr/0018-batch-writes-and-purge.md)

- **Document frequency is data, common words are not candidates.** The lexical half of a
  search recomputed `df` with a `GROUP BY` over the postings of every query word, which
  after ADR-0017 made it the larger half of a read: 103 ms of 163 ms at 10,000 rows.
  A `term_df(token, n)` table is now maintained in the write transaction (and rebuilt from
  the postings on open / after a purge), so candidate selection is eight primary-key
  lookups; words that appear in more than a third of a store with ≥1000 rows are skipped
  instead of aggregated, because their idf cannot discriminate. End-to-end search p50:
  2k rows 30.2 → **15.3 ms**, 10k 163.2 → **64.6 ms**, 20k 341.4 → **148.9 ms**, 4k at
  2048 dims 122.2 → **83.7 ms**. Projected to 10^5 rows, 384 dims is now **~0.68 s**
  (~1.71 s before) and inside the 700 ms budget; 2048 dims is ~2.07 s and needs an index,
  which stays open. Small stores (<1000 rows) are untouched, so v0.4 recall numbers and
  every test that pins them are unchanged. [ADR-0019](docs/adr/0019-term-df-and-rarity-gate.md)

- **Projects.** A row now records which effort it is about, as a slug — resolved explicit →
  `MEMORY_PROJECT`/`AI_MEMORY_PROJECT` → the git work-tree root, slugged → `null`. The namespace
  still says *who* wrote it; a project answers *which repository*, because one agent works on
  several and one repository is worked on by several. Filtering is a column and an index
  (`list`, `search`, `prune`, `stats.byProject`, `--project`), and reconcile stays inside one
  project: the same sentence under two repositories is two facts, not a duplicate.
  [ADR-0020](docs/adr/0020-project-as-a-dimension.md)

- **Kinds, and decay that knows why a row matters.** `decision`, `convention` and `gotcha` are
  durable by contract: the archive pass returns early for them, because losing one silently
  charges the next session the same rediscovery. `task` lives 7 days, `note` 30, `fact` 90, and
  the age window follows the row's kind instead of one global 30 days. Kinds are derived
  lexically (bilingual, zero model calls; an explicit `--kind` wins) and an explicit kind prices
  itself (decision 0.8 … note 0.4). [ADR-0021](docs/adr/0021-kind-decides-retention.md)

- **The brief.** `memory_brief`, `GET|POST /brief` and `ai-memory brief` print what a project
  already knows without a query: conventions → decisions → gotchas → open → recent, in a fixed
  order with shares 0.25/0.30/0.20/0.15/0.10, trimmed until the *rendered* block fits 600
  tokens. Deterministic — same store and clock give byte-identical text — and it is coverage, not
  ranking, which is what a session that starts with no question needs. The auto-injection hook
  uses it on a query-less turn and falls back to search when the brief is empty.
  [ADR-0022](docs/adr/0022-brief-assembly.md)

- **Knowledge pages: markdown is the truth, the row is its index.** A vault page now syncs into one
  row per heading-delimited section, stored under `knowledge_id` + `knowledge_section` and keyed by
  the heading (`how-tokens-work`, repeats `-2`, CJK kept) rather than by position — so editing one
  section rewrites one row, deleting one removes one row, and a second sync of unchanged files reports
  `inserted: 0, updated: 0, unchanged: N, embedCalls: 0`. `[[links]]` from the body and the frontmatter
  `links:` list land in `knowledge_links`, unresolved targets kept as `to_id = NULL`; retrieval shows
  them but never walks them — `neighbors` is explicit, depth 1..3, cycle-safe. The old `wiki-ingest`
  rows are adopted by their `wiki:<page>` tags instead of duplicated, ordinary writes cannot reconcile
  into a knowledge row, and decay never archives one. Surfaces: `memory_knowledge`, `GET /knowledge`,
  `GET /knowledge/:id`, `GET /knowledge/:id/neighbors`, `POST /knowledge/sync`, and
  `ai-memory knowledge ls|show|neighbors|sync|link`. 19 new tests; suite 41 files / 500 passed.
  [ADR-0023](docs/adr/0023-knowledge-dimension.md)

- **A real-time benchmark, because the other two are quiet.** `scripts/realtime-bench.mjs` runs an
  open-loop mixed workload against the production stack (45% search, 30% write, 10% list, 10% brief,
  5% knowledge, plus a knowledge sync every few seconds that rewrites a vault section) and measures
  what a caller feels: dropped requests, worst stall, per-op p50/p95/p99, per-second series, tokens
  spent, and recall@k against a marker written into every seeded fact — so the recall figure is
  measured under churn, not on a frozen fixture. Measured here (one core, hash/384d): zero drops and
  ~10 ms search p50 up to 80 req/s; the knee is at ~90-100, where 3.7% of requests go unissued and
  search p50 becomes 126 ms. Recall is reported per query shape, which is how the default hash
  embedder's Chinese loss (71% vs 97% English) became visible. `--assert` gates errors, drops,
  `search p95`, per-mode recall, budget overruns and sync errors. 13 unit tests on the pure part
  (`src/bench/realtime.ts`). [ADR-0024](docs/adr/0024-realtime-benchmark.md)

- **An opt-in int8 shortlist for wide vectors, because 2048-d retrieval was 3× over budget.**
  `memory_vectors` gains a per-dimension signed byte and a `maxAbs` scale per row; with
  `MEMORY_Q8=on` a search ranks the whole candidate set on those bytes and re-scores only the
  shortlist against the float32 blob, which returns the exact ordering for the rows it keeps.
  Measured at 10,000 rows / 2048d: p50 181.6 → 125.5 ms (1.45×), at the cost of +25% disk
  (14,112 → 17,702 bytes/row). **Off by default**: a 1.45× that lands at ~1.09 s at 10^5 rows is
  still over the 700 ms budget, and the phase split shows why it cannot be pushed further — reading
  four times fewer bytes per row saved 26 ms of 116 ms, because the rest is per-row object
  construction and the JOIN, which only shrink if fewer *rows* are read.
  [ADR-0025](docs/adr/0025-int8-shortlist.md) · [ADR-0026](docs/adr/0026-int8-off-by-default.md)

### Fixed

- **Twelve more MCP clients, and the paths they were pointed at were not theirs.** "Use it
  from any agent" used to mean four built-ins plus a hand-written declaration per client.
  `agent list` now knows sixteen: the four built-ins and a table of paths for Cursor,
  Windsurf, Cline, Zed, Continue, VS Code, Gemini CLI, opencode, Qwen, Crush, Amp and Aider,
  so `agent link --agent cursor --write` works on a fresh install. The list is a function of
  the table, not of what this machine has installed — a client missing from `agent list` reads
  as "unsupported" — and `installed` / `not found` is a directory probe, not a guess.
  Two of those configs are JSONC (Zed and VS Code ship comments in theirs), so they are edited
  by splicing text rather than by a `JSON.parse` round-trip: `link` then `unlink` gives back a
  byte-identical file, and the splicer re-parses its own output and compares the target path
  before writing, so a splice bug surfaces as an error instead of a mangled editor config.

- **Every known-client path pointed into the memory store.** `resolveHome()` names the store
  (`~/.ai-memory`), not the user's home, and the detection code used it, so `agent doctor`
  printed `~/.ai-memory/.cursor/mcp.json` — a file no editor reads — and detection then found
  the store's own directories and reported every client as installed. The two are now separate:
  known clients resolve against `homedir()`, the store against `resolveHome()`.

- **`GenericAdapter.detect()` returned `true` for known clients too.** It was written for
  declarations, where naming an agent is itself the claim that it is installed. Known clients
  go through the same class, so a bare `agent link --write` would have written into all twelve
  configs, present or not. A known client now probes its own directory; a declaration still
  answers `true`.

- **`makeRegistry` kept the last adapter for a duplicated id and `all()` returned duplicates.**
  Callers append in priority order, so the intended meaning is first-wins: built-ins shadow
  known clients, and known clients shadow declarations.

- **The int8 shortlist returned nothing useful for any query.** `quantizeVector` stored negatives
  as unsigned bytes (`-126` as `130`) and returned a `Buffer`, while rows came back as `Int8Array`
  through `unpackQ8`; `cosineQ8` then multiplied `+130` by `-126` on the same dimension and the dot
  product changed sign. An exact self-query scored `-0.55` and ranked 2000 of 2000 rows, so recall@k
  was 0 — with a green suite, because no test compared the two paths. `quantizeVector` now returns
  `Int8Array` and writes the rounded value straight into it. `tests/q8-shortlist.test.ts` pins the
  two paths to the same ids, the same order and a self-query above 0.99 in both modes.
  [ADR-0025](docs/adr/0025-int8-shortlist.md).

- **`agent unlink` orphaned a TOML subsection.** Removing `[mcp_servers.ai-memory]` left
  its own child table `[mcp_servers.ai-memory.env]` behind with the `AI_MEMORY_AGENT` line
  in it, because the section editor treated any header as the end of the section. A child
  table belongs to its parent, so replacing or removing the parent now takes it along —
  which also means an update refreshes the env table instead of leaving a stale one beside it.

- **A credential written for the judge reached only the processes that load `.env`.** The judge and the extractor read `process.env` directly while the embedder read the merged settings, so `MEMORY_JEV`, `JEV_API_KEY_FILE` and `ENABLE_EXTRACTOR` in `settings.json` did nothing. One seam (`runtimeEnv`) now serves all three, and each reads it per call rather than at module load, which is what makes a change take effect without a restart.
- **The console's write routes could be driven by any page in your browser.** A loopback-only server is not a trust boundary: a simple request from a web page is a loopback peer and could `POST /admin/shutdown`. Every mutating method now refuses a non-loopback `Origin`, and the console routes additionally require a JSON content type — the CLI, hooks and adapters send neither an `Origin` nor always JSON, so their requests are unchanged.

## 0.3.0-beta.1 — 2026-10-12

### Fixed

- **A bare `ai-memory search` could not see your memories.** A read resolved to the
  caller's agent partition (`pi:<user>`) while every row written before layering
  existed sat in `default:default`, so the documented command printed "no memories
  matched" for data that was plainly there. Reads now always cover the legacy
  partition. (Worth separating from the next item: the CLI's own default threshold is
  0.35, so the empty result was never the threshold.)
- **Old memories went dark.** The relevance floor was applied to the total score,
  which includes recency — so the gate got harder every day a memory lived. A
  near-perfect lexical match (`bm25 0.884`) scored 0.710 against the 0.72 gate at 36
  days old and was discarded, and the effect compounds as a store ages. The floor now
  applies to relevance (or to the total), while zero shared terms still never
  qualifies.
- **Six install bugs**, all found by installing the tarball and using it rather than
  by reading code: `bin` pointing at the wrong `dist` path, a missing shebang, UI
  files absent from the package, `version` reading a nonexistent path,
  `GET /memories/search` shadowed by `/memories/:id`, and `.env.example` promising an
  `EMBEDDING_PROVIDER` that nothing read.
- **Search crashed on a partially migrated store.** A row left at the old vector
  width by an interrupted re-embed is now skipped rather than throwing mid-search.
- **The write gate let questions in.** Measured against a real store, "what next to
  ship this" and its neighbours scored 0.07–0.21 with the judge yet were stored
  anyway — the judge is optional (no key) and the cheap regex only looked for a
  trailing "?". Spoken questions and agent scaffolding are dropped now, while orders
  ("Do not force push"), procedures ("How to deploy the UI: npm run …") and
  when-clauses ("When user says save, call …") are kept.

- **The CLI did nothing at all on Linux.** A global install puts a symlink in `bin/`, and the
  entry guard compared the path that was typed against the path Node resolves through the
  link, so the two never matched: `open-memory version` printed zero bytes and exited 0, and
  every command was a silent no-op for anyone who installed this from npm on a POSIX system.
  The guard compares real paths now. Found by the smoke test below on the first runner it
  ever saw, which is the reason that step exists.
- **A daemon-backed `search` looked in the wrong partition.** The CLI resolves the caller's
  partition plus the legacy one before searching, but the request carried only the raw flags
  — including `agent` and `scope`, which the server has never read — so the daemon answered
  from its own default scope and reported "no memories matched" for rows that were plainly
  there. `GET`/`POST /memories/search` takes a comma-separated `namespaces` now, the CLI
  sends the list it resolved, and a test covers that case.

### Added

- **A semantic gate.** A memory with no shared words is admitted when it is the
  partition's best vector hit and leads that partition's median cosine by
  `MEMORY_SEMANTIC_MARGIN` (default `0.2`). At the production floor of 0.72, four
  paraphrased queries went from 0/4 hits on the hash embedder to 3/4 with nemotron,
  while the unrelated query still returns nothing.
- `ai-memory reembed` — rewrite every stored vector for a provider swap, including
  archived and forgotten rows. `--dry-run` counts first.
- `--all` sweeps every partition you own, rather than the two the resolver guessed.
- Embedding providers (`openai`, `nim`) wired to the save and search paths, with the
  vector weight following the provider (ADR-0004).
- Vector-graph view over the store (`.pi`-free, plain HTML in the same process).

### Known gaps

- No measured comparison between the hash embedder and a real provider yet; that
  needs a key (`wayfinder/tickets/011`). The vector path is wired, not proven.
