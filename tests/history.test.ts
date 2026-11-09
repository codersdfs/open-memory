import { describe, it, expect, afterAll, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
// vite's builtin list predates `node:sqlite`, so a static import is rewritten to a
// bare "sqlite" that fails to resolve — same workaround as tests/maintenance.test.ts:10.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
import { InMemoryVectorStore } from "../src/core/store/memory.js";
import { SqliteVectorStore } from "../src/core/store/sqlite.js";
import { MemoryService } from "../src/core/memoryService.js";
import { HashEmbeddingProvider } from "../src/core/embedding/hash.js";
import { buildServer } from "../src/api/server.js";
import { countTokens } from "../src/core/retrieval/tokens.js";
import type { Memory } from "../src/core/types.js";
import type { VectorStore } from "../src/core/store/interface.js";

/**
 * P6 (ADR-0045): the write history and the two clocks. Five promises, one per group:
 * the four write points (insert / reinforce / supersede / archive) each land their
 * history row in the same transaction as the write, on both stores; a hard delete
 * removes the row and never its history; `valid_at` is backfilled from the text's own
 * `(at:…)` stamp in one atomic migration (and left alone when the text names no
 * date); a search hit carries the one-hop predecessor pointer only inside the budget
 * it did not need; and visibility does not move — a superseded row is exactly as
 * invisible as any other tombstone, restored the same way.
 */

const dirs: string[] = [];
/** Long enough that Date.now() has ticked (Windows granularity ~15.6 ms): purge judges `updated_at < cutoff`. */
const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));
afterAll(async () => {
  for (const dir of dirs) {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* temp dir */ }
  }
});

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "om-history-"));
  dirs.push(dir);
  return dir;
}

const OLD_TEXT = "Melanie finished reading Nothing is Impossible on the train (at:2026-04-10)";
const NEW_TEXT = "Melanie says Nothing is Impossible is the best book she read this year";

async function supersedePair(store: VectorStore): Promise<{ oldId: string; newId: string }> {
  const old = await store.insert({ namespace: "a:1", type: "semantic", text: OLD_TEXT, source: "explicit" }, [0.1, 0.2, 0.3]);
  const created = await store.supersede(
    old.id,
    { namespace: "a:1", type: "semantic", text: NEW_TEXT, source: "explicit" },
    [0.4, 0.5, 0.6],
    { reason: "model-refines", model: "jev" }
  );
  return { oldId: old.id, newId: created.id };
}

