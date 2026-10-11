import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import { summarize } from "../src/core/stats.js";
import { buildServer } from "../src/api/server.js";
import { MemoryService } from "../src/core/memoryService.js";
import { InMemoryVectorStore } from "../src/core/store/memory.js";
import { HashEmbeddingProvider } from "../src/core/embedding/hash.js";
import type { Memory } from "../src/core/types.js";

const DAY = 24 * 60 * 60 * 1000;

function mem(o: Partial<Memory> & { type: Memory["type"] }): Memory {
  return {
    id: o.id ?? Math.random().toString(36).slice(2),
    namespace: "test:1",
    text: "x".repeat(40),
    embedding: [],
    importance: 0.5,
    strength: 0.5,
    lastUsedAt: null,
    isDeleted: 0,
    visibility: "private",
    status: "active",
    pin: 0,
    createdAt: 0,
    updatedAt: 0,
    ...o
  };
}

describe("stats.summarize", () => {
  const now = 1_000 * DAY;
  const rows: Memory[] = [
    mem({ type: "episodic", createdAt: now - 100 * DAY, importance: 0.2, strength: 0.1 }),      // decay candidate
    mem({ type: "episodic", createdAt: now - 100 * DAY, importance: 0.9 }),                    // too important to prune
    mem({ type: "working", createdAt: now - 8 * DAY }),                                        // decay candidate (7d)
    mem({ type: "working", createdAt: now - 2 * DAY }),
    mem({ type: "semantic", status: "archived", pin: 1, strength: 0.8, lastUsedAt: now - DAY }),
    mem({ type: "semantic", isDeleted: 1, supersedesId: "dead", status: "superseded" }),
    mem({ type: "procedural", strength: 0.7, lastUsedAt: now - 3 * DAY }),
  ];

  it("counts by type and status, and honours the tombstone", () => {
    const s = summarize(rows, now);
    expect(s.byType.episodic).toBe(2);
    expect(s.byType.working).toBe(2);
    expect(s.byStatus.active).toBe(5);
    expect(s.byStatus.archived).toBe(1);
    expect(s.byStatus.superseded).toBe(1);
    expect(s.deleted).toBe(1);
    // "active" here means not soft-deleted, so it counts the archived row too —
    // byStatus.active is the status field, and the two numbers are different on purpose
    expect(s.active).toBe(6);
    expect(s.pinned).toBe(1);
  });

  it("counts reinforcement: used-then-stronger versus never used", () => {
    const s = summarize(rows, now);
    expect(s.reinforced).toBe(2);
    expect(s.neverUsed).toBe(5);
  });

  it("decay candidates match decay.ts: episodic>90d&&importance<=0.3, working>7d", () => {
    const s = summarize(rows, now);
    expect(s.decayCandidates.map((m) => m.type).sort()).toEqual(["episodic", "working"]);
    // the soft-deleted row is a tombstone — it is already gone
    expect(s.decayCandidates.some((m) => m.isDeleted === 1)).toBe(false);
  });

  it("buckets strength and age without inventing a total", () => {
    const s = summarize(rows, now);
    expect(s.strength.map((b) => b.label)).toEqual(["0-0.2", "0.2-0.4", "0.4-0.6", "0.6-0.8", "0.8-1"]);
    expect(s.strength.reduce((n, b) => n + b.count, 0)).toBe(rows.length);
    expect(s.age.map((b) => b.label)).toEqual(["<1d", "1-7d", "7-30d", "30-90d", ">90d"]);
    expect(s.age.reduce((n, b) => n + b.count, 0)).toBe(rows.length);
  });

  it("counts supersede links and chain heads", () => {
    const s = summarize(rows, now);
    expect(s.supersedesLinks).toBe(1);
    expect(s.supersedeHeads).toBe(1);
  });

  it("token estimate is labelled as the len/4 heuristic, not a saving", () => {
    const s = summarize(rows, now);
    expect(s.textChars).toBe(rows.length * 40);
    expect(s.textTokensEstimate).toBe(rows.length * 10);
  });
});

