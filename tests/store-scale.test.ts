import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { SqliteVectorStore } from "../src/core/store/sqlite.js";
import { MemoryService } from "../src/core/memoryService.js";
import { HashEmbeddingProvider } from "../src/core/embedding/hash.js";
import { buildServer } from "../src/api/server.js";

/**
 * The storage layout ADR-0017 introduced (text vectors → float32 blob, two-phase
 * read, one transaction per batch) is invisible from the outside by design — these
 * are the promises it has to keep *inside*: a batch lands whole, a legacy file is
 * migrated on open, and a soft delete's bytes can be reclaimed.
 */

const DIM = 384;

function tmpDb(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "om-scale-"));
  return { dir, path: join(dir, "store.db") };
}

describe("sqlite store at scale", () => {
  let dir = "";
  let path = "";
  let store: SqliteVectorStore;

  beforeEach(async () => {
    ({ dir, path } = tmpDb());
    store = new SqliteVectorStore(path);
    await store.init();
  });
  afterEach(() => {
    try { store.close(); } catch {}
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes a batch as one unit and reads vectors back", async () => {
    const embedder = new HashEmbeddingProvider();
    const texts = ["the deploy cache lives in router", "budget tokens come from the parser", "a third row about latency"];
    const embeddings = await embedder.embedBatch(texts, { inputType: "passage" });
    const saved = await store.insertMany!(texts.map((text, i) => ({
      input: { namespace: "proj:one", type: "episodic" as const, text },
      embedding: embeddings[i]!
    })));

    expect(saved).toHaveLength(3);
    // The rows handed back are the ones just built: they carry the vector they were
    // inserted with, so a bulk importer can index its own work without re-reading.
    expect(saved.every((m) => m.embedding.length === DIM)).toBe(true);
    const byId = await store.getById(saved[1]!.id);
    expect(byId?.text).toContain("parser");
    expect(byId?.embedding).toHaveLength(DIM);

    // The postings and the vectors are part of the same transaction: both sides of
    // the read path must see a row the batch just wrote.
    const lexical = await store.lexicalCandidates!({ namespace: "proj:one", query: "parser budget", limit: 5 });
    expect(lexical.map((l) => l.memory.id)).toContain(saved[1]!.id);
    const hits = await store.vectorSearch({
      namespace: "proj:one",
      queryEmbedding: embeddings[2]!,
      limit: 2
    });
    expect(hits.map((h) => h.memory.id)).toContain(saved[2]!.id);
    expect(hits[0]!.memory.embedding).toHaveLength(DIM);
  });

  it("saveMany skips write-time reconcile unless it is asked for", async () => {
    const svc = new MemoryService({ store, embedder: new HashEmbeddingProvider() });
    await svc.init();
    const text = "user prefers answers in German";
    const { memories } = await svc.saveMany([
      { namespace: "a:1", type: "semantic", text },
      { namespace: "a:1", type: "semantic", text },
      { namespace: "a:1", type: "semantic", text: "a different fact entirely" }
    ]);
    // Reconcile would have folded the identical pair into one row; a bulk import is
    // new material and keeps all three.
    expect(memories).toHaveLength(3);
    const listed = await svc.list({ namespace: "a:1" });
    expect(listed.total).toBe(3);
  });

  it("migrates a legacy JSON store on open, once", async () => {
    // Same resolution trick the store uses: a bare `import("node:sqlite")` resolves
    // to the id "sqlite" under vitest, so the builtin never loads here.
    const { createRequire } = await import("node:module");
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: any };
    const legacyDir = mkdtempSync(join(tmpdir(), "om-legacy-"));
    const legacyPath = join(legacyDir, "legacy.db");
    const raw = new DatabaseSync(legacyPath);
    raw.exec(`
      CREATE TABLE memories (
        id TEXT PRIMARY KEY, namespace TEXT NOT NULL, type TEXT NOT NULL,
        text TEXT NOT NULL, embedding TEXT NOT NULL,
        importance REAL NOT NULL DEFAULT 0.5, strength REAL NOT NULL DEFAULT 0.5,
        last_used_at INTEGER, source TEXT, tags TEXT, supersedes_id TEXT,
        is_deleted INTEGER NOT NULL DEFAULT 0, visibility TEXT NOT NULL DEFAULT 'private',
        status TEXT NOT NULL DEFAULT 'active', pin INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
    `);
    const now = Date.now();
    const vec = Array.from({ length: DIM }, (_, i) => Math.sin(i));
    raw.prepare(`INSERT INTO memories (id, namespace, type, text, embedding, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`)
      .run("legacy-1", "old:1", "episodic", "user lives in Berlin", JSON.stringify(vec), now, now);
    raw.close();

    const legacy = new SqliteVectorStore(legacyPath);
    await legacy.init();
    try {
      expect(await legacy.storedDim()).toBe(DIM);
      const check = new DatabaseSync(legacyPath, { readOnly: true });
      expect(check.prepare(`SELECT COUNT(*) AS n FROM memory_vectors`).get()).toEqual({ n: 1 });
      expect(check.prepare(`SELECT COUNT(*) AS n FROM memories WHERE embedding != ''`).get()).toEqual({ n: 0 });
      check.close();
      const hits = await legacy.vectorSearch({ namespace: "old:1", queryEmbedding: vec, limit: 1 });
      expect(hits[0]?.memory.text).toBe("user lives in Berlin");
    } finally {
      legacy.close();
      rmSync(legacyDir, { recursive: true, force: true });
    }
  });

  it("purges tombstones and compacts the file they kept", async () => {
    const texts = Array.from({ length: 300 }, (_, i) => `row ${i} ${"filler ".repeat(80)}`);
    const embedder = new HashEmbeddingProvider();
    const embeddings = await embedder.embedBatch(texts, { inputType: "passage" });
    const saved = await store.insertMany!(texts.map((text, i) => ({
      input: { namespace: "big:1", type: "episodic" as const, text },
      embedding: embeddings[i]!
    })));
    for (const m of saved) await store.deleteSoft(m.id);
    // Soft delete alone frees nothing: the row is still there, so the file cannot shrink.
    const beforePurge = await store.compact!();
    expect(beforePurge.bytesAfter).toBeLessThanOrEqual(beforePurge.bytesBefore);
    expect(await store.purgeDeleted!({ olderThanMs: 0 })).toBe(300);
    const report = await store.compact!();
    expect(report.bytesAfter).toBeLessThan(report.bytesBefore);
    // Footprint, not just the main file: WAL mode keeps recent writes beside it.
    const footprint = ["", "-wal", "-shm"].reduce((n, suffix) => {
      try { return n + statSync(path + suffix).size; } catch { return n; }
    }, 0);
    expect(footprint).toBe(report.bytesAfter);
    expect((await store.list({ namespace: "big:1", includeDeleted: true })).total).toBe(0);
    // Still usable afterwards.
    await store.insert({ namespace: "big:1", type: "episodic", text: "after vacuum" }, embeddings[0]!);
    expect((await store.list({ namespace: "big:1" })).memories.some((m) => m.text === "after vacuum")).toBe(true);
  });
});