describe("memory_events: the four write points land in the same transaction as their write", () => {
  it("insert writes one history row per insert — single and bulk, reason = the row's source", async () => {
    for (const store of [new InMemoryVectorStore(), new SqliteVectorStore(join(tmpDir(), "store.db"))] as VectorStore[]) {
      await store.init();
      const a = await store.insert({ namespace: "a:1", type: "semantic", text: "alpha fact", source: "explicit" }, [0.1]);
      const events = await store.history!(a.id);
      expect(events).toHaveLength(1);
      expect(events[0]!.event).toBe("insert");
      expect(events[0]!.memoryId).toBe(a.id);
      expect(events[0]!.newValue).toBe("alpha fact");
      expect(events[0]!.reason).toBe("explicit");
      expect(events[0]!.at).toBeGreaterThan(0);

      const made = await store.insertMany!([
        { input: { namespace: "a:1", type: "semantic", text: "bulk one", source: "import" }, embedding: [0.1] },
        { input: { namespace: "a:1", type: "semantic", text: "bulk two" }, embedding: [0.2] }
      ]);
      const bulkEvents = await Promise.all(made.map((m) => store.history!(m.id)));
      expect(bulkEvents.map((e) => e[0]!.event)).toEqual(["insert", "insert"]);
      expect(bulkEvents[0]![0]!.reason).toBe("import");
      expect(bulkEvents[1]![0]!.reason).toBe(null); // no source, no invented reason
      store.close();
    }
  });

  it("reinforce records the retrieval for live rows only, tombstones get nothing", async () => {
    for (const store of [new InMemoryVectorStore(), new SqliteVectorStore(join(tmpDir(), "store.db"))] as VectorStore[]) {
      await store.init();
      const a = await store.insert({ namespace: "a:1", type: "semantic", text: "alpha fact" }, [0.1]);
      const dead = await store.insert({ namespace: "a:1", type: "semantic", text: "doomed fact" }, [0.2]);
      await store.deleteSoft(dead.id);
      expect(await store.reinforce([a.id, dead.id, a.id])).toBe(1); // the tombstone does not move
      const events = await store.history!(a.id);
      expect(events.map((e) => e.event)).toEqual(["insert", "reinforce"]);
      // The text did not change, so old/new stay NULL — the event itself is the record.
      expect(events[1]!.oldValue).toBe(null);
      expect(events[1]!.newValue).toBe(null);
      expect(await store.history!(dead.id)).toHaveLength(1); // insert only, no reinforce
      store.close();
    }
  });

  it("supersede writes the old row's invalidation and the successor's insert, with the decision attached", async () => {
    for (const store of [new InMemoryVectorStore(), new SqliteVectorStore(join(tmpDir(), "store.db"))] as VectorStore[]) {
      await store.init();
      const { oldId, newId } = await supersedePair(store);
      const old = (await store.getById(oldId))!;
      expect(old.isDeleted).toBe(1);
      // The two clocks (P6): the invalidation is stamped when the supersede ran —
      // in the SAME UPDATE that set is_deleted — while the event-time clock comes
      // from the text's own stamp.
      expect(old.invalidAt).not.toBe(null);
      expect(old.validAt).toBe(new Date(2026, 3, 10).getTime());

      const supersedeEvents = (await store.history!(oldId)).filter((e) => e.event === "supersede");
      expect(supersedeEvents).toHaveLength(1);
      expect(supersedeEvents[0]!.oldValue).toBe(OLD_TEXT);
      expect(supersedeEvents[0]!.newValue).toBe(NEW_TEXT);
      expect(supersedeEvents[0]!.reason).toBe("model-refines");
      expect(supersedeEvents[0]!.model).toBe("jev");

      const successorEvents = await store.history!(newId);
      expect(successorEvents.map((e) => e.event)).toEqual(["insert"]);
      expect((await store.getById(newId))!.supersedesId).toBe(oldId);
      store.close();
    }
  });

  it("archive records the status flip with the rule that did it; a re-archive writes nothing", async () => {
    for (const store of [new InMemoryVectorStore(), new SqliteVectorStore(join(tmpDir(), "store.db"))] as VectorStore[]) {
      await store.init();
      const a = await store.insert({ namespace: "a:1", type: "semantic", text: "cold note fact here", importance: 0.4 }, [0.1]);
      await store.updateMeta!(a.id, { status: "archived" }, { reason: "decay:hotness" });
      let events = (await store.history!(a.id)).filter((e) => e.event === "archive");
      expect(events).toHaveLength(1);
      expect(events[0]!.oldValue).toBe("active");
      expect(events[0]!.newValue).toBe("archived");
      expect(events[0]!.reason).toBe("decay:hotness");

      await store.updateMeta!(a.id, { status: "archived" }); // no-op, no second event
      events = (await store.history!(a.id)).filter((e) => e.event === "archive");
      expect(events).toHaveLength(1);

      // A restore is not one of the four write points: no event, and the history
      // stays exactly as it was.
      await store.updateMeta!(a.id, { status: "active" });
      expect((await store.history!(a.id)).filter((e) => e.event === "archive")).toHaveLength(1);
      store.close();
    }
  });
});

