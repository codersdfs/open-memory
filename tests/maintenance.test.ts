import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { spawnChild, closeAllChildren } from "./helpers/child.js";
// vite's builtin list predates `node:sqlite`, so a static import is rewritten to a
// bare "sqlite" that fails to resolve — same workaround as tests/gate-audit.test.ts:7.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
import { InMemoryVectorStore } from "../src/core/store/memory.js";
import { SqliteVectorStore } from "../src/core/store/sqlite.js";
import { archiveStale, runScheduledDecay, HOTNESS_KEEP } from "../src/core/lifecycle/decay.js";
import {
  maintenanceIntervalMs,
  startMaintenance,
  runMaintenancePass,
  LAST_MAINTENANCE_AT_KEY,
  LAST_MAINTENANCE_RESULT_KEY,
  MAINTAIN_HOURS_DEFAULT
} from "../src/core/lifecycle/maintenance.js";
import { summarize } from "../src/core/stats.js";
import type { VectorStore } from "../src/core/store/interface.js";

/**
 * P2 (ADR-0016 amendment, 2026-11-07): forgetting now has a trigger. Four promises
 * below, one per group: the retrieval counter `use_count` is real on both stores
 * (and its migration is one atomic ALTER+backfill like `text_hash` before it), the
 * hotness rule replaces the binary flag without touching the durable skip or the
 * importance floor, `MEMORY_MAINTAIN_HOURS` decides the schedule (default 24, `0`
 * fully off), and the overdue store is caught up in the background — a sweep that
 * is still running must not hold up anything else, and the hard pass must not be
 * expressible from the scheduler's path at all.
 */

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 3_600_000;

const dirs: string[] = [];
afterAll(async () => {
  await closeAllChildren();
  for (const dir of dirs) {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* temp dir */ }
  }
});

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "om-maintenance-"));
  dirs.push(dir);
  return dir;
}

const settle = (ms = 5) => new Promise((r) => setTimeout(r, ms));

/** Seed one cold-for-its-window row (note, 60 days, never used, judge-rated 0.4). */
async function addStaleRow(store: InMemoryVectorStore) {
  const memory = await store.insert(
    { namespace: "a:1", type: "semantic", kind: "note", text: `row-${Math.random()}`, importance: 0.4 },
    [0.1, 0.2, 0.3]
  );
  memory.createdAt = Date.now() - 60 * DAY;
  return memory;
}

describe("use_count on reinforce (both stores)", () => {
  it("counts retrievals in memory: one per unique id per call — reinforce's set semantics, kept", async () => {
    const store = new InMemoryVectorStore();
    const a = await store.insert({ namespace: "a:1", type: "semantic", text: "alpha" }, [0.1]);
    const b = await store.insert({ namespace: "a:1", type: "semantic", text: "beta" }, [0.1]);
    expect(a.useCount).toBe(0);
    expect(await store.reinforce([a.id, b.id, a.id])).toBe(2);
    // Duplicates inside ONE call fold to one retrieval — `new Set(ids)` says so, and
    // SQLite's `WHERE id IN (...)` agrees by construction. Separate calls accumulate.
    expect((await store.getById(a.id))!.useCount).toBe(1);
    expect((await store.getById(b.id))!.useCount).toBe(1);
    expect(await store.reinforce([a.id])).toBe(1);
    expect((await store.getById(a.id))!.useCount).toBe(2);
  });

  it("counts retrievals in SQLite the same way, and the count survives a reopen", async () => {
    const file = join(tmpDir(), "store.db");
    const store = new SqliteVectorStore(file);
    await store.init();
    const a = await store.insert({ namespace: "a:1", type: "semantic", text: "alpha" }, [0.1]);
    const b = await store.insert({ namespace: "a:1", type: "semantic", text: "beta" }, [0.1]);
    expect(a.useCount).toBe(0);
    expect(await store.reinforce([a.id, b.id, a.id])).toBe(2);
    expect((await store.getById(a.id))!.useCount).toBe(1);
    expect((await store.getById(b.id))!.useCount).toBe(1);
    await store.reinforce([a.id]);
    expect((await store.getById(a.id))!.useCount).toBe(2);
    store.close();

    const reopened = new SqliteVectorStore(file);
    await reopened.init();
    expect((await reopened.getById(a.id))!.useCount).toBe(2);
    await reopened.reinforce([a.id]);
    expect((await reopened.getById(a.id))!.useCount).toBe(3);
    reopened.close();
  });
});

