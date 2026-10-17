import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import { createServer, request, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { summarize } from "../src/core/stats.js";
import { readSettings, settingsPath, writeSettings } from "../src/core/settings.js";
import { readEnvFile } from "../src/core/envFile.js";
import { buildServer } from "../src/api/server.js";
import { MemoryService } from "../src/core/memoryService.js";
import { InMemoryVectorStore } from "../src/core/store/memory.js";
import { HashEmbeddingProvider } from "../src/core/embedding/hash.js";
import type { Memory } from "../src/core/types.js";

const DAY = 24 * 60 * 60 * 1000;

/**
 * A POST with exactly the headers the caller names — the only way a test can send none at
 * all, since `fetch` always sets a content type for a string body.
 */
function postRaw(port: number, path: string, headers: Record<string, string>, body: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path, method: "POST", headers: { ...headers, "content-length": Buffer.byteLength(body) } },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => { text += chunk; });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

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

  it("a search can cover more than one partition, which is what the CLI asks for", async () => {
    // The CLI resolves its own partition plus the legacy one and sends the list. Before
    // `namespaces` existed it could only hand over one, so a daemon-backed `search`
    // answered from the server's default partition and reported nothing found for rows
    // that were sitting in the caller's own.
    const save = (namespace: string, text: string) =>
      fetch(`${base}/memories`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ namespace, type: "semantic", text })
      });
    await save("split:a", "the nightly job writes to the analytics bucket");
    await save("split:b", "the nightly job writes to the analytics bucket");

    const hits = async (qs: string) =>
      ((await (await fetch(`${base}/memories/search?${qs}`)).json()) as { memories: { namespace: string }[] })
        .memories.map((m) => m.namespace);

    expect(await hits("query=nightly%20job&namespace=split:a&threshold=0")).toEqual(["split:a"]);
    expect((await hits("query=nightly%20job&namespace=split:a&namespaces=split%3Aa,split%3Ab&threshold=0")).sort())
      .toEqual(["split:a", "split:b"]);
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

  it("refuses a credential on the embedding route", async () => {
    // A whitelisted secret is writable now, but not here: this route owns the switch.
    const res = await post("/embedding", { NVIDIA_API_KEY: "nvapi-not-really" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("is not an embedding setting");
  });

  it("refuses several non-switch keys with a plural", async () => {
    // One key reads as a sentence, more than one has to agree with the verb. Both keys
    // here are whitelisted secrets, so `writeSettings` would take them: the scope guard
    // is the only thing standing between them and settings.json.
    const res = await post("/embedding", { OPENAI_API_KEY: "sk-not-really", JEV_API_KEY: "a" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("are not embedding settings");
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

  it("keeps vectors off the wire unless asked for them", async () => {
    // ~9 kB per memory, discarded by both in-repo consumers after receipt. The flag
    // exists for whoever genuinely wants raw vectors.
    const list = (await (await fetch(`${base}/memories?namespace=test:9`)).json()) as { memories: (Record<string, unknown> & { id: string })[] };
    expect(list.memories).toHaveLength(1);
    expect(list.memories[0]).not.toHaveProperty("embedding");
    const id = list.memories[0]!.id;

    const withVec = (await (await fetch(`${base}/memories?namespace=test:9&embedding=1`)).json()) as { memories: { embedding: number[] }[] };
    expect(withVec.memories[0]!.embedding).toHaveLength(384);

    const one = (await (await fetch(`${base}/memories/${id}`)).json()) as Record<string, unknown>;
    expect(one).not.toHaveProperty("embedding");
    const oneVec = (await (await fetch(`${base}/memories/${id}?embedding=1`)).json()) as { embedding: number[] };
    expect(oneVec.embedding).toHaveLength(384);

    const hits = (await (await post("/memories/search", { namespace: "test:9", query: "Berlin", threshold: 0, k: 5 })).json()) as { memories: Record<string, unknown>[] };
    expect(hits.memories.length).toBeGreaterThan(0);
    expect(hits.memories[0]).not.toHaveProperty("embedding");
  });

  it("previews the switch before saving a patch of extractor or judge knobs", async () => {
    // This route answers with the target, so it has to hold one before it writes. A settings
    // file that cannot build an embedder is the seam: the patch below names no embedding
    // key, so the shared guard has nothing of its own to preview and would write first.
    await writeSettings({ EMBEDDING_PROVIDER: "nope" }, home);
    const before = readSettings(home);

    const res = await post("/embedding", { EXTRACTOR_MODEL: "extractor-test" });

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("unknown EMBEDDING_PROVIDER");
    // A 400 for a patch it already saved is the one answer this route must never give.
    expect(readSettings(home)).toEqual(before);
  });
});

// The console's credential routes. Three things decide whether this feature is safe, and
// each has its own case here: no response or error body may carry a full key value,
// `/admin/shutdown` must not act for anything but the loopback address, and a console
// write route must get a JSON request from a loopback origin — a page in the user's own
// browser is a loopback peer too. The `Origin` half is what every mutation gets
// ("mutation gate" below); here it has to hold for the console's own routes.
describe("settings routes", () => {
  interface Entry {
    name: string;
    kind: "secret" | "plain";
    source: "env" | "file" | "default" | "absent";
    masked: string | null;
    effect: "immediate" | "restart";
    writable: boolean;
  }
  interface Inventory {
    entries: Entry[];
    settingsPath: string;
    envPath: string;
    restartRequired: boolean;
  }

  const ENV_KEY = "sk-env-openai-4821";
  const FILE_KEY = "jev-file-secret-7734";
  const ENV_ONLY = "typesafe-env-only-3310";
  const JEV_GOOD = "jev-candidate-9001";
  const JEV_BAD = "jev-rejected-0042";

  // Captured and restored: this suite points the settings file at a temp home, refuses to
  // inherit the developer's own keys, and stands a local JEV endpoint up so validation is
  // one HTTP call to a stub rather than one to api.typesafe.ai.
  const TOUCHED = [
    "AI_MEMORY_HOME", "MEMORY_ENV_FILE",
    "OPENAI_API_KEY", "NVIDIA_API_KEY", "NIM_API_KEY", "JEV_API_KEY", "JEV_API_KEY_FILE",
    "TYPESAFE_API_KEY", "JEV_ENDPOINT",
    "EMBEDDING_PROVIDER", "EMBEDDING_DIM", "NIM_DIM",
  ] as const;

  let base = "";
  let home = "";
  let envFile = "";
  let jev: Server;
  let close: () => Promise<void> = async () => {};
  let shutdowns = 0;
  let shutdownFired: () => void = () => {};
  const shutdownCalled = new Promise<void>((resolve) => { shutdownFired = resolve; });
  const savedEnv: Record<string, string | undefined> = {};

  const post = (p: string, body: unknown) =>
    fetch(`${base}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  beforeAll(async () => {
    for (const key of TOUCHED) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }

    home = mkdtempSync(path.join(tmpdir(), "ai-memory-console-"));
    envFile = path.join(home, ".env");
    process.env.AI_MEMORY_HOME = home;
    process.env.MEMORY_ENV_FILE = envFile;
    // Two "real environment" keys: one whitelisted, one that only the judge reads.
    process.env.OPENAI_API_KEY = ENV_KEY;
    process.env.TYPESAFE_API_KEY = ENV_ONLY;

    jev = createServer((req, res) => {
      req.on("data", () => {});
      req.on("end", () => {
        if (req.headers.authorization === `Bearer ${JEV_BAD}`) {
          res.writeHead(401, { "content-type": "text/plain" });
          res.end("unauthorized");
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ model: "jev-test", answers: { keep: { type: "noul", noul: 0.9 } } }));
      });
    });
    await new Promise<void>((r) => jev.listen(0, "127.0.0.1", r));
    process.env.JEV_ENDPOINT = `http://127.0.0.1:${(jev.address() as AddressInfo).port}/v1/systemone`;

    const svc = new MemoryService({ store: new InMemoryVectorStore(), embedder: new HashEmbeddingProvider() });
    const { app } = await buildServer({ service: svc, onShutdown: () => { shutdowns++; shutdownFired(); } });
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
    close = () => new Promise<void>((r) => app.close(() => r()));
  });

  afterAll(async () => {
    await close();
    await new Promise<void>((r) => jev.close(() => r()));
    for (const key of TOUCHED) {
      const value = savedEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
  });

  it("inventories every key by source, and never puts a full secret on the wire", async () => {
    await writeSettings({ JEV_API_KEY: FILE_KEY }, home);

    const res = await fetch(`${base}/settings`);
    expect(res.status).toBe(200);
    const text = await res.text();
    // The whole point of the masked form: this body cannot be pasted into a chat.
    for (const clear of [ENV_KEY, FILE_KEY, ENV_ONLY]) expect(text).not.toContain(clear);

    const body = JSON.parse(text) as Inventory;
    const byName = Object.fromEntries(body.entries.map((entry) => [entry.name, entry]));
    expect(byName.OPENAI_API_KEY).toMatchObject({ kind: "secret", source: "env", masked: "…4821", effect: "immediate" });
    expect(byName.JEV_API_KEY).toMatchObject({ kind: "secret", source: "file", masked: "…7734", effect: "immediate" });
    // Read by the judge from the environment, outside both whitelists: the console has to
    // say so rather than show a blank field that reads as "nothing is set".
    expect(byName.TYPESAFE_API_KEY).toMatchObject({ source: "env", masked: "…3310", writable: false });
    expect(byName.EMBEDDING_PROVIDER).toMatchObject({ source: "default", effect: "restart" });

    expect(body.settingsPath).toBe(settingsPath(home));
    expect(body.envPath).toBe(envFile);
    // Nothing pending: the live embedder is what a restart would build.
    expect(body.restartRequired).toBe(false);
  });

  it("refuses a key the real environment already provides, naming where it lives", async () => {
    const res = await post("/settings", { OPENAI_API_KEY: "sk-console-attempt" });

    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toContain("is set in the environment");
    expect(text).not.toContain(ENV_KEY);
  });

  it("refuses a name outside both whitelists", async () => {
    const res = await post("/settings", { NOPE: "x" });

    expect(res.status).toBe(400);
    expect((await res.text()).includes("NOPE")).toBe(true);
  });

  it("validates a judge key with one call, then stores it", async () => {
    const res = await post("/settings", { JEV_API_KEY: JEV_GOOD });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ saved: ["JEV_API_KEY"], restartRequired: false });
    expect(readSettings(home).JEV_API_KEY).toBe(JEV_GOOD);
  });

  it("refuses a judge key the endpoint rejects, and leaves the file alone", async () => {
    const before = readSettings(home);

    const res = await post("/settings", { JEV_API_KEY: JEV_BAD });

    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toContain("401");
    // A rejected key must not come back in the error body either.
    expect(text).not.toContain(JEV_BAD);
    expect(readSettings(home)).toEqual(before);
  });

  it("adopts the .env keys into the file and comments them out, once", async () => {
    writeFileSync(
      envFile,
      "NIM_API_KEY=nvapi-from-dotenv-6612\nJEV_API_KEY=jev-from-dotenv-2288\nTYPESAFE_API_KEY=typesafe-from-dotenv-5566\n",
      "utf8",
    );

    const first = await post("/settings/adopt-env", {});
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({
      adopted: ["NIM_API_KEY", "JEV_API_KEY"],
      notAdopted: [],
      backupPath: `${envFile}.bak`,
      restartRequired: true,
    });
    expect(readSettings(home)).toMatchObject({ NIM_API_KEY: "nvapi-from-dotenv-6612", JEV_API_KEY: "jev-from-dotenv-2288" });
    // Commented, never deleted: a wrong adopt is undone by removing a `#`.
    expect(readFileSync(envFile, "utf8")).toBe(
      "#NIM_API_KEY=nvapi-from-dotenv-6612\n#JEV_API_KEY=jev-from-dotenv-2288\nTYPESAFE_API_KEY=typesafe-from-dotenv-5566\n",
    );
    // The name outside both whitelists stays enabled in .env, where the loader reads it.
    expect(readEnvFile(envFile).filter((entry) => entry.enabled).map((entry) => entry.name)).toEqual(["TYPESAFE_API_KEY"]);

    const second = await post("/settings/adopt-env", {});
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ adopted: [], notAdopted: [], backupPath: null, restartRequired: true });
  });

  it("refuses an adopt-env that is not a JSON request, leaving .env and settings alone", async () => {
    // The shape a foreign page can send without a preflight: a simple POST with a form body.
    writeFileSync(envFile, "NIM_API_KEY=nvapi-not-adopted-7712\n", "utf8");
    const beforeEnv = readFileSync(envFile, "utf8");
    const beforeSettings = readSettings(home);

    const res = await fetch(`${base}/settings/adopt-env`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "NIM_API_KEY=nvapi-not-adopted-7712",
    });

    expect(res.status).toBe(415);
    expect(readFileSync(envFile, "utf8")).toBe(beforeEnv);
    expect(readSettings(home)).toEqual(beforeSettings);
  });

  it("refuses a shutdown asked for by a foreign origin, and stops nothing", async () => {
    const res = await fetch(`${base}/admin/shutdown`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
    });

    expect(res.status).toBe(403);
    // A refusal names no values — the origin it rejected least of all.
    expect(await res.text()).not.toContain("evil.example");
    expect(shutdowns).toBe(0);
  });

  it("refuses a shutdown asked for by a lookalike of a loopback address", async () => {
    // A hostname anyone can register and point at itself: it starts with `127.` and is not
    // a dotted quad, which the old `/^127\./` prefix test read as this machine.
    const res = await fetch(`${base}/admin/shutdown`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://127.0.0.1.evil.example" },
    });

    expect(res.status).toBe(403);
    expect(shutdowns).toBe(0);
  });

  it("refuses an adopt-env asked for by a lookalike of a loopback address, leaving .env alone", async () => {
    writeFileSync(envFile, "NIM_API_KEY=nvapi-not-adopted-4477\n", "utf8");
    const beforeEnv = readFileSync(envFile, "utf8");
    const beforeSettings = readSettings(home);

    const res = await fetch(`${base}/settings/adopt-env`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://127.0.0.1.evil.example" },
      body: "{}",
    });

    expect(res.status).toBe(403);
    expect(readFileSync(envFile, "utf8")).toBe(beforeEnv);
    expect(readSettings(home)).toEqual(beforeSettings);
  });

  it("allows a loopback origin, spelled as localhost or as the quad", async () => {
    for (const origin of ["http://localhost:7331", "http://127.0.0.1:7331"]) {
      const res = await fetch(`${base}/settings`, {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({ NOPE: "x" }),
      });
      // Past the gate and into the route's own validation: the refusal names the key, and
      // a 400 here is only reachable once the origin was accepted.
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("NOPE");
    }
  });

  it("shuts down for a loopback caller only", async () => {
    // A second listener whose peer address is rewritten to a public one. `remoteAddress`
    // is the only thing the route may trust, and this is the only way to reach that branch
    // from a test that can only talk to its own machine.
    const svc = new MemoryService({ store: new InMemoryVectorStore(), embedder: new HashEmbeddingProvider() });
    let ran = 0;
    const { app } = await buildServer({ service: svc, onShutdown: () => { ran++; } });
    app.on("connection", (socket) => {
      Object.defineProperty(socket, "remoteAddress", { value: "203.0.113.9", configurable: true });
    });
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    const remote = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
    try {
      const res = await fetch(`${remote}/admin/shutdown`, { method: "POST" });
      // Answered as if the route were not there: a stranger learns nothing by asking.
      expect(res.status).toBe(404);
      expect(await res.text()).toContain("not found");
      expect(ran).toBe(0);
    } finally {
      await new Promise<void>((r) => app.close(() => r()));
    }

    // A JSON request with no Origin — curl, the CLI, the console same-origin fetch.
    const res = await fetch(`${base}/admin/shutdown`, { method: "POST", headers: { "content-type": "application/json" } });
    expect(res.status).toBe(204);
    await shutdownCalled;
    expect(shutdowns).toBe(1);
  });
});

