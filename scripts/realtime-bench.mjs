#!/usr/bin/env node
/**
 * realtime-bench — what the memory system does while it is being used.
 *
 * The other two benchmarks answer different questions:
 *   bench/run-locomo.mjs  accuracy against a fixed dataset (one shot, offline reader)
 *   scripts/scale-bench.mjs  cost of a corpus size (closed loop, no churn)
 * Neither measures the thing an agent actually experiences: writes and searches
 * arriving at the same time, at a rate, for minutes, with the index moving
 * underneath the query. This one does.
 *
 * DESIGN (ADR-0024)
 *   - Open loop. Requests are scheduled at `--rate` per second whether or not the
 *     previous one has finished. A closed loop (await in a for-loop) reports the
 *     latency of a client that politely waits, so queueing never shows up. Here
 *     the client keeps its pace, in-flight work is bounded by `--workers`, and
 *     every request that could not even be issued is counted as `dropped` —
 *     which is a result, not an error.
 *   - Real quality, not just latency. Every seeded fact carries a rare marker
 *     (`zq1042`); a search is scored by the rank at which that marker comes back.
 *     Because writes keep arriving during the run, `recall@5` here is recall
 *     under churn — the number a growing store has, not the one a frozen fixture
 *     has.
 *   - Live, per second. The run prints one line per second and the report keeps
 *     the series. A run that averages 8 ms and stalls for two seconds is a failed
 *     run, and only the series shows it.
 *   - Same stack as production: `MemoryService` + `SqliteVectorStore` on a
 *     throwaway file in the temp dir, default hash embedder (no network, no key).
 *     `--embedder nim` switches to the 2048-dim NIM provider when a key is set.
 *
 * Usage:
 *   node scripts/realtime-bench.mjs                              # 30 s, 60 req/s, 16 workers
 *   node scripts/realtime-bench.mjs --duration 60 --rate 120     # push it
 *   node scripts/realtime-bench.mjs --sync-every 2 --json        # churn the knowledge index too
 *   node scripts/realtime-bench.mjs --assert                      # CI gate
 *   node scripts/realtime-bench.mjs --out bench/results/realtime.json
 *
 * Exit codes: 0 ok, 1 assertion failed, 2 usage / runtime error.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SELF), "..");
const SCHEMA = "realtime-bench/1";

const DEFAULTS = {
  duration: 30,
  rate: 60,
  workers: 16,
  facts: 400,
  queries: 300,
  projects: 4,
  seed: 7,
  k: 5,
  budget: 800,
  threshold: 0.35,
  syncEvery: 5,
  syncPages: 12,
  vaultPages: 12,
  embedder: "hash",
  tag: "realtime",
  out: "",
  json: false,
  assert: false,
  maxSearchP95: 250,
  minRecall5: 0.9,
  minRecall5Bare: 0.98,
  minRecall5Noisy: 0.85,
  minRecall5Cjk: 0.6,
  keep: false
};

const OPS = [
  ["search", 45],
  ["write", 30],
  ["list", 10],
  ["brief", 10],
  ["knowledge", 5]
];

function fail(msg) {
  console.error(`[realtime-bench] ${msg}`);
  process.exit(2);
}

function usage() {
  console.error(
    `usage: node scripts/realtime-bench.mjs [options]\n\n` +
      Object.entries(DEFAULTS)
        .map(([k, v]) => `  --${k.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase())}  (default ${JSON.stringify(v)})`)
        .join("\n")
  );
}

function parseArgs(argv) {
  const out = { ...DEFAULTS };
  const numeric = new Set([
    "duration", "rate", "workers", "facts", "queries", "projects", "seed", "k",
    "budget", "threshold", "syncEvery", "syncPages", "vaultPages", "maxSearchP95",
    "minRecall5", "minRecall5Bare", "minRecall5Noisy", "minRecall5Cjk"
  ]);
  const bool = new Set(["json", "assert", "keep"]);
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    if (!raw.startsWith("--")) fail(`unexpected argument: ${raw}`);
    const [flag, inline] = raw.slice(2).split("=");
    const key = flag.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (key === "help") {
      usage();
      process.exit(0);
    }
    if (!(key in out)) fail(`unknown option: --${flag}`);
    if (bool.has(key)) {
      out[key] = inline === undefined ? true : inline !== "false";
      continue;
    }
    const value = inline ?? argv[++i];
    if (value === undefined) fail(`--${flag} needs a value`);
    if (numeric.has(key)) {
      const n = Number(value);
      if (!Number.isFinite(n)) fail(`--${flag} must be a number`);
      out[key] = n;
    } else {
      out[key] = value;
    }
  }
  return out;
}

// --- tsx re-exec (same reason as scale-bench: plain node cannot load src/*.ts) ---
function looksLikeMissingLoader(err) {
  const msg = String(err?.message ?? err);
  return /Unknown file extension|ERR_UNKNOWN_FILE_EXTENSION|ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX|Cannot find module .*\.js['"]|ERR_MODULE_NOT_FOUND|Cannot find package 'tsx'/i.test(
    msg
  );
}

function reexecUnderTsx() {
  const cli = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  if (!existsSync(cli)) {
    console.error("[realtime-bench] node_modules/tsx is missing; run: npm i -D tsx");
    process.exit(2);
  }
  const res = spawnSync(process.execPath, [cli, SELF, ...process.argv.slice(2)], {
    cwd: process.cwd(),
    stdio: "inherit",
    env: { ...process.env, REALTIME_BENCH_TSX: "1" }
  });
  process.exit(res.status ?? 2);
}

async function loadModules(opts) {
  const load = (rel) => import(pathToFileURL(join(ROOT, rel)).href);
  const [svc, store, hash, bench, embeddings] = await Promise.all([
    load("src/core/memoryService.ts"),
    load("src/core/store/sqlite.ts"),
    load("src/core/embedding/hash.ts"),
    load("src/bench/realtime.ts"),
    load("src/core/embedding/index.ts")
  ]);
  let embedder;
  if (opts.embedder === "nim") {
    embedder = embeddings.createEmbeddingProvider({ ...process.env, EMBEDDING_PROVIDER: "nim" });
  } else if (opts.embedder === "hash") {
    embedder = new hash.HashEmbeddingProvider();
  } else {
    fail(`--embedder must be hash or nim (got ${opts.embedder})`);
  }
  return {
    MemoryService: svc.MemoryService,
    SqliteVectorStore: store.SqliteVectorStore,
    embedder,
    ...bench
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** SQLite keeps most of the write in the WAL until a checkpoint; report the footprint. */
function footprint(db) {
  let total = 0;
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      total += statSync(db + suffix).size;
    } catch {
      /* file absent */
    }
  }
  return total;
}