/** The memories table exactly as it looked before the P2 migration ran on it. */
function createLegacyDb(file: string, rows: number): void {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE memories (
      id TEXT PRIMARY KEY,
      namespace TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('episodic','semantic','procedural','working')),
      project TEXT,
      kind TEXT NOT NULL DEFAULT 'note'
        CHECK(kind IN ('decision','convention','gotcha','fact','task','note')),
      knowledge_id TEXT,
      knowledge_section TEXT,
      text TEXT NOT NULL,
      embedding TEXT NOT NULL,
      importance REAL NOT NULL DEFAULT 0.5,
      strength REAL NOT NULL DEFAULT 0.5,
      last_used_at INTEGER,
      source TEXT,
      tags TEXT,
      supersedes_id TEXT,
      is_deleted INTEGER NOT NULL DEFAULT 0,
      visibility TEXT NOT NULL DEFAULT 'private' CHECK(visibility='private'),
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived','draft')),
      pin INTEGER NOT NULL DEFAULT 0 CHECK(pin IN (0,1)),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  const stmt = db.prepare(
    `INSERT INTO memories (id, namespace, type, kind, text, embedding, importance, strength, created_at, updated_at)
     VALUES (?, 'a:1', 'semantic', 'note', ?, '', 0.4, 0.4, ?, ?)`
  );
  for (let i = 0; i < rows; i++) {
    const now = Date.now();
    stmt.run(`legacy-${i}`, `legacy row ${i}`, now - 60 * DAY, now);
  }
  db.close();
}