describe("purgeDeleted hard-deletes the row and never its history", () => {
  it("the purged id still answers history() with every event it earned", async () => {
    const store = new SqliteVectorStore(join(tmpDir(), "store.db"));
    await store.init();
    const { oldId, newId } = await supersedePair(store);
    await store.deleteSoft(newId);
    const beforeOld = await store.history!(oldId);
    expect(beforeOld.map((e) => e.event)).toEqual(["insert", "supersede"]);
    const beforeNew = await store.history!(newId);

    // The tombstones must predate the purge cutoff: `olderThanMs: 0` is strict `updated_at < now`,
    // so a tombstone stamped in the same millisecond as the call is still "not yet old".
    await settle();
    expect(await store.purgeDeleted!({ olderThanMs: 0 })).toBe(2);
    expect(await store.getById(oldId)).toBe(null);
    expect(await store.getById(newId)).toBe(null);
    // The audit half (P6): the rows are gone, the story of what happened to them is
    // not — nothing in the purge touches memory_events.
    expect(await store.history!(oldId)).toEqual(beforeOld);
    expect(await store.history!(newId)).toEqual(beforeNew);
    store.close();
  });
});

describe("valid_at: the event-time clock becomes a column", () => {
  /** The memories table exactly as it looked before the P6 migration ran on it. */
  function createLegacyDb(file: string): void {
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
    const now = Date.now();
    db.prepare(
      `INSERT INTO memories (id, namespace, type, kind, text, embedding, created_at, updated_at)
       VALUES ('dated', 'a:1', 'semantic', 'note', ?, '', ?, ?)`
    ).run(`user moved to Berlin (at:2026-05-01)`, now, now);
    db.prepare(
      `INSERT INTO memories (id, namespace, type, kind, text, embedding, created_at, updated_at)
       VALUES ('undated', 'a:1', 'semantic', 'note', 'user likes plain coffee', '', ?, ?)`
    ).run(now, now);
    // Stamp-SHAPED but non-numeric text (the 2026-11-08 review's hang repro): both
    // hit the naive `LIKE '%(at:____-__-__)%'` pre-filter — `_` matches any
    // character — but `extractValidAt`'s numeric regex refuses them. A backfill
    // that selects rows it never updates would loop forever inside init()'s
    // migration write lock; these two rows are what pins the guards.
    db.prepare(
      `INSERT INTO memories (id, namespace, type, kind, text, embedding, created_at, updated_at)
       VALUES ('template', 'a:1', 'semantic', 'note', 'the stamp format is documented as (at:YYYY-MM-DD)', '', ?, ?)`
    ).run(now, now);
    db.prepare(
      `INSERT INTO memories (id, namespace, type, kind, text, embedding, created_at, updated_at)
       VALUES ('nondigit', 'a:1', 'semantic', 'note', 'placeholder stamp (at:abcd-ef-gh) for the example', '', ?, ?)`
    ).run(now, now);
    // A superseded tombstone: the only invalidation the store could express before
    // the column existed, recoverable from its successor's created_at. The edge
    // points forward: the SUCCESSOR carries `supersedes_id = old-claim`.
    db.prepare(
      `INSERT INTO memories (id, namespace, type, kind, text, embedding, supersedes_id, is_deleted, created_at, updated_at)
       VALUES ('old-claim', 'a:1', 'semantic', 'note', 'old claim', '', NULL, 1, ?, ?)`
    ).run(now - 5000, now - 5000);
    db.prepare(
      `INSERT INTO memories (id, namespace, type, kind, text, embedding, supersedes_id, is_deleted, created_at, updated_at)
       VALUES ('successor-1', 'a:1', 'semantic', 'note', 'new claim', '', 'old-claim', 0, ?, ?)`
    ).run(now, now);
    db.close();
  }

  it("backfill: dated rows get their stamp, undated rows stay NULL, superseded tombstones recover invalid_at", async () => {
    const file = join(tmpDir(), "store.db");
    createLegacyDb(file);
    const store = new SqliteVectorStore(file);
    await store.init();
    store.close();

    const db = new DatabaseSync(file);
    try {
      const dated = db.prepare(`SELECT valid_at FROM memories WHERE id = 'dated'`).get() as { valid_at: number | null };
      expect(dated.valid_at).toBe(new Date(2026, 4, 1).getTime());
      const undated = db.prepare(`SELECT valid_at FROM memories WHERE id = 'undated'`).get() as { valid_at: number | null };
      expect(undated.valid_at).toBe(null); // no match does not move
      // The stamp-shaped non-numeric rows: rejected by the numeric regex, and the
      // whole point of this fixture is that reaching these assertions at all proves
      // the backfill terminated — the pre-fix loop hung init() on this exact db.
      const template = db.prepare(`SELECT valid_at FROM memories WHERE id = 'template'`).get() as { valid_at: number | null };
      expect(template.valid_at).toBe(null);
      const nondigit = db.prepare(`SELECT valid_at FROM memories WHERE id = 'nondigit'`).get() as { valid_at: number | null };
      expect(nondigit.valid_at).toBe(null);
      const oldClaim = db.prepare(`SELECT invalid_at FROM memories WHERE id = 'old-claim'`).get() as { invalid_at: number | null };
      expect(oldClaim.invalid_at).not.toBe(null);
      // The successor is not tombstoned: it has no invalidation to recover.
      const successor = db.prepare(`SELECT invalid_at FROM memories WHERE id = 'successor-1'`).get() as { invalid_at: number | null };
      expect(successor.invalid_at).toBe(null);
    } finally {
      db.close();
    }

    // Reopening re-runs nothing and does not "fix" the NULL into a guess.
    const reopened = new SqliteVectorStore(file);
    await reopened.init();
    expect((await reopened.getById("undated"))!.validAt).toBe(null);
    expect((await reopened.getById("dated"))!.validAt).toBe(new Date(2026, 4, 1).getTime());
    reopened.close();
  });

  it("the migration is one transaction: a crash before COMMIT rolls the columns back and the next open re-runs it", async () => {
    const file = join(tmpDir(), "store.db");
    createLegacyDb(file);
    // Simulated the same way maintenance.test.ts does: run the migration's own
    // statements and unwind instead of committing.
    const db = new DatabaseSync(file);
    db.exec("BEGIN IMMEDIATE");
    db.exec(`ALTER TABLE memories ADD COLUMN valid_at INTEGER`);
    db.exec(`UPDATE memories SET valid_at = 12345 WHERE id = 'dated'`);
    db.exec("ROLLBACK"); // the "crash": COMMIT never happens
    const cols = new Set((db.prepare(`PRAGMA table_info(memories)`).all() as { name: string }[]).map((r) => r.name));
    expect(cols.has("valid_at")).toBe(false);
    db.close();

    const store = new SqliteVectorStore(file);
    await store.init();
    expect((await store.getById("dated"))!.validAt).toBe(new Date(2026, 4, 1).getTime());
    store.close();
  });

  it("new writes derive valid_at from their own text on both stores; no stamp, NULL", async () => {
    for (const store of [new InMemoryVectorStore(), new SqliteVectorStore(join(tmpDir(), "store.db"))] as VectorStore[]) {
      await store.init();
      const dated = await store.insert({ namespace: "a:1", type: "semantic", text: "planned the sprint (at:2026-06-15)" }, [0.1]);
      expect(dated.validAt).toBe(new Date(2026, 5, 15).getTime());
      const undated = await store.insert({ namespace: "a:1", type: "semantic", text: "no date in this one" }, [0.2]);
      expect(undated.validAt).toBe(null);
      expect(undated.invalidAt).toBe(null);
      store.close();
    }
  });
});