describe("console API", () => {
  let base = "";
  let close = () => {};

  beforeAll(async () => {
    const svc = new MemoryService({ store: new InMemoryVectorStore(), embedder: new HashEmbeddingProvider() });
    const { app } = await buildServer({ service: svc });
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
    close = () => new Promise<void>((r) => app.close(() => r()));
    await fetch(`${base}/memories`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ namespace: "test:1", type: "semantic", text: "user lives in Berlin" })
    });
  });
  afterAll(async () => { await close(); });

  it("GET /stats keeps its old shape unless full=1", async () => {
    const plain = (await (await fetch(`${base}/stats?namespace=test:1`)).json()) as Record<string, unknown>;
    expect(Object.keys(plain).sort()).toEqual(["byType", "dim", "embedding", "namespace", "total"]);

    const full = (await (await fetch(`${base}/stats?namespace=test:1&full=1`)).json()) as Record<string, unknown>;
    expect(full.total).toBe(1);
    expect(full.byType).toEqual(plain.byType);
    expect(full.byStatus).toBeTruthy();
    expect(full.decayCandidates).toEqual([]);
    expect(Array.isArray(full.strength)).toBe(true);
    expect(Array.isArray(full.age)).toBe(true);
  });

  it("serves the console at / and /app, and never a stale inspector page", async () => {
    // Both states are legitimate on a real checkout: built (a console served) and
    // unbuilt (an instruction, not a blank 404). What must never happen is either
    // route rendering the deleted inspector's index.html — or an unbuilt tree
    // falling through to whatever the catch-all happens to hold.
    for (const p of ["/", "/app"]) {
      const res = await fetch(`${base}${p}`);
      const body = await res.text();
      expect(body).not.toContain("AI Memory — Inspector");
      if (res.status === 200) expect(body).toContain('id="root"');
      else {
        expect(res.status).toBe(404);
        expect(body).toContain("console not built");
      }
    }
    // The graph page survives the handover in both states: the console frames it.
    expect((await fetch(`${base}/graph.html`)).status).toBe(200);
  });

  it("GET /namespaces lists every partition, including the ones holding only tombstones", async () => {
    const saved = await fetch(`${base}/memories`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ namespace: "test:2", type: "semantic", text: "user prefers dark mode" })
    });
    expect(saved.status).toBe(201);
    const { id } = (await saved.json()) as { id: string };
    // a tombstoned-only partition still has to be offered by the picker
    await fetch(`${base}/memories/${id}`, { method: "DELETE" });
    const listed = await fetch(`${base}/memories?namespace=test:2`);
    expect(((await listed.json()) as { total: number }).total).toBe(0);

    const res = await fetch(`${base}/namespaces`);
    expect(res.status).toBe(200);
    const { namespaces } = (await res.json()) as { namespaces: string[] };
    expect(namespaces).toContain("test:1");
    expect(namespaces).toContain("test:2");
  });
});

