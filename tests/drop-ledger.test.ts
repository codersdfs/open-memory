import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { InMemoryVectorStore } from "../src/core/store/memory.js";
import { SqliteVectorStore } from "../src/core/store/sqlite.js";
import { MemoryService } from "../src/core/memoryService.js";
import { HashEmbeddingProvider } from "../src/core/embedding/hash.js";
import { buildServer } from "../src/api/server.js";
import { callTool } from "../src/mcp/tools.js";
import { CurationRejected, DROP_PREVIEW_CHARS, redactSecrets } from "../src/core/write/curation.js";
import type { VectorStore } from "../src/core/store/interface.js";
import type { MemoryService as Service } from "../src/core/memoryService.js";

/**
 * The drop ledger (ADR-0040 observability amendment), written against the feedback that
 * asked for it: "I'd test the filter with a note that seems useless until the next run
 * hits the same error. Can you see why a note was dropped, or does the filter just leave
 * no trace?" It did not. A rejected write threw BEFORE embed/insert, so it left no row,
 * no memory id, and therefore nothing in `memory_events` to query — the reason survived
 * only in the 422 / stderr of the single run that saw it. Each group below is one promise:
 * a drop leaves a trace; a LATER run reads that trace and folds repeats into a count; the
 * trace is masked so a `secret` drop cannot leak what the write was refused for; every
 * refusal path records; and the trace is queryable over HTTP and MCP, not only in-process.
 */

const dirs: string[] = [];
const opens: VectorStore[] = [];
const services: Service[] = [];

afterAll(async () => {
  for (const svc of services) { try { svc.close(); } catch { /* already closed */ } }
  for (const store of opens) { try { await store.close(); } catch { /* already closed */ } }
  for (const dir of dirs) {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* temp dir */ }
  }
});

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "om-drops-"));
  dirs.push(dir);
  return dir;
}

function track(store: VectorStore): VectorStore {
  opens.push(store);
  return store;
}

function mkService(store: VectorStore): Service {
  const svc = new MemoryService({ store, embedder: new HashEmbeddingProvider() });
  services.push(svc);
  return svc;
}

/**
 * One backend per entry, and each entry returns the TWO stores that stand for "this run"
 * and "the next run" over the same durable state: SQLite reopens the same file (a real
 * second process), the in-memory store is shared (the same ledger inside one process).
 * Both backends must answer identically, which is the whole reason the fold lives in the
 * store and not in a helper only one of them calls.
 */
const BACKENDS: { name: string; pair: () => [VectorStore, VectorStore] }[] = [
  { name: "memory", pair: () => { const s = track(new InMemoryVectorStore()); return [s, s]; } },
  { name: "sqlite", pair: () => { const p = join(tmpDir(), "store.db"); return [track(new SqliteVectorStore(p)), track(new SqliteVectorStore(p))]; } }
];

/**
 * A note that LOOKS useless — `conversational` is refused on both origins, and this is
 * the fixture that named the class (curation.test.ts). The filter is right to drop it,
 * which is exactly why a trace rather than a stored row is the correct response, and why
 * the second hit of the same error has to be recognisable without re-reading the first
 * run's output.
 */
const USELESS_UNTIL_IT_REPEATS = "I never said the deploy needs docker";