describe("drill: the explicit chain walk", () => {
  it("walks ancestors backward and successors forward, with the row's write history", async () => {
    for (const store of [new InMemoryVectorStore(), new SqliteVectorStore(join(tmpDir(), "store.db"))] as VectorStore[]) {
      await store.init();
      const a = await store.insert({ namespace: "a:1", type: "semantic", text: "claim v1" }, [0.1]);
      const b = await store.supersede(a.id, { namespace: "a:1", type: "semantic", text: "claim v2" }, [0.2], { reason: "refinement" });
      const c = await store.supersede(b.id, { namespace: "a:1", type: "semantic", text: "claim v3" }, [0.3]);

      const svc = new MemoryService({ store, embedder: new HashEmbeddingProvider() });
      const view = await svc.drill(b.id);
      expect(view.memory!.id).toBe(b.id);
      expect(view.ancestors.map((m) => m.id)).toEqual([a.id]);
      expect(view.successors.map((m) => m.id)).toEqual([c.id]);
      expect(view.events.map((e) => e.event)).toEqual(["insert", "supersede"]);

      // The ends of the chain drill to what they have: the origin has no ancestor,
      // the newest has no successor.
      expect((await svc.drill(a.id)).ancestors).toEqual([]);
      expect((await svc.drill(c.id)).successors).toEqual([]);
      store.close();
    }
  });

  it("a purged id answers with its history and a null row, not a 404-shaped lie", async () => {
    const store = new SqliteVectorStore(join(tmpDir(), "store.db"));
    await store.init();
    const a = await store.insert({ namespace: "a:1", type: "semantic", text: "doomed claim here" }, [0.1]);
    await store.deleteSoft(a.id);
    await settle(); // same strict-cutoff rule as above
    await store.purgeDeleted!({ olderThanMs: 0 });
    const svc = new MemoryService({ store, embedder: new HashEmbeddingProvider() });
    const view = await svc.drill(a.id);
    expect(view.memory).toBe(null);
    expect(view.events.map((e) => e.event)).toEqual(["insert"]);
    store.close();
  });

  it("over the daemon the walk is explicit: ?drill=1 returns the chain, a bare GET stays the row", async () => {
    const svc = new MemoryService({ store: new InMemoryVectorStore(), embedder: new HashEmbeddingProvider() });
    const { app } = await buildServer({ service: svc });
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
    try {
      const a = await svc.store.insert({ namespace: "d:1", type: "semantic", text: "wire claim v1" }, [0.1]);
      const b = await svc.store.supersede(a.id, { namespace: "d:1", type: "semantic", text: "wire claim v2" }, [0.2]);

      const bare = (await (await fetch(`${base}/memories/${encodeURIComponent(b.id)}`)).json()) as Record<string, unknown>;
      expect(bare.id).toBe(b.id);
      expect(bare.ancestors).toBeUndefined(); // the default answer stays the row alone

      const drilled = (await (await fetch(`${base}/memories/${encodeURIComponent(b.id)}?drill=1`)).json()) as {
        memory: { id: string };
        ancestors: { id: string }[];
        successors: { id: string }[];
        events: { event: string }[];
      };
      expect(drilled.memory.id).toBe(b.id);
      expect(drilled.ancestors.map((m) => m.id)).toEqual([a.id]);
      // events are the ORIGIN row's history: b was inserted and never superseded —
      // the supersede event lives on a, the row it retired.
      expect(drilled.events.map((e) => e.event)).toEqual(["insert"]);
    } finally {
      await new Promise<void>((r) => app.close(() => r()));
    }
  });
});

