import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildServer } from "../src/api/server.js";
import { MemoryService } from "../src/core/memoryService.js";
import { InMemoryVectorStore } from "../src/core/store/memory.js";
import { HashEmbeddingProvider } from "../src/core/embedding/hash.js";
import type { EmbeddingProvider } from "../src/core/embedding/provider.js";
import { MemoryClient } from "../src/cli/http.js";
import { runPrincipalCommand } from "../src/cli/principal.js";
import { buildInjection } from "../src/adapters/inject.js";
import {
  PRINCIPAL_HEADER,
  loadOrCreatePrincipal,
  recoverUserFromNamespaces,
  type PrincipalBinding,
} from "../src/core/principal.js";
import { resetScopeCache } from "../src/core/scope.js";

/**
 * P7 (ADR-0049) — the principal and the local boundary.
 *
 * The threat being defended: a process under ANOTHER OS account can reach the loopback
 * port but cannot read this account's key file, so it can no longer read another user's
 * partitions by naming them. What is pinned here, per the plan's own test list:
 * tokenless → 401, foreign (wrong token or foreign user segment) → 403, same principal
 * → unchanged passthrough, recover re-binds from the store, and the ungated server keeps
 * the exact pre-P7 namespace contract the existing suite (and every existing row) relies on.
 */

const TOKEN = "tok-frank-0123456789abcdef";
const PRINCIPAL: PrincipalBinding = { token: TOKEN, user: "frank", path: "/tmp/principal.key" };

const USER_ENV_KEYS = ["AI_MEMORY_USER", "MEMORY_USER", "AI_MEMORY_AGENT", "MEMORY_AGENT"];