async function refuse(svc: Service, text = USELESS_UNTIL_IT_REPEATS, namespace = "claude:frank", source = "explicit") {
  let err: unknown;
  try {
    await svc.save({ namespace, type: "episodic", text, source });
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(CurationRejected);
  return err as CurationRejected;
}

describe("a dropped note leaves a trace", () => {
  for (const { name, pair } of BACKENDS) {
    it(`${name}: the refusal is recorded with its class, its advice and its partition`, async () => {
      const [store] = pair();
      const svc = mkService(store);
      await svc.init();
      const err = await refuse(svc);

      // Nothing was stored: a drop is a diagnostic, never a memory.
      const listed = await svc.list({ namespace: "claude:frank", limit: 20 });
      expect(listed.memories.some((m) => m.text === USELESS_UNTIL_IT_REPEATS)).toBe(false);

      const drops = await svc.curationDrops({ text: USELESS_UNTIL_IT_REPEATS });
      expect(drops).toHaveLength(1);
      expect(drops[0]!.junk).toBe(err.verdict.junk);
      expect(drops[0]!.advice).toBe(err.verdict.advice);
      expect(drops[0]!.preview).toContain("never said the deploy needs docker");
      expect(drops[0]!.namespace).toBe("claude:frank");
      expect(drops[0]!.origin).toBe("explicit");
      expect(drops[0]!.path).toBe("save");
      expect(drops[0]!.count).toBe(1);
      expect(drops[0]!.firstAt).toBe(drops[0]!.at);
    });

    it(`${name}: the next run hitting the same error reads the same ledger, folded into a count`, async () => {
      const [a, b] = pair();
      const first = mkService(a);
      await first.init();
      await refuse(first);
      // "The next run" is a different service over the same durable state — for sqlite
      // that is a second handle on the same file, so only bytes on disk carry the trace.
      const second = mkService(b);
      await second.init();
      await refuse(second);

      const drops = await second.curationDrops({ text: USELESS_UNTIL_IT_REPEATS });
      expect(drops).toHaveLength(1);
      expect(drops[0]!.count).toBe(2);
      expect(drops[0]!.firstAt).toBeLessThanOrEqual(drops[0]!.at);

      // And the question "what has this filter been eating?" finds it WITHOUT knowing the
      // exact text — that is what makes a note that seemed useless recoverable.
      const all = await second.curationDrops({ namespace: "claude:frank" });
      expect(all).toHaveLength(1);
      expect(all[0]!.count).toBe(2);
    });

    it(`${name}: a secret drop keeps no secret — the ledger describes the refusal, it does not archive it`, async () => {
      const [store] = pair();
      const svc = mkService(store);
      await svc.init();
      const key = "sk-proj-aaaaaaaaaaaaaaaaaaaaaaaa";
      const err = await refuse(svc, `the deploy key is ${key}`);
      expect(err.verdict.junk).toBe("secret");

      const drops = await svc.curationDrops({ junk: "secret" });
      expect(drops).toHaveLength(1);
      expect(drops[0]!.preview).not.toContain(key);
      expect(drops[0]!.preview).toContain("[redacted]");
      expect(drops[0]!.preview.length).toBeLessThanOrEqual(DROP_PREVIEW_CHARS);
      // The hash is the only trace of the text, and it is one-way.
      expect(drops[0]!.hash).not.toContain("sk-proj");
    });

    it(`${name}: bulk and extractor refusals are traced too`, async () => {
      const [store] = pair();
      const svc = mkService(store);
      await svc.init();

      // Bulk, non-reconcile: the reason was always in-band (a skipDetail), which is the
      // copy the caller throws away as soon as the command has printed it.
      const res = await svc.saveMany([
        { namespace: "claude:frank", type: "semantic", text: USELESS_UNTIL_IT_REPEATS },
        { namespace: "claude:frank", type: "semantic", text: "a clean fact lands fine" }
      ]);
      expect(res.skipped).toBe(1);
      let drops = await svc.curationDrops({ text: USELESS_UNTIL_IT_REPEATS });
      expect(drops).toHaveLength(1);
      expect(drops[0]!.path).toBe("bulk");
      // The row that passed left no trace.
      expect((await svc.curationDrops({})).length).toBe(1);

      // Bulk, reconcile: same note through the other door, so it folds into the SAME
      // ledger entry — a repeat is a repeat whichever path refused it.
      const rec = await svc.saveMany(
        [{ namespace: "claude:frank", type: "semantic", text: USELESS_UNTIL_IT_REPEATS }],
        { reconcile: true }
      );
      expect(rec.skipped).toBe(1);
      drops = await svc.curationDrops({ text: USELESS_UNTIL_IT_REPEATS });
      expect(drops[0]!.count).toBe(2);
      expect(drops[0]!.path).toBe("save");

      // The extractor's refusals: `extractAndSave` counted them and discarded the reason
      // entirely. `source: "extractor"` is the same path, so origin is what distinguishes
      // "nobody asked for this row" from "you saved it and it should not have been saved".
      await refuse(svc, "我没说过我在 pi-desktop。", "claude:frank", "extractor");
      const rows = await svc.curationDrops({ namespace: "claude:frank" });
      const extracted = rows.filter((d) => d.origin === "extracted");
      expect(extracted).toHaveLength(1);
      expect(extracted[0]!.junk).toBe("conversational");
    });

    it(`${name}: MEMORY_CURATE=off really lets the note through and traces nothing`, async () => {
      const [store] = pair();
      const prev = process.env.MEMORY_CURATE;
      process.env.MEMORY_CURATE = "off";
      try {
        const svc = mkService(store);
        await svc.init();
        const mem = await svc.save({ namespace: "claude:frank", type: "episodic", text: USELESS_UNTIL_IT_REPEATS, source: "explicit" });
        expect(mem.text).toBe(USELESS_UNTIL_IT_REPEATS);
        expect(await svc.curationDrops({})).toEqual([]);
      } finally {
        if (prev === undefined) delete process.env.MEMORY_CURATE; else process.env.MEMORY_CURATE = prev;
      }
    });
  }
});

describe("the trace is observable, not just written", () => {
  it("GET /drops answers a refusal made over POST /memories, after the 422 is gone", async () => {
    const svc = mkService(track(new InMemoryVectorStore()));
    await svc.init();
    const { app } = await buildServer({ service: svc });
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
    try {
      const rejected = await fetch(`${base}/memories`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ namespace: "test:drops", type: "episodic", text: USELESS_UNTIL_IT_REPEATS })
      });
      expect(rejected.status).toBe(422);
      const body = (await rejected.json()) as { curation: { junk: string } };
      expect(body.curation.junk).toBe("conversational");

      // A second client with no memory of that 422 asks the store the feedback's question.
      const seen = await fetch(`${base}/drops?namespace=test:drops&text=${encodeURIComponent(USELESS_UNTIL_IT_REPEATS)}`);
      expect(seen.status).toBe(200);
      const drops = ((await seen.json()) as { drops: { junk: string; count: number; advice: string; preview: string }[] }).drops;
      expect(drops).toHaveLength(1);
      expect(drops[0]!.count).toBe(1);
      expect(drops[0]!.advice).toBeTruthy();
      expect(drops[0]!.preview).toContain("docker");

      const badJunk = await fetch(`${base}/drops?junk=not-a-class`);
      expect(badJunk.status).toBe(400);
    } finally {
      await new Promise<void>((r) => app.close(() => r()));
    }
  });

  it("memory_drops answers a rejection memory_remember reported two calls ago", async () => {
    const ctx = { service: mkService(track(new InMemoryVectorStore())), defaultAgent: "claude" };
    await ctx.service.init();
    const refused: any = await callTool(ctx as any, "memory_remember", { text: USELESS_UNTIL_IT_REPEATS });
    expect(refused.text).toContain("not stored (conversational)");
    expect(refused.text).toContain("memory_drops");

    const read: any = await callTool(ctx as any, "memory_drops", {});
    expect(read.isError).toBeFalsy();
    expect(read.text).toContain("conversational");
    expect(read.structured.drops).toHaveLength(1);

    const scoped: any = await callTool(ctx as any, "memory_drops", { text: USELESS_UNTIL_IT_REPEATS });
    expect(scoped.structured.drops).toHaveLength(1);
    expect(scoped.structured.drops[0].count).toBe(1);
  });

  it("an untouched store says so instead of returning a bare empty list", async () => {
    const ctx = { service: mkService(track(new InMemoryVectorStore())), defaultAgent: "claude" };
    await ctx.service.init();
    const read: any = await callTool(ctx as any, "memory_drops", {});
    expect(read.text).toContain("drop ledger is empty");
  });

  it("redactSecrets masks every class the filter rejects on, and leaves clean text alone", () => {
    expect(redactSecrets("remote access password: hunter2Pass")).not.toContain("hunter2Pass");
    expect(redactSecrets("Authorization: Bearer abcdefghijklmnopqrstuvwxyz")).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(redactSecrets("use pnpm for the deploy")).toBe("use pnpm for the deploy");
  });
});