describe("Stage C chain half: the predecessor pointer spends only leftover budget", () => {
  async function chainService(): Promise<MemoryService> {
    const svc = new MemoryService({ store: new InMemoryVectorStore(), embedder: new HashEmbeddingProvider() });
    await svc.init();
    // Embed through the service's own provider, so the stored vectors and the query
    // vector share one dim — the rows must be reachable by the real search path.
    const oldEmbedding = await svc.embedder.embed(OLD_TEXT, { inputType: "passage" });
    const old = await svc.store.insert({ namespace: "s:1", type: "semantic", text: OLD_TEXT, source: "explicit" }, oldEmbedding);
    const newEmbedding = await svc.embedder.embed(NEW_TEXT, { inputType: "passage" });
    await svc.store.supersede(
      old.id,
      { namespace: "s:1", type: "semantic", text: NEW_TEXT, source: "explicit" },
      newEmbedding,
      { reason: "model-refines", model: "jev" }
    );
    return svc;
  }

  const search = (svc: MemoryService, budgetTokens: number) =>
    svc.search({ query: "best book Melanie read this year", namespaces: ["s:1"], k: 5, budgetTokens, threshold: 0.35 });

  it("a hit that replaced something carries one 前身 line, dated from the predecessor's own stamp", async () => {
    const svc = await chainService();
    const result = await search(svc, 800);
    expect(result.memories).toHaveLength(1); // the successor — the tombstone never joins the pool
    const hit = result.memories[0]!;
    expect(hit.supersedesId).not.toBe(null);
    expect(hit.text).toContain(NEW_TEXT);
    expect(hit.text).toContain("\n前身(2026-04-10): Melanie finished reading Nothing is Impossible on the train");
    // ≤80 chars of the predecessor, one line, no vector, no extra result row.
    const line = hit.text.split("\n").pop()!;
    expect(line.startsWith("前身(2026-04-10): ")).toBe(true);
    expect(line.length).toBeLessThanOrEqual("前身(2026-04-10): ".length + 80);
    expect(result.tokensUsed).toBeLessThanOrEqual(800);
    expect(result.tokensUsed).toBe(countTokensByResult(result));
  });

  it("with no budget left over the pointer is dropped, never a row displaced or the cap broken", async () => {
    const svc = await chainService();
    const rowTokens = countTokens(NEW_TEXT);
    // Exactly the row's cost: the row fits whole, nothing remains for a pointer.
    const tight = await search(svc, rowTokens);
    expect(tight.memories).toHaveLength(1);
    expect(tight.memories[0]!.text).toBe(NEW_TEXT); // un-projected, un-pointered
    expect(tight.tokensUsed).toBe(rowTokens);

    // A crumb of leftover smaller than the date prefix: still nothing attached.
    const crumb = await search(svc, rowTokens + 2);
    expect(crumb.memories[0]!.text).toBe(NEW_TEXT);
    expect(crumb.tokensUsed).toBeLessThanOrEqual(rowTokens + 2);
  });

  it("the pointer clips to what is left instead of skipping when something does fit", async () => {
    const svc = await chainService();
    const rowTokens = countTokens(NEW_TEXT);
    const prefixTokens = countTokens("前身(2026-04-10): ");
    const result = await search(svc, rowTokens + prefixTokens + 8);
    const hit = result.memories[0]!;
    expect(hit.text).toContain("\n前身(2026-04-10): ");
    expect(result.tokensUsed).toBeLessThanOrEqual(rowTokens + prefixTokens + 8);
  });
});