describe("principal: the gated daemon", () => {
  let base = "";
  let close = () => {};
  let service: MemoryService;
  let shutDown = false;

  beforeAll(async () => {
    for (const k of USER_ENV_KEYS) delete process.env[k];
    resetScopeCache();
    service = new MemoryService({ store: new InMemoryVectorStore(), embedder: new HashEmbeddingProvider() });
    const { app } = await buildServer({
      service,
      principal: PRINCIPAL,
      onShutdown: () => {
        shutDown = true;
      },
    });
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
    close = () => new Promise<void>((r) => app.close(() => r()));
  });
  afterAll(async () => {
    for (const k of USER_ENV_KEYS) delete process.env[k];
    resetScopeCache();
    await close();
  });

  const post = (p: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(base + p, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  const authed = { [PRINCIPAL_HEADER]: TOKEN };

  it("answers a tokenless write with 401 and names the header and the key file", async () => {
    const res = await post("/memories", { type: "semantic", text: "no token" });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain(PRINCIPAL_HEADER);
    expect(body.error).toContain(PRINCIPAL.path);
  });

  it("answers a tokenless read with 401", async () => {
    const res = await fetch(`${base}/memories/search?query=dark%20mode`);
    expect(res.status).toBe(401);
  });

  it("answers a wrong token with 403 — the foreign-principal knock", async () => {
    const res = await fetch(`${base}/memories?namespace=default:default`, {
      headers: { [PRINCIPAL_HEADER]: "tok-someone-else-entirely" },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("frank");
  });

  it("keeps /health open (the liveness probe the CLI and daemon restart decide on)", async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
  });

  it("keeps the static shell open and carries NO secret in anything it serves", async () => {
    const res = await fetch(`${base}/graph.html`);
    expect(res.status).toBe(200);
    const html = await res.text();
    // The first cut injected the live token as a meta tag here; independent review broke
    // the whole cross-account boundary with that one request (a tokenless GET of a static
    // page minted the header). A served page yields nothing that authenticates.
    expect(html).not.toContain(TOKEN);
    expect(html).not.toContain("ai-memory-principal");
  });

  it("the review's repro stays closed: a tokenless static fetch cannot mint the header", async () => {
    // Step 1 — the unauthenticated fetch that used to leak.
    const page = await (await fetch(`${base}/graph.html`)).text();
    expect(page).not.toContain(TOKEN);
    // Step 2 — without the key file, the gated routes still refuse.
    const gated = await fetch(`${base}/namespaces`);
    expect(gated.status).toBe(401);
  });

  it("refuses a tokenless /admin/shutdown with 401 and does not stop the daemon", async () => {
    const res = await post("/admin/shutdown", {});
    expect(res.status).toBe(401);
    expect(shutDown).toBe(false);
  });

  it("serves /admin/shutdown with the token (the CLI's daemon restart keeps working)", async () => {
    const res = await post("/admin/shutdown", {}, authed);
    expect(res.status).toBe(204);
    expect(shutDown).toBe(true);
  });

  it("refuses an explicit foreign user segment with 403 instead of honoring or relabeling it", async () => {
    const res = await post("/memories", { namespace: "pi:alice", type: "semantic", text: "cross principal" }, authed);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("pi:alice");
    expect(body.error).toContain("frank");
  });

  it("refuses a namespaces list when one entry is foreign — a partial answer is the lie a boundary must not tell", async () => {
    // `namespaces` is comma-separated on the wire (the CLI's fan-out form).
    const res = await post("/memories/search", { query: "x", namespaces: "pi:frank,pi:alice" }, authed);
    expect(res.status).toBe(403);
    const get = await fetch(`${base}/memories/search?query=x&namespaces=${encodeURIComponent("pi:frank,pi:alice")}`, {
      headers: authed,
    });
    expect(get.status).toBe(403);
  });

  it("applies the same 403 to the other namespace-addressed routes", async () => {
    for (const [path, init] of [
      [`/memories?namespace=${encodeURIComponent("pi:alice")}`, { headers: authed }],
      [`/stats?namespace=${encodeURIComponent("pi:alice")}`, { headers: authed }],
      ["/extract", { method: "POST", headers: { "content-type": "application/json", ...authed }, body: JSON.stringify({ text: "user lives in Tokyo", namespace: "pi:alice" }) }],
    ] as const) {
      const res = await fetch(base + path, init);
      expect(res.status, path).toBe(403);
    }
  });

  it("checks the row's own partition on by-id access — an id is an address too", async () => {
    const row = await service.save({ namespace: "pi:alice", type: "semantic", text: "a foreign segment row" });
    const got = await fetch(`${base}/memories/${encodeURIComponent(row.id)}`, { headers: authed });
    expect(got.status).toBe(403);
    const patched = await fetch(`${base}/memories/${encodeURIComponent(row.id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...authed },
      body: JSON.stringify({ pin: 1 }),
    });
    expect(patched.status).toBe(403);
    const deleted = await fetch(`${base}/memories/${encodeURIComponent(row.id)}`, {
      method: "DELETE",
      headers: authed,
    });
    expect(deleted.status).toBe(403);
    // the refused deletes must not have deleted
    expect((await service.get(row.id))?.id).toBe(row.id);
  });

  it("passes the principal's own namespaces through byte for byte", async () => {
    const created = (await (await post("/memories", { namespace: "pi:frank", type: "semantic", text: "own segment row" }, authed)).json()) as {
      namespace: string;
      id: string;
    };
    expect(created.namespace).toBe("pi:frank");
    const found = await fetch(`${base}/memories/${encodeURIComponent(created.id)}`, { headers: authed });
    expect(found.status).toBe(200);
  });

  it("overwrites the user segment the caller leaves unpinned — the wire decides, not the env", async () => {
    process.env.AI_MEMORY_USER = "somebodyelse";
    try {
      const res = await post("/memories", { agent: "pi", scope: "private", type: "semantic", text: "scoped write" }, authed);
      expect(res.status).toBe(201);
      const body = (await res.json()) as { namespace: string };
      expect(body.namespace).toBe("pi:frank");
    } finally {
      delete process.env.AI_MEMORY_USER;
    }
  });

  it("keeps the legacy default:default partition open — where every pre-P7 row lives", async () => {
    const created = (await (await post("/memories", { type: "semantic", text: "legacy partition row" }, authed)).json()) as {
      namespace: string;
    };
    expect(created.namespace).toBe("default:default");
    const found = await fetch(`${base}/memories/search?query=${encodeURIComponent("legacy partition row")}`, {
      headers: authed,
    });
    const body = (await found.json()) as { memories: { text: string }[] };
    expect(body.memories.map((m) => m.text)).toContain("legacy partition row");
  });

  it("filters the namespace picker to partitions the principal can actually open", async () => {
    const res = await fetch(`${base}/namespaces`, { headers: authed });
    const body = (await res.json()) as { namespaces: string[] };
    expect(body.namespaces).not.toContain("pi:alice");
    expect(body.namespaces).toContain("pi:frank");
    expect(body.namespaces).toContain("default:default");
  });
});

describe("principal: the ungated server keeps the pre-P7 contract", () => {
  let base = "";
  let close = () => {};
  let service: MemoryService;

  beforeAll(async () => {
    service = new MemoryService({ store: new InMemoryVectorStore(), embedder: new HashEmbeddingProvider() });
    const { app } = await buildServer({ service });
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
    close = () => new Promise<void>((r) => app.close(() => r()));
  });
  afterAll(async () => {
    await close();
  });

  const post = (p: string, body: unknown) =>
    fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("accepts any explicit namespace tokenless, exactly as before", async () => {
    const created = (await (await post("/memories", { namespace: "test:reg", type: "semantic", text: "regression row" })).json()) as {
      namespace: string;
    };
    expect(created.namespace).toBe("test:reg");
  });

  it("leaves the namespace picker unfiltered and the env-driven user segment in charge", async () => {
    const row = await service.save({ namespace: "pi:alice", type: "semantic", text: "other segment" });
    expect(row.namespace).toBe("pi:alice");
    const res = await fetch(`${base}/namespaces`);
    const body = (await res.json()) as { namespaces: string[] };
    expect(body.namespaces).toContain("pi:alice");
  });
});

describe("principal: clients carry the token", () => {
  let gatedBase = "";
  let gatedClose = () => {};
  let service: MemoryService;
  let home = "";
  let savedHome: string | undefined;
  let savedDbPaths: [string, string | undefined][] = [];

  beforeAll(async () => {
    savedHome = process.env.AI_MEMORY_HOME;
    // The hook's in-process fallback opens the store it resolves from the environment —
    // pin it to an empty temp file so the test cannot read (or reinforce) whatever the
    // checkout's `.env` points MEMORY_DB_PATH at.
    savedDbPaths = [
      ["MEMORY_DB_PATH", process.env.MEMORY_DB_PATH],
      ["AI_MEMORY_DB", process.env.AI_MEMORY_DB],
    ];
    home = mkdtempSync(path.join(os.tmpdir(), "ai-memory-principal-home-"));
    const isolatedDb = path.join(home, "fallback.db");
    process.env.MEMORY_DB_PATH = isolatedDb;
    delete process.env.AI_MEMORY_DB;
    writeFileSync(
      path.join(home, "principal.key"),
      JSON.stringify({ version: 1, token: TOKEN, user: "frank", createdAt: new Date().toISOString() }, null, 2),
      "utf8"
    );
    service = new MemoryService({ store: new InMemoryVectorStore(), embedder: new HashEmbeddingProvider() });
    const { app } = await buildServer({ service, principal: PRINCIPAL });
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    gatedBase = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
    gatedClose = () => new Promise<void>((r) => app.close(() => r()));
  });
  afterAll(async () => {
    process.env.AI_MEMORY_HOME = savedHome;
    for (const [k, v] of savedDbPaths) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    for (const k of USER_ENV_KEYS) delete process.env[k];
    await gatedClose();
    rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it("MemoryClient reads the key file and gets through", async () => {
    process.env.AI_MEMORY_HOME = home;
    const client = new MemoryClient(gatedBase);
    const res = await client.get<{ namespaces?: string[] }>("/namespaces");
    expect(res.ok).toBe(true);
  });

  it("MemoryClient without a key file surfaces the daemon's 401 instead of a crash", async () => {
    const empty = mkdtempSync(path.join(os.tmpdir(), "ai-memory-empty-home-"));
    process.env.AI_MEMORY_HOME = empty;
    try {
      const client = new MemoryClient(gatedBase);
      const res = await client.get("/namespaces");
      expect(res.ok).toBe(false);
      expect(res.status).toBe(401);
      expect(res.error).toContain(PRINCIPAL_HEADER);
    } finally {
      rmSync(empty, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it("the hook (--server) rides the same token and falls back in-process when the daemon is gone", async () => {
    process.env.AI_MEMORY_HOME = home;
    // The hook resolves namespaces client-side; they must name the principal's segment.
    process.env.AI_MEMORY_AGENT = "claude";
    process.env.AI_MEMORY_USER = "frank";
    await service.save({ namespace: "claude:frank", type: "semantic", text: "the billing worker deploys on Tuesdays" });

    const block = await buildInjection({
      server: gatedBase,
      stdin: JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "when does the billing worker deploy" }),
    });
    expect(block).toContain("the billing worker deploys on Tuesdays");

    // Dead server: the hook degrades to the in-process store (empty here) and never throws.
    const fallback = await buildInjection({
      server: "http://127.0.0.1:1",
      stdin: JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "when does the billing worker deploy" }),
    });
    expect(fallback).toBe("");
  });
});

describe("principal: recover --from-db", () => {
  const tempDirs: string[] = [];
  const tempDir = () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ai-memory-recover-"));
    tempDirs.push(dir);
    return dir;
  };
  afterAll(() => {
    for (const dir of tempDirs) {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch {
        // A leaked temp dir beats a red suite on Windows file locking.
      }
    }
  });

  async function makeStore(dir: string): Promise<string> {
    const dbPath = path.join(dir, "memory.db");
    const svc = new MemoryService({ dbPath });
    await svc.init();
    await svc.save({ namespace: "pi:frank", type: "semantic", text: "frank row one" });
    await svc.save({ namespace: "shared:frank", type: "semantic", text: "frank row two" });
    await svc.save({ namespace: "default:default", type: "semantic", text: "legacy row" });
    await svc.close();
    return dbPath;
  }

  it("derives the user segment from the partitions the store actually holds", () => {
    expect(recoverUserFromNamespaces(["pi:frank", "shared:frank", "default:default"])).toBe("frank");
    expect(recoverUserFromNamespaces(["a:alice", "b:bob", "c:alice"])).toBe("alice");
    expect(recoverUserFromNamespaces(["default:default"])).toBe("default");
    expect(recoverUserFromNamespaces([])).toBe("default");
  });

  it("overwrites the key file one-way: a new token, the store's user segment, nothing reverse-computed", async () => {
    const dir = tempDir();
    const dbPath = await makeStore(dir);
    // A key file that survived but is wrong for this store — the moved-machine shape.
    mkdirSync(dir, { recursive: true });
    const keyPath = path.join(dir, "principal.key");
    writeFileSync(
      keyPath,
      JSON.stringify({ version: 1, token: "old-token-value", user: "wronguser", createdAt: "2026-01-01T00:00:00.000Z" }),
      "utf8"
    );
    const out: string[] = [];
    const err: string[] = [];
    const code = await runPrincipalCommand(["recover"], { "from-db": true, db: dbPath, home: dir }, {
      out: (s) => out.push(s),
      err: (s) => err.push(s),
    });
    expect(code).toBe(0);
    expect(err).toEqual([]);

    const written = JSON.parse(readFileSync(keyPath, "utf8")) as { token: string; user: string };
    expect(written.user).toBe("frank");
    expect(written.token).not.toBe("old-token-value");
    expect(out.join("\n")).toContain("new token");

    // The daemon's next start binds exactly what recover wrote.
    const rebound = await loadOrCreatePrincipal(dir);
    expect(rebound.user).toBe("frank");
    expect(rebound.token).toBe(written.token);
  });

  it("creates the key file when none exists, and still re-binds from the store", async () => {
    const dir = tempDir();
    const dbPath = await makeStore(dir);
    const out: string[] = [];
    const code = await runPrincipalCommand(["recover"], { "from-db": true, db: dbPath, home: dir }, {
      out: (s) => out.push(s),
      err: () => {},
    });
    expect(code).toBe(0);
    const keyPath = path.join(dir, "principal.key");
    expect(existsSync(keyPath)).toBe(true);
    expect((JSON.parse(readFileSync(keyPath, "utf8")) as { user: string }).user).toBe("frank");
  });

  it("refuses to run without --from-db and with no store to read", async () => {
    const dir = tempDir();
    const err: string[] = [];
    expect(await runPrincipalCommand(["recover"], {}, { out: () => {}, err: (s) => err.push(s) })).toBe(2);
    expect(await runPrincipalCommand(["recover"], { "from-db": true, db: path.join(dir, "missing.db"), home: dir }, { out: () => {}, err: (s) => err.push(s) })).toBe(1);
  });

  it("status reports the binding and names the mismatch when the store disagrees", async () => {
    const dir = tempDir();
    const dbPath = await makeStore(dir);
    const keyPath = path.join(dir, "principal.key");
    writeFileSync(
      keyPath,
      JSON.stringify({ version: 1, token: "status-token-000", user: "somebodyelse", createdAt: "2026-01-01T00:00:00.000Z" }),
      "utf8"
    );
    const out: string[] = [];
    const code = await runPrincipalCommand(["status"], { db: dbPath, home: dir }, { out: (s) => out.push(s), err: () => {} });
    expect(code).toBe(0);
    const text = out.join("\n");
    expect(text).toContain('user "somebodyelse"');
    // The store's partitions vote one segment: pi:frank and shared:frank are both frank's.
    expect(text).toContain("frank (2)");
    expect(text).toContain("recover --from-db");
  });

  it("keeps the key file owner-only on POSIX (the Windows story is the profile ACL, and says so)", async () => {
    const dir = tempDir();
    await loadOrCreatePrincipal(dir);
    if (process.platform === "win32") {
      // There is no 0600 on Windows to assert: Node's chmod has no permission bits here,
      // and the file's protection is the ACL inherited from the home directory. The
      // honest assertion is that the file exists where the ADR says it does.
      expect(existsSync(path.join(dir, "principal.key"))).toBe(true);
      return;
    }
    const { stat } = await import("node:fs/promises");
    const st = await stat(path.join(dir, "principal.key"));
    expect(st.mode & 0o777).toBe(0o600);
  });

  it("reads a store whose vectors disagree with this machine's env — the machine-move shape must not block the break-glass", async () => {
    // The reviewer's scenario: recover runs on a machine whose EMBEDDING_PROVIDER and
    // dim disagree with the file the hardest. `MemoryService.init` refuses that store
    // (constructor throws on env under-configuration, init throws on the dim guard),
    // so status/recover read the store directly, the way cmdReembed does.
    const dir = tempDir();
    const dbPath = path.join(dir, "memory.db");
    const wide: EmbeddingProvider = {
      name: "wide-test",
      dim: 1536,
      model: null,
      embed: async () => new Array(1536).fill(0.01),
      embedBatch: async (texts: string[]) => texts.map(() => new Array(1536).fill(0.01)),
    };
    const writer = new MemoryService({ dbPath, embedder: wide });
    await writer.init();
    await writer.save({ namespace: "pi:frank", type: "semantic", text: "a row written by another machine" });
    await writer.close();

    // The route the fix bypasses would refuse this file outright — pin the hazard:
    const throughService = new MemoryService({ dbPath });
    await expect(throughService.init()).rejects.toThrow(/dim mismatch/);
    await throughService.close();

    const out: string[] = [];
    const code = await runPrincipalCommand(["recover"], { "from-db": true, db: dbPath, home: dir }, {
      out: (s) => out.push(s),
      err: () => {},
    });
    expect(code).toBe(0);
    expect((JSON.parse(readFileSync(path.join(dir, "principal.key"), "utf8")) as { user: string }).user).toBe("frank");

    const statusOut: string[] = [];
    const code2 = await runPrincipalCommand(["status"], { db: dbPath, home: dir }, {
      out: (s) => statusOut.push(s),
      err: () => {},
    });
    expect(code2).toBe(0);
    expect(statusOut.join("\n")).toContain("frank (1)");
    expect(statusOut.join("\n")).not.toContain("dim mismatch");
  });

  it("survives an under-configured EMBEDDING_PROVIDER — the constructor guard cannot block recovery either", async () => {
    const dir = tempDir();
    const dbPath = await makeStore(dir);
    // The other half of the guard: an env the factory refuses throws inside the
    // MemoryService *constructor*, before any read could happen. recover must not care.
    process.env.EMBEDDING_PROVIDER = "openai-local";
    try {
      expect(() => new MemoryService({ dbPath })).toThrow(/openai-local needs/);

      const out: string[] = [];
      const code = await runPrincipalCommand(["recover"], { "from-db": true, db: dbPath, home: dir }, {
        out: (s) => out.push(s),
        err: () => {},
      });
      expect(code).toBe(0);
      expect((JSON.parse(readFileSync(path.join(dir, "principal.key"), "utf8")) as { user: string }).user).toBe("frank");
    } finally {
      delete process.env.EMBEDDING_PROVIDER;
    }
  });

  it("reveal prints the raw token — the console's unlock gate takes it from here", async () => {
    const dir = tempDir();
    const keyPath = path.join(dir, "principal.key");
    writeFileSync(
      keyPath,
      JSON.stringify({ version: 1, token: "reveal-me-0123456789", user: "frank", createdAt: "2026-01-01T00:00:00.000Z" }),
      "utf8"
    );
    const out: string[] = [];
    const code = await runPrincipalCommand(["reveal"], { home: dir }, { out: (s) => out.push(s), err: () => {} });
    expect(code).toBe(0);
    expect(out[0]).toBe("reveal-me-0123456789");
  });
});

describe("principal: the repair lever when the key file is re-issued under a running daemon", () => {
  const REISSUED = "tok-file-after-recover-0123456789";
  let base = "";
  let close = () => {};
  let shutDown = false;
  let keyPath = "";

  beforeAll(async () => {
    // The gate re-reads the key file from the process's memory home on a mismatch; the
    // suite's setup gave this file an empty temp home, so the re-issued file written
    // here is the only one it can find.
    keyPath = path.join(process.env.AI_MEMORY_HOME!, "principal.key");
    writeFileSync(
      keyPath,
      JSON.stringify({ version: 1, token: REISSUED, user: "frank", createdAt: new Date().toISOString() }, null, 2),
      "utf8"
    );
    const service = new MemoryService({ store: new InMemoryVectorStore(), embedder: new HashEmbeddingProvider() });
    const { app } = await buildServer({
      service,
      principal: PRINCIPAL,
      onShutdown: () => {
        shutDown = true;
      },
    });
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
    close = () => new Promise<void>((r) => app.close(() => r()));
  });
  afterAll(async () => {
    await close();
    rmSync(keyPath, { force: true });
  });

  const post = (p: string, body: unknown, token: string) =>
    fetch(base + p, {
      method: "POST",
      headers: { "content-type": "application/json", [PRINCIPAL_HEADER]: token },
      body: JSON.stringify(body),
    });

  it("shutdown accepts the file's current token even though the daemon holds the old binding — the break-glass flow walks", async () => {
    expect(shutDown).toBe(false);
    const res = await post("/admin/shutdown", {}, REISSUED);
    expect(res.status).toBe(204);
    expect(shutDown).toBe(true);
  });

  it("every other route refuses the re-issued token with the one message that names the way out", async () => {
    const res = await post("/memories", { type: "semantic", text: "x" }, REISSUED);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("re-issued");
    expect(body.error).toContain("ai-memory daemon restart");
  });

  it("a token that is neither the binding nor the file stays a plain mismatch", async () => {
    const res = await fetch(`${base}/namespaces`, {
      headers: { [PRINCIPAL_HEADER]: "tok-total-stranger" },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("principal token mismatch");
  });
});
