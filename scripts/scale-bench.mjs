#!/usr/bin/env node
/**
 * scale-bench — repeatable, same-machine benchmark for the memory store.
 *
 * Why this exists (task-3 / WP6): the store is heading for 10^5 rows on one
 * machine, shared by several agents and projects. We measured that a 384-d
 * store holding 2,000 rows answered a search in ~45 ms and cost ~12 KB/row;
 * 10,000 rows cost 279 ms. The extrapolation to 10^5 was past the 700 ms
 * retrieval budget, so the store grew BLOB vectors (ADR-0017), a bulk insert
 * path (ADR-0018) and a two-phase read. This script is the before/after ruler:
 * run it on the old tree, run it on the new one, compare the one-line JSON.
 *
 * It runs the REAL stack — `MemoryService` + `SqliteVectorStore`, the same
 * `save`/`saveMany`/`search` an agent calls — against a throwaway SQLite file
 * in the system temp dir. Nothing in the repo is touched, no network is used.
 *
 * Usage (plain `node` re-execs itself under tsx so the TS sources can be
 * imported straight from src/ — no build step, no dist/ dependency):
 *
 *   node scripts/scale-bench.mjs --rows 2000  --dim 384 --ns 1 --assert
 *   node scripts/scale-bench.mjs --rows 10000 --dim 384 --ns 1 --out bench-10k.json
 *   node scripts/scale-bench.mjs --rows 4000  --dim 2048 --ns 1
 *   node scripts/scale-bench.mjs --rows 10000 --dim 384 --ns 10 --write-mode marginal
 *
 * Output: one line of JSON on stdout (for CI / diffing), a human summary on
 * stderr, and with `--out` the full JSON including raw latency arrays.
 *
 * GATES (`--assert`, exits non-zero on failure):
 *   search p95 < --max-search-p95-ms   (default 700 ms, the retrieval budget)
 *   write rows/s >= --min-rows-per-sec (default 100)
 *
 * MEASUREMENT NOTES — read before comparing runs:
 *   - Two write numbers are reported because they measure different things:
 *       bulk   : service.saveMany(batch) — import / replay path, one commit
 *                per batch, no write-time reconcile. This is the headline
 *                rows/s and what the CI gate checks.
 *       save   : service.save() per row at full corpus size — the per-write
 *                cost a running agent pays. With reconcile on it runs a
 *                5-neighbour vector search *per row*, so this is O(rows) per
 *                write and O(rows^2) for a full load. `--write-mode full`
 *                measures that whole load; the default `marginal` mode
 *                presees the corpus in bulk and samples only the marginal
 *                per-row cost at size N.
 *   - `MEMORY_VECTOR_WEIGHT` is pinned to 0 by default so the hash and the
 *     synthetic dense embedder behave like the default hash setup (the vector
 *     term is noise there). Pass `--vector-weight 0.6` to measure the real
 *     provider arm (it adds a full-partition `cosineSpread` scan per search).
 *   - `MEMORY_RECONCILE` is pinned to `on` by default (the shipped path);
 *     `--no-reconcile` pins it off. Both paths in saveDetailed run the
 *     neighbour vectorSearch, so the marginal save cost barely moves — what
 *     changes is only the reconcile decision.
 *   - Synthetic text is ~1100 characters from a 20-word vocabulary, exactly
 *     like the original probe, so bytes/row is dominated by the vector and
 *     the term index rather than by rich prose. It is NOT a real corpus:
 *     same-shape numbers are comparable across runs, absolute truth about a
 *     real distribution is not.
 *   - Search is a full scan of one partition. With `--ns N` the rows are
 *     spread over N namespaces and the search targets one of them, so the
 *     per-namespace row count (and hence latency) is what real multi-project
 *     use sees; the 10^5 projection therefore divides by the project count,
 *     it does not multiply by it.
 *
 * Exit codes: 0 ok, 1 assertion failed, 2 usage / load / runtime error.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SELF), "..");
const SCHEMA = "scale-bench/1";
const SRC = {
  memoryService: "src/core/memoryService.ts",
  sqliteStore: "src/core/store/sqlite.ts",
  hashEmbedder: "src/core/embedding/hash.ts"
};

/** Same 20 words as the original probe, so bytes/row stays comparable. */
const VOCAB = (
  "session decision module router parser cache deploy config schema index budget " +
  "token memory retrieval agent project review latency"
).split(" ");