describe("the retired value stays history, never the answer (Paris → Berlin)", () => {
  const NS = "s:city";
  const PARIS = "the user lives in Paris";
  const BERLIN = "the user lives in Berlin";
  const MADRID = "the user lives in Madrid";

  /** Cosine 1 for every pair, so the reconciler's gate reaches the neighbour the way a
   *  real embedding would. The hash provider's lexical floor cannot reach it here: two
   *  rows that differ by one city word share 4 of 6 terms (0.667 < 0.8). */
  const fixedVector = {
    name: "nim",
    dim: 4,
    embed: async () => [1, 0, 0, 0],
    embedBatch: async (texts: string[]) => texts.map(() => [1, 0, 0, 0])
  } as unknown as EmbeddingProvider;

  const savedReconcile = process.env.MEMORY_RECONCILE;
  let open: MemoryService[] = [];
  beforeEach(async () => {
    process.env.MEMORY_RECONCILE = "on";
  });
  afterEach(() => {
    if (savedReconcile === undefined) delete process.env.MEMORY_RECONCILE;
    else process.env.MEMORY_RECONCILE = savedReconcile;
  });

  function judgedService(): MemoryService {
    const svc = new MemoryService({
      store: new InMemoryVectorStore(),
      embedder: fixedVector,
      relation: async () => "contradicts"
    });
    open.push(svc);
    return svc;
  }
  async function init(svc: MemoryService): Promise<MemoryService> {
    await svc.init();
    return svc;
  }
  const remember = (svc: MemoryService, text: string) =>
    svc.saveDetailed({ namespace: NS, type: "semantic", text });
  const ask = (svc: MemoryService) =>
    svc.search({ query: "where does the user live now", namespaces: [NS], k: 5, budgetTokens: 800, threshold: 0.35 });

  it("the judged swap answers the new city and keeps the old one as labeled history", async () => {
    const svc = await init(judgedService());
    const paris = await remember(svc, PARIS);
    const berlin = await remember(svc, BERLIN);

    // Write side: one live row, the old one retired by link, not by silence.
    expect(berlin.decision.action).toBe("supersede");
    expect(berlin.memory.supersedesId).toBe(paris.memory.id);
    expect((await svc.list({ namespace: NS })).memories.map((m) => m.id)).toEqual([berlin.memory.id]);
    expect(await svc.getActive(paris.memory.id)).toBe(null);

    // Read side: the question gets one row, and it leads with the city that is true now.
    const result = await ask(svc);
    expect(result.memories).toHaveLength(1);
    const hit = result.memories[0]!;
    expect(hit.text.startsWith(BERLIN)).toBe(true);
    expect(hit.text).toContain(PARIS); // retired, but not deleted: still readable as history
    // And it is recorded ONCE. mergeText already appended the retired claim, so the
    // 前身 pointer would repeat it — a second copy of a value the store has proven out
    // of date spends leftover budget and makes the dead city compete to be the answer.
    expect(hit.text.match(/Paris/g)!.length).toBe(1);
    expect(hit.tokens).toBe(countTokens(hit.text));
    expect(result.tokensUsed).toBeLessThanOrEqual(800);
  });

  it("when the row has no room for the tail, the one-hop pointer is what keeps the history", async () => {
    const svc = await init(judgedService());
    const paris = await remember(svc, PARIS);
    const berlin = await remember(svc, BERLIN);
    const madrid = await remember(svc, MADRID);

    // The merge tail is capped (old text > 2× new text is a different claim, not a
    // detail), so by the third city the live row carries only its own words.
    expect(madrid.memory.text).toBe(MADRID);
    const hit = (await ask(svc)).memories[0]!;
    expect(hit.text.startsWith(MADRID)).toBe(true);
    expect(hit.text).toContain("\n前身(");
    expect(hit.text).toContain("Berlin");
    // Still one hop, never the walk: exactly two lines, the claim and its pointer.
    const lines = hit.text.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(MADRID);
    expect(lines[1].startsWith("前身(")).toBe(true);

    // The full chain is behind the explicit drill, which the caller pays for.
    const chain = await svc.drill(madrid.memory.id);
    expect(chain.ancestors.map((a) => a.text)).toEqual([berlin.memory.text, paris.memory.text]);
  });

  it("with no judge to call it a contradiction, nothing is retired and nothing pretends", async () => {
    // The honest boundary of the guarantee above: an offline install (hash embeddings,
    // no relation judge) never reaches the old row, so the swap is two inserts. The
    // README's `insert` row documents this; the store does not fake a supersede.
    const svc = await init(new MemoryService({ store: new InMemoryVectorStore(), embedder: new HashEmbeddingProvider() }));
    const paris = await remember(svc, PARIS);
    const berlin = await remember(svc, BERLIN);
    expect(paris.decision.action).toBe("insert");
    expect(berlin.decision.action).toBe("insert");
    expect(berlin.memory.supersedesId).toBe(null);
    expect(berlin.memory.text).toBe(BERLIN);
    expect((await svc.list({ namespace: NS })).memories.map((m) => m.text).sort()).toEqual([BERLIN, PARIS]);
    // Both cities are live, so both are candidates: the retired-value contract starts at
    // the supersede, it does not invent one.
    expect((await ask(svc)).memories).toHaveLength(2);
  });
});