function human(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function makeVault(dir, pages, sections) {
  mkdirSync(dir, { recursive: true });
  const pageIds = [];
  for (let p = 0; p < pages; p++) {
    const id = `page-${p}`;
    pageIds.push(id);
    const body = Array.from({ length: sections }, (_, s) => {
      const next = (p + 1) % pages;
      return `## Section ${s}\n\nKnowledge page ${id} section ${s} explains how the pipeline stage ${s} behaves, and it links to [[page-${next}]].`;
    }).join("\n\n");
    writeFileSync(join(dir, `${id}.md`), `---\ntitle: Page ${p}\nslug: ${id}\n---\n\n${body}\n`, "utf8");
  }
  return pageIds;
}

/** Rewrite one section so each sync embeds exactly one section (real write work). */
function churnVault(dir, round) {
  const id = `page-${round % 12}`;
  writeFileSync(
    join(dir, `${id}.md`),
    `---\ntitle: Page ${round}\nslug: ${id}\n---\n\n## Section 0\n\nKnowledge page ${id} section 0 was rewritten in sync round ${round}, which changes one rendered section and leaves the others alone.\n\n## Section 1\n\nKnowledge page ${id} section 1 explains how the pipeline stage 1 behaves.\n`,
    "utf8"
  );
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.duration <= 0) fail("--duration must be > 0");
  if (opts.rate <= 0) fail("--rate must be > 0");
  if (opts.workers <= 0) fail("--workers must be > 0");

  let mods;
  try {
    mods = await loadModules(opts);
  } catch (err) {
    // Plain `node` cannot resolve the repo's `.js`-specifier imports of `.ts` sources;
    // the catch is here, before anything is created, so the re-exec leaves no temp state.
    if (looksLikeMissingLoader(err) && process.env.REALTIME_BENCH_TSX !== "1") reexecUnderTsx();
    throw err;
  }
  const { MemoryService, embedder, percentile, bucketSeries, summarizeRun, buildCorpus, buildQueries, rankOf, SEARCH_BUDGET } = mods;

  const tmp = mkdtempSync(join(tmpdir(), "ai-memory-realtime-"));
  const db = join(tmp, "realtime.db");
  const vault = join(tmp, "vault");
  const NS = "realtime-bench:user";

  let svc;
  try {
    makeVault(vault, opts.vaultPages, 3);
    svc = new MemoryService({ dbPath: db, embedder });
    await svc.init();

    // --- seed -----------------------------------------------------------------
    const facts = buildCorpus({ facts: opts.facts, projects: opts.projects, seed: opts.seed });
    const queries = buildQueries(facts, { queries: opts.queries, seed: opts.seed + 1 });
    const seedStart = Date.now();
    await svc.saveMany(
      facts.map((f) => ({ namespace: NS, project: f.project, kind: f.kind, type: f.type, text: f.text, source: "bench:seed" })),
      { reconcile: false }
    );
    await svc.syncKnowledge({ dir: vault, namespace: NS, project: "bench-project-0" });
    const seedMs = Date.now() - seedStart;
    const bytesBefore = footprint(db);

    // --- run ------------------------------------------------------------------
    const plan = OPS.flatMap(([op, weight]) => Array.from({ length: weight }, () => op));
    const samples = [];
    const started = Date.now();
    const stopAt = started + opts.duration * 1000;
    const interval = 1000 / opts.rate;
    let issued = 0;
    let inflight = 0;
    let dropped = 0;
    let writeSeq = 0;
    let syncRuns = 0;
    let syncError = null;

    const record = (sample) => samples.push(sample);

    const runSearch = async () => {
      const q = queries[Math.floor(Math.random() * queries.length)];
      const t0 = performance.now();
      const res = await svc.search({
        query: q.query,
        namespace: NS,
        k: opts.k,
        budgetTokens: opts.budget,
        threshold: opts.threshold
      });
      const ms = performance.now() - t0;
      const texts = res.memories.map((m) => m.text);
      return {
        op: "search",
        ms,
        ok: true,
        rank: rankOf(texts, q.token),
        mode: q.mode,
        tokensUsed: res.tokensUsed,
        truncated: res.truncated
      };
    };

    const runWrite = async () => {
      writeSeq++;
      const fact = facts[writeSeq % facts.length];
      const text = `${fact.text} Live write ${writeSeq} adds marker zw${writeSeq} to the corpus while searches are running.`;
      const t0 = performance.now();
      const res = await svc.saveDetailed({
        namespace: NS,
        project: fact.project,
        kind: "note",
        type: "episodic",
        text,
        source: "bench:live"
      });
      return { op: "write", ms: performance.now() - t0, ok: true, action: res.decision.action };
    };

    const runList = async () => {
      const t0 = performance.now();
      await svc.list({ namespace: NS, limit: 20 });
      return { op: "list", ms: performance.now() - t0, ok: true };
    };

    const runBrief = async () => {
      const t0 = performance.now();
      await svc.brief({ namespaces: [NS], budgetTokens: 600 });
      return { op: "brief", ms: performance.now() - t0, ok: true };
    };

    const runKnowledge = async () => {
      const t0 = performance.now();
      await svc.knowledge({ namespaces: [NS] });
      return { op: "knowledge", ms: performance.now() - t0, ok: true };
    };

    const RUNNERS = {
      search: runSearch,
      write: runWrite,
      list: runList,
      brief: runBrief,
      knowledge: runKnowledge
    };

    const dispatch = async (op) => {
      const t0 = performance.now();
      try {
        const sample = await RUNNERS[op]();
        record({ ...sample, at: Date.now() - started });
      } catch (err) {
        record({
          op,
          ms: performance.now() - t0,
          ok: false,
          error: String(err?.message ?? err).slice(0, 200),
          at: Date.now() - started
        });
      }
    };

    // Open-loop scheduler: fixed dispatch times, bounded in-flight, drops counted.
    const pump = async () => {
      while (Date.now() < stopAt) {
        const due = started + issued * interval;
        const wait = due - Date.now();
        if (wait > 0) await sleep(Math.min(wait, 20));
        if (Date.now() < due) continue;
        if (Date.now() >= stopAt) break;
        const op = plan[issued % plan.length];
        issued++;
        if (inflight >= opts.workers) {
          dropped++;
          continue;
        }
        inflight++;
        void dispatch(op).finally(() => {
          inflight--;
        });
      }
      while (inflight > 0) await sleep(10);
    };

    // Knowledge churn: a separate clock, because sync is not a per-request op.
    const syncTimer = setInterval(async () => {
      if (Date.now() >= stopAt || syncError) return;
      syncRuns++;
      const t0 = performance.now();
      try {
        churnVault(vault, syncRuns);
        const report = await svc.syncKnowledge({ dir: vault, namespace: NS, project: "bench-project-0" });
        record({
          op: "sync",
          ms: performance.now() - t0,
          ok: true,
          at: Date.now() - started,
          truncate: report.truncated
        });
      } catch (err) {
        syncError = String(err?.message ?? err);
        record({ op: "sync", ms: performance.now() - t0, ok: false, error: syncError.slice(0, 200), at: Date.now() - started });
      }
    }, opts.syncEvery * 1000);

    // Live line per second: the "real time" part of the report.
    let liveSecond = 0;
    const liveTimer = setInterval(() => {
      liveSecond++;
      const elapsed = Date.now() - started;
      const mine = samples.filter((s) => s.at >= (liveSecond - 1) * 1000 && s.at < liveSecond * 1000);
      const searches = mine.filter((s) => s.op === "search");
      const durations = mine.map((s) => s.ms);
      const hits = searches.filter((s) => s.rank !== null && s.rank <= 5).length;
      const errs = mine.filter((s) => !s.ok).length;
      const line =
        `[${String(liveSecond).padStart(3)}s] ` +
        `${String(Math.round(mine.length)).padStart(3)} ops/s  ` +
        `p50 ${String(Math.round(percentile(durations, 0.5))).padStart(3)}ms  ` +
        `p95 ${String(Math.round(percentile(durations, 0.95))).padStart(4)}ms  ` +
        `search p95 ${String(searches.length ? Math.round(percentile(searches.map((s) => s.ms), 0.95)) : 0).padStart(4)}ms  ` +
        `recall@5 ${searches.length ? (hits / searches.length).toFixed(2) : "-"}  ` +
        `err ${errs}  ` +
        `dropped ${dropped}  ` +
        `inflight ${inflight}`;
      console.error(line);
      if (elapsed >= opts.duration * 1000) clearInterval(liveTimer);
    }, 1000);

    console.error(
      `[realtime-bench] ${opts.facts} facts, ${opts.queries} queries, ${opts.vaultPages} vault pages; ` +
        `seeded in ${seedMs} ms; running ${opts.duration}s at ${opts.rate} req/s (${opts.workers} workers)`
    );
    await pump();
    clearInterval(syncTimer);
    clearInterval(liveTimer);
    const durationMs = Date.now() - started;

    // --- report ---------------------------------------------------------------
    const summary = summarizeRun(samples, { durationMs, issued, dropped });
    const series = bucketSeries(samples, durationMs);
    const bytesAfter = footprint(db);
    const listed = await svc.list({ namespace: NS, limit: 1 });
    const syncs = samples.filter((s) => s.op === "sync");
    const report = {
      schema: SCHEMA,
      tag: opts.tag,
      startedAt: new Date(started).toISOString(),
      config: {
        durationMs,
        rate: opts.rate,
        workers: opts.workers,
        facts: opts.facts,
        queries: opts.queries,
        projects: opts.projects,
        seed: opts.seed,
        k: opts.k,
        budget: opts.budget,
        threshold: opts.threshold,
        syncEveryS: opts.syncEvery,
        embedder: embedder.name
      },
      summary,
      series,
      db: { bytesBefore, bytesAfter, rows: listed.total, rowsPerWrite: null },
      sync: {
        runs: syncs.length,
        error: syncError,
        p50: syncs.length ? Math.round(percentile(syncs.map((s) => s.ms), 0.5)) : 0,
        max: syncs.length ? Math.round(Math.max(...syncs.map((s) => s.ms))) : 0
      },
      verdict: null
    };
    report.db.rowsPerWrite = writeSeq > 0 ? Math.round((listed.total * 100) / writeSeq) / 100 : null;

    const searchP95 = summary.ops.search?.p95 ?? 0;
    // Recall is gated per query shape, not pooled. A pooled floor hides the failure
    // that matters: with the default hash embedder (Latin-only tokenizer) a third of
    // the questions are Chinese, and their recall is half of the English one. Each
    // floor is a regression guard for this embedder, not a claim about the product;
    // `--min-recall5` stays informational and is printed above the table.
    const RECALL_FLOORS = {
      bare: opts.minRecall5Bare,
      noisy: opts.minRecall5Noisy,
      cjk: opts.minRecall5Cjk
    };
    const recallGates = Object.entries(summary.quality.byMode)
      .filter(([mode]) => RECALL_FLOORS[mode] !== undefined)
      .map(([mode, q]) => [`recall@5 ${mode} >= ${RECALL_FLOORS[mode]}`, q.recall5 >= RECALL_FLOORS[mode]]);
    const gates = [
      ["errors", summary.errors === 0],
      ["dropped", summary.dropped === 0],
      [`search p95 <= ${opts.maxSearchP95}ms`, searchP95 <= opts.maxSearchP95],
      ...recallGates,
      ["budget not overrun", summary.quality.budgetOverBudget === 0],
      ["no sync errors", syncError === null]
    ];
    report.verdict = { ok: gates.every(([, ok]) => ok), gates: gates.map(([name, ok]) => ({ name, ok })) };

    // Human summary on stderr, one JSON line on stdout (CI/diff friendly).
    const pad = (s, n) => String(s).padStart(n);
    console.error("");
    console.error(`op          count    p50     p95     p99     max`);
    for (const [op, s] of Object.entries(summary.ops)) {
      console.error(`${op.padEnd(10)}${pad(s.count, 7)}${pad(s.p50, 8)}${pad(s.p95, 8)}${pad(s.p99, 8)}${pad(s.max, 8)}`);
    }
    console.error("");
    console.error(
      `throughput ${summary.throughput} op/s  errors ${summary.errors}  dropped ${summary.dropped}  ` +
        `stall ${summary.stallMs}ms  issued ${summary.issued}`
    );
    console.error(
      `search: recall@1 ${summary.quality.recall1}  recall@5 ${summary.quality.recall5}  mrr ${summary.quality.mrr}  ` +
        `empty ${summary.quality.empty}/${summary.quality.searches}  tokens mean ${summary.quality.tokensMean}/${SEARCH_BUDGET}  ` +
        `k-trimmed ${summary.quality.truncatedResults}`
    );
    for (const [mode, q] of Object.entries(summary.quality.byMode)) {
      console.error(
        `  ${mode.padEnd(6)} n=${String(q.searches).padStart(4)}  recall@1 ${q.recall1}  recall@5 ${q.recall5}  mrr ${q.mrr}  empty ${q.empty}`
      );
    }
    console.error(
      `db ${human(bytesBefore)} -> ${human(bytesAfter)}  rows ${listed.total}  syncs ${syncs.length} ` +
        `(p50 ${report.sync.p50}ms, max ${report.sync.max}ms)`
    );
    console.error(`gates: ${gates.map(([name, ok]) => `${ok ? "ok" : "FAIL"} ${name}`).join(" | ")}`);
    console.error(`verdict: ${report.verdict.ok ? "pass" : "fail"}`);

    if (opts.out) {
      mkdirSync(dirname(resolve(opts.out)), { recursive: true });
      writeFileSync(resolve(opts.out), JSON.stringify(report, null, 2), "utf8");
      console.error(`report: ${opts.out}`);
    }

    const line = JSON.stringify({
      tag: opts.tag,
      ok: report.verdict.ok,
      throughput: summary.throughput,
      errors: summary.errors,
      dropped: summary.dropped,
      stallMs: summary.stallMs,
      searchP50: summary.ops.search?.p50 ?? 0,
      searchP95,
      recall5: summary.quality.recall5,
      recall5ByMode: Object.fromEntries(Object.entries(summary.quality.byMode).map(([m, q]) => [m, q.recall5])),
      recall1: summary.quality.recall1,
      mrr: summary.quality.mrr,
      rows: listed.total,
      syncP50: report.sync.p50,
      dbBytes: bytesAfter,
      out: opts.out ? resolve(opts.out) : null
    });
    process.stdout.write(line + "\n");

    if (!opts.keep) {
      // Windows refuses to delete a directory whose SQLite handle is still open, and a
      // failed cleanup must never turn a passing run into a failing one.
      try {
        await svc.store.close();
      } catch {
        /* already closed */
      }
      try {
        rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      } catch (err) {
        console.error(`[realtime-bench] note: could not remove ${tmp}: ${err?.message ?? err}`);
      }
    }
    process.exit(opts.assert && !report.verdict.ok ? 1 : 0);
  } catch (err) {
    if (looksLikeMissingLoader(err) && process.env.REALTIME_BENCH_TSX !== "1") reexecUnderTsx();
    console.error(`[realtime-bench] failed: ${err?.stack ?? err}`);
    try {
      rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      /* best effort */
    }
    process.exit(2);
  }
}

await main();