describe("bulk write and compaction over HTTP", () => {
  // Directories are cleaned once, at the end: on Windows a freshly closed SQLite file
  // keeps its directory locked for a moment, and retrying inside every test's teardown
  // would turn a filesystem quirk into a flaky assertion.
  const created: string[] = [];
  let dir = "";
  let svc: MemoryService;
  let base = "";
  let close = () => {};

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "om-bulk-"));
    created.push(dir);
    svc = new MemoryService({ dbPath: join(dir, "store.db"), embedder: new HashEmbeddingProvider() });
    await svc.init();
    const { app } = await buildServer({ service: svc });
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
    close = () => new Promise<void>((r) => app.close(() => r()));
  });
  afterEach(async () => {
    await close();
    try { svc.close(); } catch {}
  });
  afterAll(() => {
    for (const path of created) {
      try { rmSync(path, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* temp dir */ }
    }
  });

  const post = (p: string, body: unknown) =>
    fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("saves a whole batch in one request", async () => {
    const items = [
      { namespace: "proj:imp", type: "semantic", text: "the deploy key lives in the vault" },
      { namespace: "proj:imp", type: "semantic", text: "the cache budget is 800 tokens" },
      { namespace: "proj:imp", type: "episodic", text: "we shipped the parser rewrite on friday" }
    ];
    const res = await post("/memories/bulk", { items });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { saved: number; ids: string[] };
    expect(body.saved).toBe(3);
    expect(body.ids).toHaveLength(3);

    const listed = (await (await fetch(`${base}/memories?namespace=proj:imp`)).json()) as { total: number };
    expect(listed.total).toBe(3);
    // The route is reachable ahead of the `/memories/:id` pattern; a GET on it must
    // not be read as "fetch the memory whose id is bulk".
    const search = (await (await fetch(`${base}/memories/search?query=${encodeURIComponent("cache budget")}&namespace=proj:imp`)).json()) as {
      memories: { text: string }[];
    };
    expect(search.memories.map((m) => m.text)).toContain("the cache budget is 800 tokens");
  });

  it("rejects the batch without writing half of it, naming the bad index", async () => {
    const res = await post("/memories/bulk", {
      items: [
        { namespace: "proj:imp", type: "semantic", text: "a good row" },
        { namespace: "proj:imp", type: "semantic" },
        { namespace: "proj:imp", type: "semantic", text: "another good row" }
      ]
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { index: number }).toMatchObject({ index: 1 });
    const listed = (await (await fetch(`${base}/memories?namespace=proj:imp`)).json()) as { total: number };
    expect(listed.total).toBe(0);
  });

  it("refuses a batch too large to be one transaction", async () => {
    const items = Array.from({ length: 5001 }, (_, i) => ({ namespace: "proj:imp", type: "semantic", text: `row ${i}` }));
    const res = await post("/memories/bulk", { items });
    expect(res.status).toBe(413);
  });

  it("compacts through the API and reports the footprint", async () => {
    const items = Array.from({ length: 200 }, (_, i) => ({
      namespace: "proj:imp",
      type: "semantic",
      text: `row ${i} ${"filler ".repeat(80)}`
    }));
    await post("/memories/bulk", { items });
    const listed = (await (await fetch(`${base}/memories?namespace=proj:imp&limit=1000`)).json()) as { memories: { id: string }[] };
    for (const m of listed.memories) await fetch(`${base}/memories/${m.id}`, { method: "DELETE" });
    // Soft delete leaves the rows in place, so VACUUM has nothing to give back yet:
    // purge is the other half and it is not an HTTP route (it is destructive).
    const beforePurge = (await (await post("/compact", {})).json()) as { bytesBefore: number; bytesAfter: number };
    expect(beforePurge.bytesAfter).toBeLessThanOrEqual(beforePurge.bytesBefore);
    expect(await svc.store.purgeDeleted!({ olderThanMs: 0 })).toBe(listed.memories.length);
    const afterPurge = (await (await post("/compact", {})).json()) as { bytesBefore: number; bytesAfter: number };
    expect(afterPurge.bytesAfter).toBeLessThan(afterPurge.bytesBefore);
  });
});