/** tokensUsed must equal what the caller will actually read — pointers included. */
function countTokensByResult(result: { memories: { tokens: number }[] }): number {
  return result.memories.reduce((s, m) => s + m.tokens, 0);
}

describe("visibility does not move (the tombstone contract, unchanged by P6)", () => {
  it("a superseded row is invisible to every default read and restorable exactly as before", async () => {
    const store = new SqliteVectorStore(join(tmpDir(), "store.db"));
    await store.init();
    const old = await store.insert({ namespace: "a:1", type: "semantic", text: OLD_TEXT, source: "explicit" }, [0.4, 0.5, 0.6]);
    const q = [0.4, 0.5, 0.6];
    // Warm the decoded partition cache while the row is still live, then supersede:
    // if the invalidation skipped its noteChange, this cached read would serve the
    // dead row — the exact ADR-0034/0035 regression the same-UPDATE noteChange rules out.
    const warm = await store.vectorSearch({ namespace: "a:1", queryEmbedding: q, limit: 10 });
    expect(warm.map((h) => h.memory.id)).toContain(old.id);

    const created = await store.supersede(
      old.id,
      { namespace: "a:1", type: "semantic", text: NEW_TEXT, source: "explicit" },
      [0.4, 0.5, 0.6],
      { reason: "model-refines", model: "jev" }
    );

    // getActive still reads is_deleted and nothing else (ADR-0011's promise).
    const svc = new MemoryService({ store, embedder: new HashEmbeddingProvider() });
    expect(await svc.getActive(old.id)).toBe(null);
    expect((await svc.getActive(created.id))!.id).toBe(created.id);

    // Candidate-pool visibility, both cache-warm and after the invalidation.
    const after = await store.vectorSearch({ namespace: "a:1", queryEmbedding: q, limit: 10 });
    expect(after.map((h) => h.memory.id)).not.toContain(old.id);
    expect(after.map((h) => h.memory.id)).toContain(created.id);
    const warmed = await store.vectorSearch({ namespace: "a:1", queryEmbedding: q, limit: 10 });
    expect(warmed.map((h) => h.memory.id)).not.toContain(old.id);

    // Restore is still a flag flip, and the restored row keeps its history.
    await store.updateMeta!(old.id, { isDeleted: 0 });
    expect((await store.getById(old.id))!.isDeleted).toBe(0);
    expect((await store.history!(old.id)).some((e) => e.event === "supersede")).toBe(true);
    store.close();
  });

  it("a plain forget leaves invalid_at NULL: removed is not the same as no longer true", async () => {
    const store = new SqliteVectorStore(join(tmpDir(), "store.db"));
    await store.init();
    const a = await store.insert({ namespace: "a:1", type: "semantic", text: "a note to forget here" }, [0.1]);
    await store.deleteSoft(a.id);
    expect((await store.getById(a.id))!.invalidAt).toBe(null);
    expect((await store.history!(a.id)).map((e) => e.event)).toEqual(["insert"]);
    store.close();
  });
});