const TOPIC_COUNT = 64;
const topic = (i) => `topic${i % TOPIC_COUNT}`;

/**
 * The first token of the query is a corpus codename (`topic7`, df ≈ 1/64).
 * Why: every ordinary word in VOCAB appears ~100x per row, so BM25 idf ≈ 0 and
 * the relevance gate filters *everything* (hits=0). A rare token keeps the
 * query realistic and lets the run reach MMR / budget / reinforce — the parts of
 * `service.search()` that a hit-less query skips. See docs/scale-bench.md.
 */
const QUERY = "which module owns the deploy cache budget for topic7";

const DEFAULTS = {
  rows: 2000,
  dim: 384,
  ns: 1,
  namespace: "bench",
  seed: 42,
  textChars: 1100,
  batch: 500,
  writeMode: "marginal", // marginal | full
  saveSamples: 50,
  searchRuns: 20,
  warmup: 2,
  k: 5,
  budget: 800,
  threshold: 0.35,
  vectorWeight: 0,
  reconcile: true,
  assert: false,
  maxSearchP95: 700,
  minRowsPerSec: 100,
  out: null,
  keepDb: false,
  storePhases: true,
  quiet: false,
  help: false
};

const HELP = `
scale-bench — repeatable same-machine benchmark for the open-memory store.

  node scripts/scale-bench.mjs --rows 2000 --dim 384 --ns 1 --assert

Options (defaults in brackets):
  --rows N            corpus size, total rows                   [2000]
  --dim N             embedding width: 384 = HashEmbeddingProvider,
                      anything else = deterministic dense fake   [384]
  --ns N              spread rows over N namespaces              [1]
  --namespace NAME    base namespace name                        [bench]
  --search-namespace  namespace the search runs in               [first ns]
  --seed N            reproducible corpus seed                   [42]
  --text-chars N      synthetic text length                      [1100]
  --batch N           saveMany / insertMany batch size           [500]
  --write-mode M      marginal | full                            [marginal]
  --save-samples N    per-row save samples in marginal mode      [50]
  --search-runs N     measured service.search() runs             [20]
  --warmup N          warmup searches first                      [2]
  --k N               search k                                   [5]
  --budget N          budgetTokens                               [800]
  --threshold N       search threshold                           [0.35]
  --vector-weight N   pin MEMORY_VECTOR_WEIGHT                   [0]
  --no-reconcile      pin MEMORY_RECONCILE=off
  --assert            gate on p95 and rows/s, non-zero exit
  --max-search-p95-ms N   gate for --assert                      [700]
  --min-rows-per-sec N    gate for --assert                      [100]
  --out PATH          write full JSON (incl. raw latencies) there
  --keep-db           keep the temp DB and print its path
  --no-store-phases   skip per-phase store.vectorSearch timings
  --quiet             no human summary on stderr
  --help              this text
`.trim();

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { ...DEFAULTS };
  const need = (flag, v) => {
    if (v === undefined || v.startsWith("--")) fail(`missing value for ${flag}`);
    return v;
  };
  const num = (flag, v) => {
    const n = Number(need(flag, v));
    if (!Number.isFinite(n)) fail(`${flag} expects a number, got "${v}"`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    if (!raw.startsWith("--")) fail(`unexpected argument "${raw}"`);
    const eq = raw.indexOf("=");
    const flag = eq === -1 ? raw : raw.slice(0, eq);
    const inline = eq === -1 ? undefined : raw.slice(eq + 1);
    const next = () => (inline === undefined ? argv[++i] : inline);
    switch (flag) {
      case "--rows": opts.rows = num(flag, next()); break;
      case "--dim": opts.dim = num(flag, next()); break;
      case "--ns": opts.ns = num(flag, next()); break;
      case "--namespace": opts.namespace = need(flag, next()); break;
      case "--search-namespace": opts.searchNamespace = need(flag, next()); break;
      case "--seed": opts.seed = num(flag, next()); break;
      case "--text-chars": opts.textChars = num(flag, next()); break;
      case "--batch": opts.batch = num(flag, next()); break;
      case "--write-mode": {
        const m = need(flag, next());
        if (m !== "marginal" && m !== "full") fail(`--write-mode must be marginal or full, got "${m}"`);
        opts.writeMode = m;
        break;
      }
      case "--save-samples": opts.saveSamples = num(flag, next()); break;
      case "--search-runs": opts.searchRuns = num(flag, next()); break;
      case "--warmup": opts.warmup = num(flag, next()); break;
      case "--k": opts.k = num(flag, next()); break;
      case "--budget": opts.budget = num(flag, next()); break;
      case "--threshold": opts.threshold = num(flag, next()); break;
      case "--vector-weight": opts.vectorWeight = num(flag, next()); break;
      case "--no-reconcile": opts.reconcile = false; break;
      case "--assert": opts.assert = true; break;
      case "--max-search-p95-ms": opts.maxSearchP95 = num(flag, next()); break;
      case "--min-rows-per-sec": opts.minRowsPerSec = num(flag, next()); break;
      case "--out": opts.out = need(flag, next()); break;
      case "--keep-db": opts.keepDb = true; break;
      case "--no-store-phases": opts.storePhases = false; break;
      case "--quiet": opts.quiet = true; break;
      case "--help": case "-h": opts.help = true; break;
      default: fail(`unknown flag "${flag}" (try --help)`);
    }
  }
  if (!Number.isInteger(opts.rows) || opts.rows < 10) fail("--rows must be an integer >= 10");
  if (!Number.isInteger(opts.dim) || opts.dim < 8) fail("--dim must be an integer >= 8");
  if (!Number.isInteger(opts.ns) || opts.ns < 1) fail("--ns must be an integer >= 1");
  if (!Number.isInteger(opts.batch) || opts.batch < 1) fail("--batch must be an integer >= 1");
  if (!Number.isInteger(opts.saveSamples) || opts.saveSamples < 1) fail("--save-samples must be an integer >= 1");
  if (!Number.isInteger(opts.searchRuns) || opts.searchRuns < 3) fail("--search-runs must be an integer >= 3");
  if (opts.writeMode === "full" && opts.rows > 20000) fail("--write-mode full at >20000 rows is hours; use marginal");
  return opts;
}