describe("embedding switch", () => {
  interface Info {
    live: { provider: string; dim: number; model: string | null; source: string };
    target: { provider: string; dim: number; model: string | null } | null;
    targetError: string | null;
    needsRestart: boolean;
    presets: { provider: string; keyEnv: string | null; model: string | null; dim: number }[];
    keys: { env: string; present: boolean }[];
    shadowed: string[];
    settingsPath: string;
    stored: { byVectorDim: Record<string, number>; unreadable: number };
  }
  interface Job {
    state: string; dryRun: boolean; scanned: number; rewritten: number;
    done: number; total: number; failed: { id: string; error: string }[]; error: string | null;
  }

  let base = "";
  let close: () => Promise<void> = async () => {};
  let store: InMemoryVectorStore;
  let home = "";
  // Captured and restored: this suite points the settings file at a temp dir, and a
  // real EMBEDDING_PROVIDER in the environment would make the answers here depend on
  // whoever ran the tests.
  const TOUCHED = ["AI_MEMORY_HOME", "EMBEDDING_PROVIDER", "EMBEDDING_DIM", "NIM_DIM", "NVIDIA_API_KEY", "NIM_API_KEY", "OPENAI_API_KEY"] as const;
  const savedEnv: Record<string, string | undefined> = {};

  const getInfo = async (): Promise<Info> => (await (await fetch(`${base}/embedding?namespace=test:9`)).json()) as Info;
  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const waitForJob = async (): Promise<Job> => {
    for (let i = 0; i < 200; i++) {
      const job = (await (await fetch(`${base}/embedding/reembed`)).json()) as Job;
      if (job.state !== "running") return job;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("re-embed job never finished");
  };

  beforeAll(async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    for (const key of TOUCHED) savedEnv[key] = process.env[key];
    delete process.env.EMBEDDING_PROVIDER;
    delete process.env.EMBEDDING_DIM;
    delete process.env.NIM_DIM;
    delete process.env.NVIDIA_API_KEY;
    delete process.env.NIM_API_KEY;
    delete process.env.OPENAI_API_KEY;
    home = await mkdtemp(join(tmpdir(), "om-settings-"));
    process.env.AI_MEMORY_HOME = home;

    store = new InMemoryVectorStore();
    const svc = new MemoryService({ store, embedder: new HashEmbeddingProvider() });
    const { app } = await buildServer({ service: svc });
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
    close = () => new Promise<void>((r) => app.close(() => r()));
    await post("/memories", { namespace: "test:9", type: "semantic", text: "user lives in Berlin" });
  });

  afterAll(async () => {
    await close();
    for (const key of TOUCHED) {
      const value = savedEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    const { rm } = await import("node:fs/promises");
    if (home) await rm(home, { recursive: true, force: true });
  });

  it("adds byVectorDim under full=1 and leaves the default shape alone", async () => {
    const plain = (await (await fetch(`${base}/stats?namespace=test:9`)).json()) as Record<string, unknown>;
    expect(plain.byVectorDim).toBeUndefined();
    const full = (await (await fetch(`${base}/stats?namespace=test:9&full=1`)).json()) as { byVectorDim: Record<string, number> };
    expect(full.byVectorDim).toEqual({ "384": 1 });
  });

  it("reports the live provider, its source, the presets and the store widths", async () => {
    const info = await getInfo();
    expect(info.live).toEqual({ provider: "hash", dim: 384, model: null, source: "default" });
    expect(info.target).toEqual({ provider: "hash", dim: 384, model: null });
    expect(info.needsRestart).toBe(false);
    expect(info.presets.map((p) => p.provider)).toEqual(["hash", "openai", "nim"]);
    expect(info.keys.find((k) => k.env === "OPENAI_API_KEY")?.present).toBe(false);
    expect(info.stored.byVectorDim).toEqual({ "384": 1 });
    expect(info.stored.unreadable).toBe(0);
    expect(info.settingsPath.startsWith(home)).toBe(true);
  });

  it("counts the rows the live provider cannot read", async () => {
    const listed = (await (await fetch(`${base}/memories?namespace=test:9`)).json()) as { memories: { id: string }[] };
    const id = listed.memories[0]!.id;
    // what an interrupted migration leaves behind: a row at another provider's width
    await store.updateEmbedding(id, [0.1, 0.2, 0.3], "user lives in Berlin");
    const info = await getInfo();
    expect(info.stored.byVectorDim).toEqual({ "3": 1 });
    expect(info.stored.unreadable).toBe(1);
  });

  it("rejects an unknown provider without writing a settings file", async () => {
    const res = await post("/embedding", { EMBEDDING_PROVIDER: "nope" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("unknown EMBEDDING_PROVIDER");
    const { existsSync } = await import("node:fs");
    expect(existsSync(`${home}/settings.json`)).toBe(false);
  });

  it("refuses a provider whose key is missing, naming the variable", async () => {
    const res = await post("/embedding", { EMBEDDING_PROVIDER: "openai" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("OPENAI_API_KEY");
  });

  it("refuses to store anything key-shaped", async () => {
    const res = await post("/embedding", { NVIDIA_API_KEY: "nvapi-not-really" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("belong in the environment");
  });

  it("refuses a write the environment would override", async () => {
    // The precedence is real env > file, so a key already set in the environment makes
    // this write a no-op. Measured on the real machine: this repo's .env sets
    // EMBEDDING_PROVIDER, which is exactly this case — and answering "ok" while nothing
    // moved is the silent failure the whole switch exists to avoid.
    const { existsSync } = await import("node:fs");
    const before = existsSync(`${home}/settings.json`);
    process.env.EMBEDDING_PROVIDER = "hash";
    try {
      const res = await post("/embedding", { EMBEDDING_PROVIDER: "hash" });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain("overrides settings.json");
      expect((await getInfo()).shadowed).toContain("EMBEDDING_PROVIDER");
      // and it wrote nothing on the way out
      expect(existsSync(`${home}/settings.json`)).toBe(before);
    } finally {
      delete process.env.EMBEDDING_PROVIDER;
    }
  });

  it("writes a valid switch, then reports that a restart is required", async () => {
    process.env.NVIDIA_API_KEY = "nvapi-test-only";
    try {
      const res = await post("/embedding", { EMBEDDING_PROVIDER: "nim", EMBEDDING_DIM: "2048" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { needsRestart: boolean; target: { provider: string; dim: number; model: string | null } };
      expect(body.needsRestart).toBe(true);
      expect(body.target).toEqual({ provider: "nim", dim: 2048, model: "nvidia/nemotron-3-embed-1b" });

      const info = await getInfo();
      expect(info.live.provider).toBe("hash");
      expect(info.target?.provider).toBe("nim");
      expect(info.needsRestart).toBe(true);

      const { readFileSync } = await import("node:fs");
      const written = JSON.parse(readFileSync(`${home}/settings.json`, "utf8")) as Record<string, string>;
      expect(written.EMBEDDING_PROVIDER).toBe("nim");
      expect(written.EMBEDDING_DIM).toBe("2048");
      expect(Object.keys(written).some((k) => /KEY|TOKEN|SECRET/i.test(k))).toBe(false);
    } finally {
      delete process.env.NVIDIA_API_KEY;
    }
  });

  it("refuses to migrate to a provider it cannot build", async () => {
    // The previous case left the settings naming nim with no key in the environment.
    // Migrating to it is impossible, and that has to be a 400 naming the variable —
    // not a job that fails one row at a time.
    const res = await post("/embedding/reembed", { dryRun: false });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("NVIDIA_API_KEY");
  });

  it("defaults to a dry run", async () => {
    await post("/embedding", { EMBEDDING_PROVIDER: "hash" });
    const res = await post("/embedding/reembed", {});
    expect(res.status).toBe(202);
    expect(((await res.json()) as Job).dryRun).toBe(true);
    expect((await waitForJob()).state).toBe("done");
  });

  it("dry-runs without writing, then migrates the row for real", async () => {
    // An explicit hash target: the settings file says nim, and a test that made remote
    // embedding calls would be a test that spends money. The job is what is under test.
    await post("/embedding", { EMBEDDING_PROVIDER: "hash" });

    const dry = await post("/embedding/reembed", { dryRun: true });
    expect(dry.status).toBe(202);
    const dryJob = await waitForJob();
    expect(dryJob.scanned).toBe(1);
    expect(dryJob.failed).toEqual([]);
    // nothing written: the foreign-width row is still foreign
    expect((await getInfo()).stored.byVectorDim).toEqual({ "3": 1 });

    expect((await post("/embedding/reembed", { dryRun: false })).status).toBe(202);
    const real = await waitForJob();
    expect(real.rewritten).toBe(1);
    const after = await getInfo();
    expect(after.stored.byVectorDim).toEqual({ "384": 1 });
    expect(after.stored.unreadable).toBe(0);
  });
});