describe("P6 review fix (2026-11-09): the in-memory supersede has no await boundary", () => {
  it("the successor's writes and the old row's invalidation land in one synchronous block", async () => {
    const store = new InMemoryVectorStore();
    await store.init();
    const old = await store.insert({ namespace: "a:1", type: "semantic", text: "old claim" }, [0.1]);
    // Deliberately NOT awaited. Under the pre-fix shape (`await this.insert(...)`
    // first) the call parked at that internal await boundary right here — successor
    // already in the map, old row still live, no history — a state a concurrent
    // reader interleaving at the boundary could observe. An async method runs
    // synchronously to its first await, so reading the map NOW pins the fix: a
    // supersede body without awaits is final the moment the call returns.
    const pending = store.supersede(
      old.id,
      { namespace: "a:1", type: "semantic", text: "new claim", source: "explicit" },
      [0.2],
      { reason: "refinement" }
    );
    const map = (store as unknown as { map: Map<string, Memory> }).map;
    expect(map.get(old.id)!.isDeleted).toBe(1);
    expect(map.get(old.id)!.invalidAt).not.toBe(null);
    const successor = [...map.values()].find((m) => m.id !== old.id)!;
    expect(successor.supersedesId).toBe(old.id);
    expect(successor.isDeleted).toBe(0);
    // The history is complete the moment the call returned, not one microtask later.
    expect((await store.history!(old.id)).map((e) => e.event)).toEqual(["insert", "supersede"]);
    expect((await store.history!(successor.id)).map((e) => e.event)).toEqual(["insert"]);
    await pending;
  });
});