function fail(msg) {
  console.error(`[scale-bench] ${msg}`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// tsx re-exec: plain `node` cannot import the repo's .ts sources because their
// internal imports carry .js specifiers that only a bundler/loader resolves.
// Re-exec once under the repo's own tsx devDependency; npx would also work but
// resolving the local binary keeps it offline and ~1 s faster.
// ---------------------------------------------------------------------------

function looksLikeMissingLoader(err) {
  const msg = String(err?.message ?? err);
  return /Unknown file extension|ERR_UNKNOWN_FILE_EXTENSION|ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX|Cannot find module .*\.js['"]|ERR_MODULE_NOT_FOUND|Cannot find package 'tsx'/i.test(msg);
}

function reexecUnderTsx() {
  const cli = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  if (!existsSync(cli)) {
    console.error(
      `[scale-bench] cannot import the TS sources under plain node and node_modules/tsx is missing.\n` +
      `              install it (npm i -D tsx) or run: npx tsx scripts/scale-bench.mjs <args>`
    );
    process.exit(2);
  }
  const res = spawnSync(process.execPath, [cli, SELF, ...process.argv.slice(2)], {
    cwd: process.cwd(),
    stdio: "inherit",
    env: { ...process.env, SCALE_BENCH_TSX: "1" }
  });
  process.exit(res.status ?? 2);
}

async function loadModules() {
  const load = (rel) => import(pathToFileURL(join(ROOT, rel)).href);
  const [svc, store, hash] = await Promise.all([
    load(SRC.memoryService),
    load(SRC.sqliteStore),
    load(SRC.hashEmbedder)
  ]);
  return {
    MemoryService: svc.MemoryService,
    SqliteVectorStore: store.SqliteVectorStore,
    HashEmbeddingProvider: hash.HashEmbeddingProvider
  };
}

// ---------------------------------------------------------------------------
// Corpus
// ---------------------------------------------------------------------------

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `Session 7 (2026-04-18): cache token ...` — same shape as the original probe. */
function synthText(i, chars, seed) {
  const rnd = mulberry32((seed ^ Math.imul(i + 1, 0x9e3779b1)) >>> 0);
  const month = 1 + (i % 9);
  const day = String(1 + ((i * 7) % 28)).padStart(2, "0");
  const parts = [`Session ${i} (2026-0${month}-${day}):`];
  let len = parts[0].length + 1;
  while (len < chars) {
    const w = VOCAB[Math.floor(rnd() * VOCAB.length)];
    parts.push(w);
    len += w.length + 1;
  }
  // One rare codename per row (df ≈ 1/64) so the query can actually match.
  parts.push(topic(i));
  return parts.join(" ");
}

/**
 * Deterministic dense embedder for widths the repo has no local provider for.
 * Fills every dimension (a real 2048-d provider does) so the stored BLOB — and
 * therefore bytes/row and the scan cost — has the same shape as production.
 * Seeded from the text, so identical text always embeds identically. No I/O.
 */
function makeDenseEmbedder(dim) {
  const fnv = (s) => {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  };
  const one = (text) => {
    const vec = new Array(dim);
    let x = fnv(text) || 1;
    let sum = 0;
    for (let i = 0; i < dim; i++) {
      // xorshift32 keeps the generator deterministic and allocation-free.
      x ^= x << 13; x >>>= 0;
      x ^= x >>> 17;
      x ^= x << 5; x >>>= 0;
      const v = (x / 4294967296) * 2 - 1;
      vec[i] = v;
      sum += v * v;
    }
    const inv = 1 / Math.sqrt(sum || 1);
    for (let i = 0; i < dim; i++) vec[i] *= inv;
    return vec;
  };
  return {
    name: `synthetic-dense-${dim}`,
    dim,
    model: null,
    async embed(text) { return one(text); },
    async embedBatch(texts) { return texts.map(one); }
  };
}

// ---------------------------------------------------------------------------
// Small stats helpers
// ---------------------------------------------------------------------------

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] * (1 - (idx - lo)) + sorted[hi] * (idx - lo);
}

function stats(latencies) {
  const s = [...latencies].sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  return {
    samples: s.length,
    p50Ms: round(percentile(s, 0.5)),
    p95Ms: round(percentile(s, 0.95)),
    minMs: round(s[0] ?? 0),
    maxMs: round(s[s.length - 1] ?? 0),
    meanMs: round(s.length ? sum / s.length : 0)
  };
}

const round = (n, digits = 2) => Math.round(n * 10 ** digits) / 10 ** digits;
const mb = (bytes) => round(bytes / 1024 / 1024);
const gib = (bytes) => round(bytes / 1024 / 1024 / 1024, 3);

function fileSize(p) {
  try { return statSync(p).size; } catch { return 0; }
}

function gitInfo() {
  try {
    const rev = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" })
      .split(/\r?\n/).filter(Boolean).length;
    return { rev, dirtyFiles: dirty };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------

/**
 * Populate the corpus through the real import path. Preference order:
 * service.saveMany (current) -> store.insertMany -> per-row store.insert
 * (old trees), so the same script can be run against the pre-rewrite code.
 */
async function seedCorpus({ service, store, texts, nsFor, opts, sampleRss }) {
  const t0 = performance.now();
  let inserted = 0;
  let path;
  let batchSize = opts.batch;
  const makeInput = (text, index) => ({
    namespace: nsFor(index),
    type: "episodic",
    text,
    importance: 0.6,
    source: "scale-bench",
    tags: ["bench"]
  });

  if (typeof service.saveMany === "function") {
    path = "service.saveMany";
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize).map((text, j) => makeInput(text, i + j));
      const res = await service.saveMany(batch, { reconcile: false });
      inserted += res.memories.length;
      sampleRss();
    }
  } else if (typeof store.insertMany === "function") {
    path = "store.insertMany";
    for (let i = 0; i < texts.length; i += batchSize) {
      const chunk = texts.slice(i, i + batchSize);
      const embeddings = await service.embedder.embedBatch(chunk, { inputType: "passage" });
      const items = chunk.map((text, j) => ({ input: makeInput(text, i + j), embedding: embeddings[j] }));
      await store.insertMany(items);
      inserted += items.length;
      sampleRss();
    }
  } else {
    path = "store.insert";
    batchSize = 1;
    for (let i = 0; i < texts.length; i += batchSize) {
      const chunk = texts.slice(i, i + batchSize);
      const embeddings = await service.embedder.embedBatch(chunk, { inputType: "passage" });
      for (let j = 0; j < chunk.length; j++) {
        await store.insert(makeInput(chunk[j], i + j), embeddings[j]);
        inserted++;
      }
      sampleRss();
    }
  }

  const ms = performance.now() - t0;
  return { path, batchSize, rows: inserted, ms: round(ms), rowsPerSec: round(inserted / (ms / 1000)) };
}

/**
 * The running-agent write: service.save() one row at a time at full corpus
 * size. With reconcile on this is a 5-neighbour full-partition scan per row,
 * so the number is the marginal cost at N, not a full-load estimate.
 */
async function measureSaveMarginal({ service, nsFor, opts, startIndex, sampleRss }) {
  const latencies = [];
  for (let i = 0; i < opts.saveSamples; i++) {
    const input = {
      namespace: nsFor(startIndex + i),
      type: "episodic",
      text: synthText(startIndex + i, opts.textChars, opts.seed),
      importance: 0.6,
      source: "scale-bench",
      tags: ["bench"]
    };
    const t0 = performance.now();
    await service.save(input);
    latencies.push(performance.now() - t0);
    if (i % 10 === 9) sampleRss();
  }
  const s = stats(latencies);
  return {
    samples: s.samples,
    meanMs: s.meanMs,
    p50Ms: s.p50Ms,
    p95Ms: s.p95Ms,
    rowsPerSec: round(1000 / (s.meanMs || 1))
  };
}

/** End-to-end search plus the store-level phases the two-phase read touched. */
async function measureSearch({ service, opts, searchNs, sampleRss }) {
  const queryEmbedding = await service.embedder.embed(QUERY, { inputType: "query" });
  const call = () =>
    service.search({
      query: QUERY,
      namespace: searchNs,
      k: opts.k,
      budgetTokens: opts.budget,
      threshold: opts.threshold
    });

  for (let i = 0; i < opts.warmup; i++) await call();
  const latencies = [];
  let last = null;
  for (let i = 0; i < opts.searchRuns; i++) {
    const t0 = performance.now();
    last = await call();
    latencies.push(performance.now() - t0);
  }
  sampleRss();

  const result = {
    ...stats(latencies),
    latenciesMs: latencies.map((n) => round(n)),
    hits: last?.memories?.length ?? 0,
    tokensUsed: last?.tokensUsed ?? 0
  };

  if (opts.storePhases) {
    const store = service.store;
    const p50 = async (fn, runs = 5) => {
      const ts = [];
      for (let i = 0; i < runs; i++) {
        const t0 = performance.now();
        await fn();
        ts.push(performance.now() - t0);
      }
      return round(stats(ts).p50Ms);
    };
    result.store = {
      vectorSearchP50Ms: await p50(() =>
        store.vectorSearch({
          namespace: searchNs,
          queryEmbedding,
          limit: Math.max(20, opts.k * 4),
          includeDeleted: false
        })
      ),
      lexicalCandidatesP50Ms:
        typeof store.lexicalCandidates === "function"
          ? await p50(() =>
              store.lexicalCandidates({
                namespace: searchNs,
                query: QUERY,
                limit: Math.max(20, opts.k * 4),
                includeDeleted: false
              })
            )
          : null,
      cosineSpreadP50Ms:
        opts.vectorWeight > 0 && typeof store.cosineSpread === "function"
          ? await p50(() => store.cosineSpread({ namespace: searchNs, queryEmbedding }), 3)
          : null
    };
  }
  return result;
}

/**
 * On-disk size. The store is already closed by the time this runs; a fresh
 * connection checkpoints any WAL left behind so dbBytes is the real file, not
 * the file plus an unmerged journal.
 */
async function measureStorage(dbPath) {
  let checkpointError = null;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath);
    try {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
      db.close();
    }
  } catch (err) {
    checkpointError = String(err?.message ?? err);
  }
  const dbBytes = fileSize(dbPath);
  const walBytes = fileSize(dbPath + "-wal");
  return { dbBytes, walBytes, dbMB: mb(dbBytes), walMB: mb(walBytes), checkpointError };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(mods) {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(HELP); return; }

  const startedAt = new Date();
  const tmpRoot = mkdtempSync(join(tmpdir(), "scale-bench-"));
  const dbPath = join(tmpRoot, "memory.db");

  // Pin the retrieval knobs BEFORE the service/retriever is constructed: the
  // hybrid weights are read in the constructor, reconcile is read per write.
  process.env.MEMORY_VECTOR_WEIGHT = String(opts.vectorWeight);
  process.env.MEMORY_RECONCILE = opts.reconcile ? "on" : "off";

  const rssSamples = [];
  const sampleRss = () => rssSamples.push(process.memoryUsage().rss);
  sampleRss();

  let service = null;
  let storeClosed = false;
  try {
    const { MemoryService, SqliteVectorStore, HashEmbeddingProvider } = mods;

    const embedder = opts.dim === 384 ? new HashEmbeddingProvider() : makeDenseEmbedder(opts.dim);
    const store = new SqliteVectorStore(dbPath);
    service = new MemoryService({ store, embedder, dbPath });
    await service.init();
    sampleRss();

    const baseNs = opts.namespace;
    const nsCount = opts.ns;
    const nsFor = (index) => (nsCount === 1 ? baseNs : `${baseNs}:${index % nsCount}`);
    const searchNs = opts.searchNamespace ?? (nsCount === 1 ? baseNs : `${baseNs}:0`);

    const corpus = Array.from({ length: opts.rows }, (_, i) => synthText(i, opts.textChars, opts.seed));
    const avgChars = round(corpus.reduce((sum, t) => sum + t.length, 0) / corpus.length, 1);
    const avgWords = round(corpus.reduce((sum, t) => sum + t.split(" ").length, 0) / corpus.length, 1);

    // --- write -----------------------------------------------------------
    let write;
    if (opts.writeMode === "full") {
      const t0 = performance.now();
      for (let i = 0; i < corpus.length; i++) {
        await service.save({
          namespace: nsFor(i),
          type: "episodic",
          text: corpus[i],
          importance: 0.6,
          source: "scale-bench",
          tags: ["bench"]
        });
        if (i % 100 === 99) sampleRss();
      }
      const ms = performance.now() - t0;
      write = {
        mode: "full",
        reconcile: opts.reconcile,
        path: "service.save",
        rows: corpus.length,
        ms: round(ms),
        rowsPerSec: round(corpus.length / (ms / 1000)),
        meanMsPerRow: round(ms / corpus.length)
      };
    } else {
      const bulk = await seedCorpus({ service, store, texts: corpus, nsFor, opts, sampleRss });
      const save = await measureSaveMarginal({
        service,
        nsFor,
        opts,
        startIndex: corpus.length,
        sampleRss
      });
      write = {
        mode: "marginal",
        reconcile: opts.reconcile,
        bulk,
        save,
        rows: bulk.rows + save.samples,
        // Headline throughput = the import path; the per-row save is reported
        // beside it because they are two different costs.
        rowsPerSec: bulk.rowsPerSec
      };
    }
    sampleRss();

    // --- search ----------------------------------------------------------
    const search = await measureSearch({ service, opts, searchNs, sampleRss });

    // --- storage ---------------------------------------------------------
    const totalRows = write.rows;
    service.close();
    storeClosed = true;
    const storage = await measureStorage(dbPath);
    const bytesPerRow = Math.round(storage.dbBytes / totalRows);

    // --- projection ------------------------------------------------------
    // The vector arm is still a scan of one partition, and --ns keeps the number
    // of rows per partition proportional to rows, so that factor covers it.
    //
    // The lexical arm is NOT linear any more (ADR-0033): a rare query token is
    // answered from the posting list, so its cost tracks how many rows hold the
    // token, not how large the partition is. Extrapolating the whole search
    // linearly therefore overstates the projection once the lexical arm stops
    // dominating, and *understates* nothing — which is why the two arms are
    // projected separately instead of multiplying the total. `linear` is kept so
    // the number stays comparable with every earlier published run; `components`
    // says which way each arm moves.
    const scale = 100000 / totalRows;
    const vectorMs = search.store?.vectorSearchP50Ms ?? null;
    const lexicalMs = search.store?.lexicalCandidatesP50Ms ?? null;
    const projection = {
      rows: 100000,
      sameNamespaces: nsCount,
      searchP50Ms: round(search.p50Ms * scale),
      searchP95Ms: round(search.p95Ms * scale),
      // Per-arm projection. The vector arm scales with partition rows; the lexical
      // arm is bounded by df, which this corpus keeps at ~1/64 of the partition, so
      // the honest label for it is "unchanged by row count, grows with postings".
      vectorP50MsLinear: vectorMs === null ? null : round(vectorMs * scale),
      lexicalP50MsAtThisSize: lexicalMs === null ? null : round(lexicalMs),
      dbBytes: Math.round(bytesPerRow * 100000),
      dbGB: gib(bytesPerRow * 100000)
    };

    // --- assert ----------------------------------------------------------
    const checks = [
      {
        name: "search.p95Ms",
        kind: "max",
        value: search.p95Ms,
        limit: opts.maxSearchP95,
        ok: search.p95Ms < opts.maxSearchP95
      },
      {
        name: "write.rowsPerSec",
        kind: "min",
        value: write.rowsPerSec,
        limit: opts.minRowsPerSec,
        ok: write.rowsPerSec >= opts.minRowsPerSec
      }
    ];
    const ok = checks.every((c) => c.ok);

    const rssPeak = Math.max(...rssSamples);
    const runtime = {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpus: cpus().length
    };

    const full = {
      schema: SCHEMA,
      generatedAt: startedAt.toISOString(),
      durationMs: round(performance.now() - startedAt),
      git: gitInfo(),
      runtime,
      storePath: dbPath,
      params: {
        rows: opts.rows,
        dim: opts.dim,
        ns: nsCount,
        namespace: baseNs,
        searchNs,
        seed: opts.seed,
        textChars: opts.textChars,
        writeMode: opts.writeMode,
        batch: opts.batch,
        saveSamples: opts.saveSamples,
        searchRuns: opts.searchRuns,
        warmup: opts.warmup,
        k: opts.k,
        budget: opts.budget,
        threshold: opts.threshold,
        vectorWeight: opts.vectorWeight,
        reconcile: opts.reconcile,
        embedder: embedder.name
      },
      env: {
        MEMORY_VECTOR_WEIGHT: process.env.MEMORY_VECTOR_WEIGHT,
        MEMORY_RECONCILE: process.env.MEMORY_RECONCILE,
        MEMORY_ASSEMBLE: process.env.MEMORY_ASSEMBLE ?? null
      },
      corpus: {
        rows: opts.rows,
        totalRows,
        rowsPerNamespace: round(totalRows / nsCount),
        avgChars,
        avgWords
      },
      write,
      search,
      storage: { ...storage, bytesPerRow },
      memory: {
        rssBeforeMB: mb(rssSamples[0]),
        rssPeakMB: mb(rssPeak),
        rssAfterMB: mb(rssSamples[rssSamples.length - 1])
      },
      projection,
      checks,
      asserted: opts.assert,
      ok
    };

    if (opts.out) {
      const outPath = resolve(process.cwd(), opts.out);
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, JSON.stringify(full, null, 2) + "\n", "utf8");
    }

    // One-line JSON on stdout: drop raw latency arrays (they live in --out).
    const compact = {
      schema: full.schema,
      generatedAt: full.generatedAt,
      git: full.git,
      params: full.params,
      corpus: full.corpus,
      write: full.write,
      search: {
        samples: full.search.samples,
        p50Ms: full.search.p50Ms,
        p95Ms: full.search.p95Ms,
        minMs: full.search.minMs,
        maxMs: full.search.maxMs,
        meanMs: full.search.meanMs,
        hits: full.search.hits,
        tokensUsed: full.search.tokensUsed,
        ...(full.search.store ? { store: full.search.store } : {})
      },
      storage: {
        dbBytes: full.storage.dbBytes,
        walBytes: full.storage.walBytes,
        dbMB: full.storage.dbMB,
        bytesPerRow: full.storage.bytesPerRow,
        checkpointError: full.storage.checkpointError
      },
      memory: full.memory,
      projection: full.projection,
      checks: full.checks,
      asserted: full.asserted,
      ok: full.ok
    };
    console.log(JSON.stringify(compact));

    if (!opts.quiet) {
      const saveLine =
        write.mode === "marginal"
          ? `save ${write.save.meanMs} ms/row (${write.save.rowsPerSec} rows/s marginal)`
          : `save ${write.meanMsPerRow} ms/row`;
      console.error(
        `[scale-bench] ${opts.rows} rows @${opts.dim}d / ${nsCount} ns, ${full.runtime.node} — ` +
        `bulk ${write.rowsPerSec} rows/s (${write.bulk?.path ?? "full save"} x${write.bulk?.batchSize ?? 1}), ` +
        `${saveLine}, search p50 ${search.p50Ms} ms / p95 ${search.p95Ms} ms, ` +
        `db ${storage.dbMB} MB (${bytesPerRow} B/row), rss peak ${full.memory.rssPeakMB} MB` +
        (full.projection ? ` | 10^5 projection: ${projection.searchP50Ms}/${projection.searchP95Ms} ms, ${projection.dbGB} GB` : "")
      );
    }

    if (opts.assert && !ok) {
      for (const c of checks.filter((c) => !c.ok)) {
        console.error(
          `[scale-bench] FAIL ${c.name} = ${c.value} (${c.kind === "max" ? "limit <" : "limit >="} ${c.limit})`
        );
      }
      process.exitCode = 1;
    }
  } catch (err) {
    const msg = String(err?.stack ?? err);
    console.error(`[scale-bench] ${msg}`);
    process.exitCode = 2;
  } finally {
    if (!storeClosed) {
      try { service?.close(); } catch { /* already closed */ }
    }
    if (!opts.keepDb) {
      try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ }
    } else {
      console.error(`[scale-bench] kept temp db: ${dbPath}`);
    }
  }
}

// --- boot ------------------------------------------------------------------
let loaded = null;
let loadError = null;
try {
  loaded = await loadModules();
} catch (err) {
  loadError = err;
}

if (!loaded) {
  if (process.env.SCALE_BENCH_TSX !== "1" && looksLikeMissingLoader(loadError)) {
    reexecUnderTsx();
  } else {
    console.error(`[scale-bench] cannot load src/*.ts: ${loadError?.message ?? loadError}`);
    process.exit(2);
  }
} else {
  await main(loaded);
}