describe("use_count migration", () => {
  it("one transaction: after opening a legacy store the column exists with zeros, never NULLs", async () => {
    const file = join(tmpDir(), "store.db");
    createLegacyDb(file, 3);
    const store = new SqliteVectorStore(file);
    await store.init();
    store.close();

    const db = new DatabaseSync(file);
    try {
      const cols = new Set((db.prepare(`PRAGMA table_info(memories)`).all() as { name: string }[]).map((r) => r.name));
      expect(cols.has("use_count")).toBe(true);
      // The backfill's promise: every row the ALTER saw was zeroed in the same
      // transaction, so no read ever has to guess what a NULL counter means.
      const nulls = db.prepare(`SELECT COUNT(*) AS n FROM memories WHERE use_count IS NULL`).get() as { n: number };
      expect(nulls.n).toBe(0);
      const zeros = db.prepare(`SELECT COUNT(*) AS n FROM memories WHERE use_count = 0`).get() as { n: number };
      expect(zeros.n).toBe(3);
    } finally {
      db.close();
    }
  });

  it("a crash before COMMIT rolls the column itself back, and the next open re-runs the whole migration", async () => {
    // The transactional shape is what the pattern buys — SQLite's DDL rolls back,
    // so an interrupted migration leaves no half-migrated column behind, exactly as
    // the `text_hash` site above it in sqlite.ts promises. Simulated by running the
    // same statements and unwinding instead of committing.
    const file = join(tmpDir(), "store.db");
    createLegacyDb(file, 2);
    const db = new DatabaseSync(file);
    db.exec("BEGIN IMMEDIATE");
    db.exec(`ALTER TABLE memories ADD COLUMN use_count INTEGER`);
    db.exec(`UPDATE memories SET use_count = 0 WHERE use_count IS NULL`);
    db.exec("ROLLBACK"); // the "crash": COMMIT never happens
    const cols = new Set((db.prepare(`PRAGMA table_info(memories)`).all() as { name: string }[]).map((r) => r.name));
    expect(cols.has("use_count")).toBe(false);
    db.close();

    // And the store re-runs it cleanly on the next open rather than seeing NULLs forever.
    const store = new SqliteVectorStore(file);
    await store.init();
    const rows = await store.list({ namespace: "a:1", limit: 10 });
    expect(rows.memories.every((m) => m.useCount === 0)).toBe(true);
    store.close();
  });

  it("a NULL written by a foreign reader reads as 0 and reinforces from 0", async () => {
    const file = join(tmpDir(), "store.db");
    const store = new SqliteVectorStore(file);
    await store.init();
    store.close();
    // The column is nullable, so a foreign INSERT can leave a row the backfill
    // never saw — COALESCE in the reinforce UPDATE and `?? 0` in the row mapping
    // are what make that row behave like a zero-use row instead of a poisoned one.
    const db = new DatabaseSync(file);
    const now = Date.now();
    db.prepare(
      `INSERT INTO memories (id, namespace, type, kind, text, embedding, importance, strength, created_at, updated_at)
       VALUES ('foreign', 'a:1', 'semantic', 'note', 'foreign row', '', 0.4, 0.4, ?, ?)`
    ).run(now, now);
    db.close();

    const reopened = new SqliteVectorStore(file);
    await reopened.init();
    expect((await reopened.getById("foreign"))!.useCount).toBe(0);
    await reopened.reinforce(["foreign"]);
    expect((await reopened.getById("foreign"))!.useCount).toBe(1);
    reopened.close();
  });

  it("an opener racing a peer process's held migration transaction waits and lands, it does not die on 'database is locked'", async () => {
    // The 2026-11-07 final review's repro, kept as a test. The window the P2
    // migration widened: the `text_hash` transaction (ADR-0018 amendment) holds
    // the write lock across the whole-store backfill, and the opener's three
    // PRAGMAs used to share one try/catch — `journal_mode = WAL` answering SQLITE_BUSY
    // swallowed `busy_timeout` with it, so the next `BEGIN IMMEDIATE` threw within
    // milliseconds and the process died in `service.init()` (the daemon entry has
    // no catch there). Fixed: `busy_timeout` is set first and always, and both
    // migration sites queue through `retryWrite`.
    //
    // Two real processes, because the wait is synchronous SQLite queueing — a peer
    // on the same thread cannot commit mid-wait. A holds a write transaction with
    // the migration's own ALTER for 4 s — wide enough that even a slow `tsx` cold
    // start puts B's `BEGIN IMMEDIATE` inside the held window, so the test cannot
    // silently degenerate into an uncontended open; B runs the real
    // `SqliteVectorStore.init()` 0.4 s in. Before the fix B exited non-zero with
    // `database is locked` at sqlite.ts:481 (reproduced here: exit=1 after ~1.3 s);
    // after it B waits on the lock, finds the winner's column, and opens clean.
    const dir = tmpDir();
    const file = join(dir, "store.db").replace(/\\/g, "/");
    createLegacyDb(file, 2);
    const holder = join(dir, "holder.mjs").replace(/\\/g, "/");
    writeFileSync(holder, `
      import { DatabaseSync } from "node:sqlite";
      const db = new DatabaseSync(${JSON.stringify(file)});
      db.exec("BEGIN IMMEDIATE");
      db.exec("ALTER TABLE memories ADD COLUMN use_count INTEGER");
      setTimeout(() => { db.exec("COMMIT"); db.close(); }, 4000);
    `);
    const opener = join(dir, "opener.mts").replace(/\\/g, "/");
    writeFileSync(opener, [
      `import { pathToFileURL } from "node:url";`,
      `const { SqliteVectorStore } = await import(pathToFileURL(${JSON.stringify(join(process.cwd(), "src/core/store/sqlite.ts").replace(/\\/g, "/"))}).href);`,
      `const store = new SqliteVectorStore(${JSON.stringify(file)});`,
      `await store.init();`,
      `console.log("OPENED");`,
      `store.close();`
    ].join("\n"));
    const TSX = join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");

    // Bind the holder's exit before anything else waits on it: the holder dies
    // while the opener is still working, and a listener attached afterwards misses
    // the already-emitted event.
    const holderChild = spawnChild(process.execPath, [holder], { stdio: "ignore" });
    const holderDone = new Promise<void>((resolve) => {
      holderChild.once("exit", () => resolve());
      holderChild.once("error", () => resolve());
    });
    await settle(400);
    const opened = await new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
      const child = spawnChild(process.execPath, [TSX, opener], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      child.stdout.on("data", (d) => { stdout += String(d); });
      child.on("error", reject);
      child.once("exit", (code) => resolve({ code, stdout }));
    });
    expect(opened.stdout).toContain("OPENED");
    expect(opened.code).toBe(0);
    await holderDone;

    // The migration completed from one side or the other — the loser's duplicate
    // column is "already migrated", not a crash (sqlite.ts runMigrationTxn).
    const db = new DatabaseSync(file);
    try {
      const cols = new Set((db.prepare(`PRAGMA table_info(memories)`).all() as { name: string }[]).map((r) => r.name));
      expect(cols.has("use_count")).toBe(true);
    } finally {
      db.close();
    }
  }, 30_000);
});

describe("store_meta KV", () => {
  it("get/set round-trip on both stores, and an absent key reads null", async () => {
    for (const store of [new InMemoryVectorStore(), new SqliteVectorStore(join(tmpDir(), "store.db"))] as VectorStore[]) {
      await store.init();
      expect(await store.getMeta!("nothing_yet")).toBe(null);
      await store.setMeta!("last_maintenance_at", "123");
      expect(await store.getMeta!("last_maintenance_at")).toBe("123");
      await store.setMeta!("last_maintenance_at", "456");
      expect(await store.getMeta!("last_maintenance_at")).toBe("456");
      store.close();
    }
  });
});