// The other half of the gate. `Origin` is checked on every POST/PATCH/DELETE, not just on
// the four console routes: POST /decay and POST /extract are simple requests too, and the
// CLI, the pi extension and the hooks reach them with no `Origin` and not always a JSON
// content type — which is why only the Origin check is global.
describe("mutation gate", () => {
  let base = "";
  let close: () => Promise<void> = async () => {};
  let svc: MemoryService;

  beforeAll(async () => {
    svc = new MemoryService({ store: new InMemoryVectorStore(), embedder: new HashEmbeddingProvider() });
    const { app } = await buildServer({ service: svc });
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
    close = () => new Promise<void>((r) => app.close(() => r()));
  });
  afterAll(async () => { await close(); });

  it("refuses POST /decay from a foreign origin, and prunes nothing", async () => {
    // A row decay would take: working, past its 7-day window, strength under the cap.
    const old = await svc.store.insert({ namespace: "gate:1", type: "working", text: "a working row past its window", strength: 0.1 }, []);
    old.createdAt = Date.now() - 30 * DAY;

    const refused = await fetch(`${base}/decay`, { method: "POST", headers: { origin: "https://evil.example" } });
    expect(refused.status).toBe(403);
    expect(await refused.text()).not.toContain("evil.example");
    expect((await svc.store.getById(old.id))?.isDeleted).toBe(0);

    // The same request with no Origin — the CLI — still prunes it, so the row above was
    // a live candidate and the refusal above was the gate, not an empty store.
    const local = await fetch(`${base}/decay`, { method: "POST" });
    expect(local.status).toBe(200);
    expect(((await local.json()) as { pruned: number }).pruned).toBe(1);
  });

  it("refuses POST /extract from a foreign origin, and stores nothing", async () => {
    const refused = await fetch(`${base}/extract`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ text: "I live in Berlin", namespace: "gate:2" }),
    });

    expect(refused.status).toBe(403);
    expect((await svc.list({ namespace: "gate:2" })).total).toBe(0);
  });

  it("accepts POST /extract with neither an Origin nor a JSON content type", async () => {
    // The compatibility case, kept as a test so the two-tier decision cannot quietly
    // become a global content-type requirement later.
    const res = await postRaw(Number(new URL(base).port), "/extract", {}, JSON.stringify({ text: "I live in Berlin", namespace: "gate:3" }));

    expect(res.status).toBe(200);
    expect((JSON.parse(res.text) as { extracted: number }).extracted).toBeGreaterThan(0);
    expect((await svc.list({ namespace: "gate:3" })).total).toBeGreaterThan(0);
  });
});