describe("MEMORY_MAINTAIN_HOURS", () => {
  it("default is 24 hours, 0 switches maintenance off, nonsense falls back to the default", () => {
    expect(maintenanceIntervalMs({})).toBe(MAINTAIN_HOURS_DEFAULT * HOUR);
    expect(maintenanceIntervalMs({ MEMORY_MAINTAIN_HOURS: "" })).toBe(24 * HOUR);
    expect(maintenanceIntervalMs({ MEMORY_MAINTAIN_HOURS: "0" })).toBe(0);
    expect(maintenanceIntervalMs({ MEMORY_MAINTAIN_HOURS: "48" })).toBe(48 * HOUR);
    // A typo must not silently disable the sweep — nor a negative value start one.
    expect(maintenanceIntervalMs({ MEMORY_MAINTAIN_HOURS: "abc" })).toBe(24 * HOUR);
    expect(maintenanceIntervalMs({ MEMORY_MAINTAIN_HOURS: "-1" })).toBe(24 * HOUR);
  });

  it("0 means nothing fires, not even the overdue catch-up", async () => {
    const store = new InMemoryVectorStore();
    await store.setMeta(LAST_MAINTENANCE_AT_KEY, String(Date.now() - 72 * HOUR));
    const cold = await addStaleRow(store);
    const lines: string[] = [];
    const handle = startMaintenance(store, { env: { MEMORY_MAINTAIN_HOURS: "0" }, log: (l) => lines.push(l) });
    await settle(20);
    expect(lines).toEqual([]);
    expect((await store.getById(cold.id))!.status).toBe("active");
    handle.stop();
  });
});

describe("startMaintenance", () => {
  it("an overdue store is caught up in the background: the call returns while the sweep is still running", async () => {
    const store = new InMemoryVectorStore();
    const cold = await addStaleRow(store);
    // The overdue stamp: one interval and a day ago, per the same env default.
    await store.setMeta(LAST_MAINTENANCE_AT_KEY, String(Date.now() - 25 * HOUR));
    // A store whose page reads take 30ms — enough to still be mid-pass when the
    // assertions below run, which is what "no request waits on it" has to mean.
    const slow = Object.create(store) as InMemoryVectorStore;
    slow.list = async (opts) => {
      await settle(30);
      return store.list(opts);
    };
    const lines: string[] = [];
    const t0 = Date.now();
    const handle = startMaintenance(slow, { intervalMs: 24 * HOUR, log: (l) => lines.push(l) });
    // Returned synchronously: an hour of interval cannot have elapsed, and the
    // sweep has not finished either — the overdue pass runs detached.
    expect(Date.now() - t0).toBeLessThan(20);
    await settle(5); // let the microtask chain start the pass
    expect((await store.getById(cold.id))!.status).toBe("active"); // still sweeping
    await handle.untilIdle();
    expect((await store.getById(cold.id))!.status).toBe("archived");
    // The stamp moved off the overdue value and to roughly now.
    expect(Number(await store.getMeta(LAST_MAINTENANCE_AT_KEY))).toBeGreaterThan(Date.now() - 60_000);
    expect(await store.getMeta(LAST_MAINTENANCE_RESULT_KEY)).toBe("1 archived, 0 pruned");
    expect(lines.some((l) => l.includes("maintenance") && l.includes("archived 1"))).toBe(true);
    handle.stop();
  });

  it("a store that maintained itself recently is left alone", async () => {
    const store = new InMemoryVectorStore();
    await store.setMeta(LAST_MAINTENANCE_AT_KEY, String(Date.now() - HOUR));
    const cold = await addStaleRow(store);
    const lines: string[] = [];
    const handle = startMaintenance(store, { intervalMs: 24 * HOUR, log: (l) => lines.push(l) });
    await settle(20);
    await handle.untilIdle();
    expect(lines).toEqual([]);
    expect((await store.getById(cold.id))!.status).toBe("active");
    // A future timestamp (a clock that jumped backwards) is not "overdue" either.
    await store.setMeta(LAST_MAINTENANCE_AT_KEY, String(Date.now() + HOUR));
    const again: string[] = [];
    const second = startMaintenance(store, { intervalMs: 24 * HOUR, log: (l) => again.push(l) });
    await settle(20);
    expect(again).toEqual([]);
    handle.stop();
    second.stop();
  });

  it("the timer keeps sweeping on its interval after the start-up check is done", async () => {
    const store = new InMemoryVectorStore();
    await store.setMeta(LAST_MAINTENANCE_AT_KEY, String(Date.now())); // fresh: no catch-up
    const cold = await addStaleRow(store);
    const lines: string[] = [];
    const handle = startMaintenance(store, { intervalMs: 40, log: (l) => lines.push(l) });
    await settle(220); // ~5 ticks at 40ms; assert on two so jitter cannot flake it
    handle.stop();
    await handle.untilIdle();
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect((await store.getById(cold.id))!.status).toBe("archived");
    expect(Number(await store.getMeta(LAST_MAINTENANCE_AT_KEY))).toBeGreaterThan(Date.now() - 200);
  });

  it("a store without the KV capability: pass still works, bookkeeping is skipped not faked", async () => {
    const store = new InMemoryVectorStore();
    const cold = await addStaleRow(store);
    const bare = Object.create(store) as InMemoryVectorStore;
    bare.getMeta = undefined as unknown as InMemoryVectorStore["getMeta"];
    bare.setMeta = undefined as unknown as InMemoryVectorStore["setMeta"];
    const lines: string[] = [];
    const report = await runMaintenancePass(bare, { log: (l) => lines.push(l) });
    expect(report).toEqual({ archived: 1, pruned: 0 });
    expect((await store.getById(cold.id))!.status).toBe("archived");
    expect(lines.length).toBe(1); // the result went to the log, the only sink left
    // And with no meta to read, start-up cannot claim an overdue store — the timer
    // alone still sweeps, per interface.ts's optional-capability rule.
    const ticking = Object.create(store) as InMemoryVectorStore;
    ticking.getMeta = undefined as unknown as InMemoryVectorStore["getMeta"];
    ticking.setMeta = undefined as unknown as InMemoryVectorStore["setMeta"];
    const tickLines: string[] = [];
    const handle = startMaintenance(ticking, { intervalMs: 40, log: (l) => tickLines.push(l) });
    await settle(120);
    handle.stop();
    await handle.untilIdle();
    expect(tickLines.length).toBeGreaterThanOrEqual(1);
  });

  it("the scheduled pass cannot reach the hard half: pruned is 0 by signature, tombstones by none", async () => {
    const store = new InMemoryVectorStore();
    // The exact row the opt-in hard pass prunes (episodic 100 days, importance and
    // strength 0.2 — see `runDecay`'s hard:true case in decay.test.ts).
    const prunable = await store.insert(
      { namespace: "a:1", type: "episodic", kind: "note", text: `row-${Math.random()}`, importance: 0.2, strength: 0.2 },
      [0.1]
    );
    prunable.createdAt = Date.now() - 100 * DAY;
    // runScheduledDecay takes only the store — there is no argument position from
    // which `hard` could ever be expressed.
    const report = await runScheduledDecay(store);
    expect(report.pruned).toBe(0);
    expect(report.archived).toBe(1);
    const after = (await store.getById(prunable.id))!;
    expect(after.isDeleted).toBe(0);
    expect(after.status).toBe("archived");
  });
});

describe("hotness preview mirror (stats.decayCandidates)", () => {
  it("lists cold old rows as archive candidates with their counts and spares the hot ones", async () => {
    const store = new InMemoryVectorStore();
    const now = Date.now();
    const hot = await addStaleRow(store);
    hot.lastUsedAt = now - 60 * DAY;
    hot.useCount = 10; // log1p(10)/4 ≈ 0.60 ≥ ln2/2
    const cold = await addStaleRow(store);
    const listed = await store.list({ namespace: "a:1", includeArchived: true, limit: 10 });
    const ids = summarize(listed.memories, now).decayCandidates;
    expect(ids.map((c) => c.id)).toEqual([cold.id]);
    expect(ids[0]!.action).toBe("archive");
    expect(ids[0]!.useCount).toBe(0);
    expect(HOTNESS_KEEP).toBeCloseTo(Math.LN2 / 2);
  });
});

describe("archiveStale still honors what the reviewers check for", () => {
  it("durable kinds skip before the clock, importance floor after the hotness gate", async () => {
    const store = new InMemoryVectorStore();
    const durable = await store.insert(
      { namespace: "a:1", type: "semantic", kind: "decision", text: "x", importance: 0.4 },
      [0.1]
    );
    durable.createdAt = Date.now() - 400 * DAY;
    expect(await archiveStale(store)).toBe(0);
    expect((await store.getById(durable.id))!.status).toBe("active");
  });
});
