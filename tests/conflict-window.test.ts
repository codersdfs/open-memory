/**
 * P5 (ADR-0047): the conflict window — the three-arm neighbour union, the
 * `conflict:<entity>` marker that replaces the silent double write when the judge is
 * absent, and the ADR-0041 amendment that makes a judge *failure* a different fact from
 * an *undecided* verdict and from an absent judge.
 *
 * Four things are pinned here, in the order the ask names them:
 *   1. The union's composition — what the three arms query, and that the facet arm can
 *      reach a row the same-type vector top-5 cannot.
 *   2. The marker goes through the P4-maintained path (`updateMeta`'s tags patch, insert
 *      on the new side), so the facet postings cannot drift from the tags — asserted
 *      against the real `memory_facets` table on the SQL store and the mirror on the
 *      InMemory one.
 *   3. `judge-failed` (asked, no answer: tag + stderr count, never a conflict marker)
 *      vs "judged but no label cleared" (untagged) vs absent (conflict marking eligible,
 *      including when no key is configured).
 *   4. The four no-delete guards outrank the marker: a guarded pair keeps its guard's
 *      reason and never takes a `conflict:*` facet.
 */
import { describe, it, expect, afterAll, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
import { MemoryService } from "../src/core/memoryService.js";
import { InMemoryVectorStore } from "../src/core/store/memory.js";
import { SqliteVectorStore } from "../src/core/store/sqlite.js";
import { HashEmbeddingProvider } from "../src/core/embedding/hash.js";
import type { EmbeddingProvider } from "../src/core/embedding/provider.js";
import { facetTagsOf, rederiveTags, appendTag, buildTags } from "../src/core/write/facets.js";
import { reconcile, unionNeighbours } from "../src/core/write/reconciler.js";
import { summarize } from "../src/core/stats.js";
import type { Memory } from "../src/core/types.js";

const saved = { ...process.env };
afterEach(() => { process.env = { ...saved }; });

const NS = "p5:1";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "om-p5-"));
  dirs.push(dir);
  return dir;
}

/**
 * A non-hash stub: the cosine gate exists only for real embedders, so with a constant
 * vector every candidate clears the gate and the window — not the floors — decides what
 * the decision sees. That is exactly what the composition tests need to observe.
 */
const stubEmbedder = {
  name: "nim", dim: 4,
  embed: async () => [1, 0, 0, 0],
  embedBatch: async (texts: string[]) => texts.map(() => [1, 0, 0, 0]),
} as unknown as EmbeddingProvider;

class SpyStore extends InMemoryVectorStore {
  readonly calls: { method: string; opts: Record<string, unknown> }[] = [];
  override async vectorSearch(opts: Parameters<InMemoryVectorStore["vectorSearch"]>[0]) {
    this.calls.push({ method: "vectorSearch", opts: { ...opts } });
    return super.vectorSearch(opts);
  }
  override async facetCandidates(opts: NonNullable<Parameters<InMemoryVectorStore["facetCandidates"]>[0]>) {
    this.calls.push({ method: "facetCandidates", opts: { ...opts } });
    return super.facetCandidates(opts);
  }
  /** The postings mirror, for the invariant assertion. */
  postingsOf(id: string): string[] {
    return ((this as unknown as { facetsByMemory: Map<string, string[]> }).facetsByMemory.get(id)) ?? [];
  }
}

const FILLERS = [
  "the blog deploy pipeline runs nightly",
  "the wiki export job runs hourly",
  "the cache warmer sweeps at dawn",
  "the ledger backup runs weekly",
  "the graph crawler visits monthly",
  "the queue drainer idles at noon",
];

// ---------------------------------------------------------------------------
// 1. The union's composition.
// ---------------------------------------------------------------------------

describe("the conflict window's three arms", () => {
  it("queries same-type top-5, then the entity facet arm, then the partition without the type wall", async () => {
    process.env.MEMORY_RECONCILE = "on";
    process.env.MEMORY_JEV = "false";
    const spy = new SpyStore();
    const svc = new MemoryService({ store: spy, embedder: stubEmbedder });
    await svc.init();
    for (const text of FILLERS) {
      await svc.save({ namespace: NS, project: "alpha", type: "semantic", text });
    }
    // Written LAST, so the constant vectors put it outside the same-type top-5: the
    // six fillers came first and a stable sort keeps insertion order on ties. The
    // texts clear the lexical floor on their own (nine shared tokens, one different
    // each — Jaccard 9/11, not a containment), because a facet-sourced row carries
    // vectorScore 0 and must still earn its way into the decision.
    const old = await svc.save({
      namespace: NS, project: "alpha", type: "semantic",
      text: "api gateway serves routes auth cache pool queue bus 8787", tags: ["entity:api"]
    });
    // The fillers' own saves each ran the window too; only the final write's calls
    // are under observation.
    spy.calls.length = 0;
    const next = await svc.saveDetailed({
      namespace: NS, project: "alpha", type: "semantic",
      text: "api gateway serves routes auth cache pool queue bus 9090", tags: ["entity:api"]
    });

    expect(next.decision.reason).toBe("conflict-unjudged");
    expect(next.decision.conflictFacet).toBe("conflict:api");

    const vectorCalls = spy.calls.filter((c) => c.method === "vectorSearch");
    const facetCalls = spy.calls.filter((c) => c.method === "facetCandidates");
    expect(vectorCalls).toHaveLength(2);
    // Arm 1 — the old same-type query, byte for byte.
    expect(vectorCalls[0]!.opts).toMatchObject({ namespace: NS, project: "alpha", type: "semantic", limit: 5 });
    // Arm 3 — the type wall down.
    expect(vectorCalls[1]!.opts).toMatchObject({ namespace: NS, project: "alpha", limit: 5 });
    expect(vectorCalls[1]!.opts.type).toBeUndefined();
    // Arm 2 — the P4 capability, scoped to the entity facets the incoming row carries.
    expect(facetCalls).toHaveLength(1);
    expect(facetCalls[0]!.opts).toMatchObject({
      namespace: NS, project: "alpha", facets: ["entity:api"], knowledge: null, limit: 5
    });
    expect(facetCalls[0]!.opts.type).toBeUndefined();

    // The conflicted row was NOT in arm 1's window — replaying the recorded query
    // returns the fillers, not it — so the marker below is the facet arm's doing.
    // (The replay runs after the write, so it also holds the new row; membership is
    // the claim, not exclusivity.)
    const arm1 = await spy.vectorSearch(vectorCalls[0]!.opts as never);
    expect(arm1.some((r) => r.memory.id === old.id)).toBe(false);
    const arm2 = await spy.facetCandidates(facetCalls[0]!.opts as never);
    expect(arm2.some((r) => r.memory.id === old.id)).toBe(true);
  });

  it("a facet hit with no lexical support never wins the decision — no free channel at the floor", async () => {
    process.env.MEMORY_RECONCILE = "on";
    process.env.MEMORY_JEV = "false";
    const spy = new SpyStore();
    const svc = new MemoryService({ store: spy, embedder: stubEmbedder });
    await svc.init();
    for (const text of FILLERS) {
      await svc.save({ namespace: NS, project: "alpha", type: "semantic", text });
    }
    // Same subject, different claim — but only four shared tokens out of six, well
    // under the lexical floor, and a facet-sourced row carries vectorScore 0. The
    // fillers clear the cosine gate instead, and the pair coexists unmarked: reaching
    // is not admitting, the rule ADR-0046 set for the retrieval arm and the decision
    // floor keeps here too. A marker without support would flood every shared-entity
    // store with pairs that are two facts, not two versions.
    await svc.save({
      namespace: NS, project: "alpha", type: "semantic",
      text: "the API listens on port 8787", tags: ["entity:api"]
    });
    const next = await svc.saveDetailed({
      namespace: NS, project: "alpha", type: "semantic",
      text: "the API listens on port 9090", tags: ["entity:api"]
    });
    expect(next.decision.reason).toBe("model-unavailable");
    expect(next.decision.conflictFacet).toBeUndefined();
    const rows = await spy.list({ namespace: NS });
    expect(rows.memories.every((m) => (m.tags ?? []).every((t) => !t.startsWith("conflict:")))).toBe(true);
  });

  it("caps the union at ten, trimming the weakest arm first", () => {
    const n = (id: string) => ({
      memory: {
        id, namespace: NS, project: null, kind: "note", knowledgeId: null, knowledgeSection: null,
        type: "semantic", text: "t " + id, embedding: [], importance: 0.5, strength: 0.5, lastUsedAt: null,
        useCount: 0, tags: [], supersedesId: null, isDeleted: 0, visibility: "private",
        status: "active", pin: 0, createdAt: 1, updatedAt: 1
      },
      vectorScore: 0.5
    });
    // Dedup in arm order: arm 2's copy of "b" never displaces arm 1's.
    expect(unionNeighbours([[n("a"), n("b")], [n("b"), n("c")], [n("c"), n("d")]], 10).map((x) => x.memory.id))
      .toEqual(["a", "b", "c", "d"]);
    // Arm priority is the cap's blade: the first five of arm 1, then arm 2, then arm 3
    // fills what is left — "k" is the one that falls off.
    const filled = unionNeighbours(
      [[n("a"), n("b"), n("c"), n("d"), n("e"), n("f")], [n("g"), n("h")], [n("i"), n("j"), n("k")]],
      10
    );
    expect(filled).toHaveLength(10);
    expect(filled.map((x) => x.memory.id)).toEqual(["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"]);
  });

  it("reaches an episodic contradiction through the type wall (and the guard still answers)", async () => {
    process.env.MEMORY_RECONCILE = "on";
    process.env.MEMORY_JEV = "false";
    const svc = new MemoryService({ store: new InMemoryVectorStore(), embedder: new HashEmbeddingProvider() });
    await svc.init();
    // Episodic row: invisible to the same-type arm of a semantic write. The hash
    // embedder cannot gate on cosine, so the window only helps when the words do.
    await svc.save({ namespace: NS, type: "episodic", text: "use pnpm not npm for work" });
    const next = await svc.saveDetailed({
      namespace: NS, type: "semantic", source: "extractor",
      text: "use pnpm not npm for work again"
    });
    // Before P5 this pair never met: same-type top-5 held only semantic rows and the
    // decision read "no-neighbour". Now it meets — and the extractor guard, unchanged,
    // is the reason it survives as a second row.
    expect(next.decision.reason).toBe("extractor-no-delete");
    expect(next.decision.conflictFacet).toBeUndefined();
    expect((await svc.list({ namespace: NS })).memories).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 2. The marker, through the P4 path: no drift.
// ---------------------------------------------------------------------------

describe("the conflict marker keeps the facet index honest", () => {
  it("InMemory: postings mirror == the row's facet tags, both sides of the pair", async () => {
    process.env.MEMORY_RECONCILE = "on";
    process.env.MEMORY_JEV = "false";
    const spy = new SpyStore();
    const svc = new MemoryService({ store: spy, embedder: stubEmbedder });
    await svc.init();
    const old = await svc.save({ namespace: NS, type: "semantic", text: "the API listens on port 8787", tags: ["entity:api"] });
    const next = await svc.saveDetailed({ namespace: NS, type: "semantic", text: "the API listens on port 9090", tags: ["entity:api"] });

    expect(next.decision.reason).toBe("conflict-unjudged");
    // The new row took the marker through its insert; the old one through the
    // updateMeta tags patch. The invariant reads the same on both.
    expect(next.memory.tags).toContain("conflict:api");
    const oldRow = (await svc.get(old.id))!;
    expect(oldRow.tags).toContain("conflict:api");
    expect(spy.postingsOf(old.id).slice().sort()).toEqual(facetTagsOf(oldRow.tags).map((t) => t.toLowerCase()).sort());
    expect(spy.postingsOf(next.memory.id).slice().sort()).toEqual(facetTagsOf(next.memory.tags).map((t) => t.toLowerCase()).sort());

    // The marker is joinable exactly like any other facet: the facet read and the
    // facet-filtered list both see the pair.
    const marked = await spy.facetCandidates({ namespace: NS, facets: ["conflict:api"], limit: 10 });
    expect(marked.map((r) => r.memory.id).sort()).toEqual([old.id, next.memory.id].sort());
    const page = await spy.list({ namespace: NS, facet: "conflict:api" });
    expect(page.total).toBe(2);
  });

  it("sqlite: the tags patch rewrites the postings in the same transaction, and a reopen heals nothing because nothing drifted", async () => {
    process.env.MEMORY_RECONCILE = "on";
    process.env.MEMORY_JEV = "false";
    const file = join(tmpDir(), "store.db");
    const store = new SqliteVectorStore(file);
    await store.init();
    try {
      const svc = new MemoryService({ store, embedder: new HashEmbeddingProvider() });
      await svc.init();
      // The hash embedder cannot gate on cosine, so this pair must clear the lexical
      // floor on its own: nine shared tokens, one different each — Jaccard 9/11, not a
      // containment, not a restatement.
      const old = await svc.save({
        namespace: NS, type: "semantic",
        text: "api gateway serves routes auth cache pool queue bus 8787",
        tags: ["entity:api"]
      });
      const next = await svc.saveDetailed({
        namespace: NS, type: "semantic",
        text: "api gateway serves routes auth cache pool queue bus 9090",
        tags: ["entity:api"]
      });
      expect(next.decision.reason).toBe("conflict-unjudged");

      const db = raw(file);
      try {
        const postings = async (id: string): Promise<string[]> =>
          (db.prepare(`SELECT facet FROM memory_facets WHERE memory_id = ?`).all(id) as { facet: string }[]).map((r) => r.facet);
        const oldRow = (await svc.get(old.id))!;
        expect(oldRow.tags).toContain("conflict:api");
        expect((await postings(old.id)).sort()).toEqual(facetTagsOf(oldRow.tags).map((t) => t.toLowerCase()).sort());
        expect((await postings(next.memory.id)).sort()).toEqual(facetTagsOf(next.memory.tags).map((t) => t.toLowerCase()).sort());
        // Both rows are reachable by their marker through the new facet slice.
        expect((await store.list({ namespace: NS, facet: "conflict:api" })).total).toBe(2);
      } finally {
        db.close();
      }

      // Reopen: the self-heal's anti-join runs again — and finds nothing to repair,
      // because the tags patch and the postings moved together.
      store.close();
      const reopened = new SqliteVectorStore(file);
      await reopened.init();
      try {
        const db2 = raw(file);
        try {
          const postings = async (id: string): Promise<string[]> =>
            (db2.prepare(`SELECT facet FROM memory_facets WHERE memory_id = ?`).all(id) as { facet: string }[]).map((r) => r.facet);
          const oldRow = (await reopened.getById(old.id))!;
          expect((await postings(old.id)).sort()).toEqual(facetTagsOf(oldRow.tags).map((t) => t.toLowerCase()).sort());
        } finally {
          db2.close();
        }
      } finally {
        reopened.close();
      }
    } finally {
      // The first store was closed above only on the success path; guard the double close.
      try { store.close(); } catch { /* already closed */ }
    }
  });

  it("a reembed keeps the marker: it describes a relationship, not the text", () => {
    expect(rederiveTags(["conflict:api", "entity:ada"], "the `ada` endpoint moved to src/core"))
      .toContain("conflict:api");
    // The relabel dedups case-insensitively — a second marker for the same entity
    // changes nothing, and the list it already had is returned untouched.
    expect(appendTag(["CONFLICT:API"], "conflict:api")).toEqual(["CONFLICT:API"]);
    expect(appendTag(undefined, "conflict:api")).toEqual(["conflict:api"]);
    expect(appendTag(["entity:api", "topic:sqlite"], "conflict:api")).toEqual(["entity:api", "topic:sqlite", "conflict:api"]);
  });

  it("the marker survives a reembed even on a FULL row — the cap spends reproducible tags, never the one that cannot be re-derived", () => {
    // The shape that used to lose it: four caller plain tags + three derived facets is
    // 7 tags, the marker appended eighth — the old ordering put the marker in the plain
    // group AFTER the re-derived facets, so `slice(MAX_TAGS)` ate the pending
    // adjudication and silently resolved the pair. The markers now go first, and the
    // cap costs a plain tag instead.
    const full = buildTags(
      "the `APIGateway` routes traffic for @alpha and `RateLimiter` per policy",
      ["team:infra", "owner:frank", "sprint:42", "audit:q4"]
    );
    expect(full).toHaveLength(7);
    const marked = appendTag(full, "conflict:apigateway");
    expect(marked).toHaveLength(8); // a full row: MAX_TAGS is exactly this
    const after = rederiveTags(marked, "the `APIGateway` serves @beta routes for `RateLimiter` and `RetryPolicy` per plan");
    expect(after).toHaveLength(8);
    expect(after).toContain("conflict:apigateway");
    // What the cap spent is a tag the caller can re-derive or re-apply — not the marker.
    expect(after[0]).toBe("conflict:apigateway");
    expect(after).not.toContain("audit:q4");
  });

  it("the store's reembed path keeps the marker on a full row (InMemory mirror of updateEmbedding)", async () => {
    const full = buildTags(
      "the `APIGateway` routes traffic for @alpha and `RateLimiter` per policy",
      ["team:infra", "owner:frank", "sprint:42", "audit:q4"]
    );
    const marked = appendTag(full, "conflict:apigateway");
    const store = new InMemoryVectorStore();
    const row = await store.insert({ namespace: NS, type: "semantic", text: "the `APIGateway` routes traffic for @alpha", tags: marked }, [0.1]);
    await store.updateEmbedding(row.id, [0.2], "the `APIGateway` serves @beta routes for `RateLimiter`");
    const after = (await store.getById(row.id))!;
    expect(after.tags).toContain("conflict:apigateway");
    // The postings follow the surviving tags — the invariant holds on the fixed path too.
    expect((store as unknown as { facetsByMemory: Map<string, string[]> }).facetsByMemory.get(row.id)!.slice().sort())
      .toEqual(facetTagsOf(after.tags).map((t) => t.toLowerCase()).sort());
  });
});

// ---------------------------------------------------------------------------
// 3. Judge absent vs judge failed vs judged-but-undecided.
// ---------------------------------------------------------------------------

describe("the three unjudged outcomes stay distinguishable", () => {
  function captureStderr(): { lines: string[]; restore: () => void } {
    const lines: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown): boolean => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    return { lines, restore: () => { process.stderr.write = orig; } };
  }

  it("an absent judge with a shared entity marks the conflict — including when no key is configured", async () => {
    // MEMORY_JEV left enabled (its default) and no key anywhere (tests/setup.ts gives
    // this file an empty memory home): the judge is absent, not failed.
    process.env.MEMORY_RECONCILE = "on";
    process.env.MEMORY_WRITE_GATE = "false";
    delete process.env.MEMORY_JEV;
    delete process.env.JEV_API_KEY;
    delete process.env.TYPESAFE_API_KEY;
    const svc = new MemoryService({ store: new InMemoryVectorStore(), embedder: stubEmbedder });
    await svc.init();
    const old = await svc.save({ namespace: NS, type: "semantic", text: "the API listens on port 8787", tags: ["entity:api"] });
    const next = await svc.saveDetailed({ namespace: NS, type: "semantic", text: "the API listens on port 9090", tags: ["entity:api"] });
    expect(next.decision.reason).toBe("conflict-unjudged");
    expect(next.decision.conflictFacet).toBe("conflict:api");
    expect((await svc.get(old.id))!.tags).toContain("conflict:api");
    expect(next.memory.tags).toContain("conflict:api");
    expect(next.memory.tags.every((t) => t !== "judged:failed")).toBe(true);
  });

  it("a judge that was asked and failed tags the row and counts on stderr — no conflict marker", async () => {
    process.env.MEMORY_RECONCILE = "on";
    process.env.MEMORY_JEV = "true";
    process.env.MEMORY_WRITE_GATE = "false";
    process.env.JEV_API_KEY = "test-key-not-real";
    const svc = new MemoryService({ store: new InMemoryVectorStore(), embedder: stubEmbedder });
    await svc.init();
    await svc.save({ namespace: NS, type: "semantic", text: "the API listens on port 8787", tags: ["entity:api"] });
    const { lines, restore } = captureStderr();
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("{}", { status: 500 })) as typeof fetch;
    try {
      const next = await svc.saveDetailed({ namespace: NS, type: "semantic", text: "the API listens on port 9090", tags: ["entity:api"] });
      expect(next.decision.reason).toBe("judge-failed");
      expect(next.memory.tags).toContain("judged:failed");
      expect(next.memory.tags.every((t) => !t.startsWith("conflict:"))).toBe(true);
    } finally {
      globalThis.fetch = origFetch;
      restore();
    }
    const failure = lines.filter((l) => l.includes("[reconcile] relation judge failed"));
    expect(failure).toHaveLength(1);
    // The count is the running total for the process, and the message names why the
    // wire had nothing to say.
    expect(failure[0]).toMatch(/\(\d+ this process\): relation judge returned no answer/);
  });

  it("a judge that answered but cleared no label stores untagged — neither failure nor conflict", async () => {
    process.env.MEMORY_RECONCILE = "on";
    process.env.MEMORY_JEV = "true";
    process.env.MEMORY_WRITE_GATE = "false";
    process.env.JEV_API_KEY = "test-key-not-real";
    const svc = new MemoryService({ store: new InMemoryVectorStore(), embedder: stubEmbedder });
    await svc.init();
    await svc.save({ namespace: NS, type: "semantic", text: "the API listens on port 8787", tags: ["entity:api"] });
    // A real wire answer whose top label leads by less than the margin: judged, low
    // confidence, no verdict.
    const origFetch = globalThis.fetch;
    const { lines, restore } = captureStderr();
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          model: "jev-test",
          answers: {
            duplicate: { type: "noul", noul: 0.5 },
            refines: { type: "noul", noul: 0.45 },
            contradicts: { type: "noul", noul: 0.4 }
          }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )) as typeof fetch;
    try {
      const next = await svc.saveDetailed({ namespace: NS, type: "semantic", text: "the API listens on port 9090", tags: ["entity:api"] });
      expect(next.decision.reason).toBe("model-unrelated");
      expect(next.memory.tags.every((t) => !t.startsWith("conflict:") && t !== "judged:failed")).toBe(true);
    } finally {
      globalThis.fetch = origFetch;
      restore();
    }
    expect(lines.filter((l) => l.includes("[reconcile] relation judge failed"))).toHaveLength(0);
  });

  it("an absent judge with no shared entity stays model-unavailable and unmarked", async () => {
    process.env.MEMORY_RECONCILE = "on";
    process.env.MEMORY_JEV = "false";
    const svc = new MemoryService({ store: new InMemoryVectorStore(), embedder: stubEmbedder });
    await svc.init();
    // All-lowercase texts: `deriveFacets` returns nothing, so no entity is ever named
    // and the pair has no subject to carry a marker.
    const old = await svc.save({ namespace: NS, type: "semantic", text: "deploy api v2 to staging tonight" });
    const next = await svc.saveDetailed({ namespace: NS, type: "semantic", text: "deploy api v3 to staging tonight" });
    expect(next.decision.reason).toBe("model-unavailable");
    expect(next.decision.conflictFacet).toBeUndefined();
    expect((await svc.get(old.id))!.tags.every((t) => !t.startsWith("conflict:"))).toBe(true);
    expect(next.memory.tags.every((t) => !t.startsWith("conflict:"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. The four no-delete guards outrank the marker.
// ---------------------------------------------------------------------------

describe("the guards never yield to the conflict marker", () => {
  const base = { type: "semantic" as const, embedderKind: "nim", source: "mcp:pi" };
  const neighbour = (over: Partial<Memory> = {}): { memory: Memory; vectorScore: number } => ({
    memory: {
      id: "old-1", namespace: "pi:u", project: null, kind: "note",
      knowledgeId: null, knowledgeSection: null,
      type: "semantic", text: "the API listens on port 8787",
      embedding: [], importance: 0.8, strength: 0.8, lastUsedAt: null, useCount: 0,
      source: "mcp:pi", tags: ["entity:api"], supersedesId: null, isDeleted: 0,
      visibility: "private", status: "active", pin: 0, createdAt: 1, updatedAt: 1, ...over
    },
    vectorScore: 0.9
  });
  const pair = { text: "the API now listens on port 9090", callerTags: ["entity:api"] };

  it("episodic-no-delete", async () => {
    const d = await reconcile({ ...base, type: "episodic", ...pair, neighbours: [neighbour({ type: "episodic" })] });
    expect(d).toMatchObject({ action: "insert", reason: "episodic-no-delete" });
    expect(d.conflictFacet).toBeUndefined();
    expect(d.tags.every((t) => !t.startsWith("conflict:"))).toBe(true);
  });

  it("extractor-no-delete", async () => {
    const d = await reconcile({ ...base, source: "extractor", ...pair, neighbours: [neighbour()] });
    expect(d).toMatchObject({ action: "insert", reason: "extractor-no-delete" });
    expect(d.conflictFacet).toBeUndefined();
    expect(d.tags.every((t) => !t.startsWith("conflict:"))).toBe(true);
  });

  it("pinned-no-delete", async () => {
    const d = await reconcile({ ...base, ...pair, neighbours: [neighbour({ pin: 1 })] });
    expect(d).toMatchObject({ action: "insert", reason: "pinned-no-delete" });
    expect(d.conflictFacet).toBeUndefined();
    expect(d.tags.every((t) => !t.startsWith("conflict:"))).toBe(true);
  });

  it("typed-no-delete, on either side of the pair", async () => {
    const working = await reconcile({ ...base, type: "working", ...pair, neighbours: [neighbour({ type: "working" })] });
    expect(working).toMatchObject({ action: "insert", reason: "typed-no-delete" });
    expect(working.conflictFacet).toBeUndefined();
    const untyped = await reconcile({
      ...base, type: undefined as unknown as typeof base.type, ...pair, neighbours: [neighbour()]
    });
    expect(untyped).toMatchObject({ action: "insert", reason: "typed-no-delete" });
    expect(untyped.conflictFacet).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 5. MemoryFilter.facet, both stores, same contract.
// ---------------------------------------------------------------------------

describe("MemoryFilter.facet (both stores)", () => {
  function rows(): { name: string; make: () => Promise<InMemoryVectorStore | SqliteVectorStore> }[] {
    return [
      { name: "memory", make: async () => new InMemoryVectorStore() },
      {
        name: "sqlite",
        make: async () => {
          const s = new SqliteVectorStore(join(tmpDir(), "filter.db"));
          await s.init();
          return s;
        }
      }
    ];
  }

  for (const { name, make } of rows()) {
    it(`${name}: list, vectorSearch and lexicalCandidates slice by facet`, async () => {
      const store = await make();
      try {
        const foo = await store.insert({ namespace: NS, type: "semantic", text: "alpha kestrel writes reports", tags: ["entity:foo"] }, [0.1, 0]);
        const bar = await store.insert({ namespace: NS, type: "semantic", text: "beta kestrel writes logs", tags: ["entity:bar"] }, [0.2, 0]);
        const marked = await store.insert({ namespace: NS, type: "semantic", text: "gamma kestrel writes memos", tags: ["conflict:foo"] }, [0.3, 0]);
        const byFacet = (page: { memories: Memory[] }) => page.memories.map((m) => m.id).sort();

        expect(byFacet(await store.list({ namespace: NS, facet: "entity:foo" }))).toEqual([foo.id]);
        // Postings are lowercased; the filter follows them, so the value is matched
        // case-insensitively — the same convention `facetCandidates` reads by.
        expect(byFacet(await store.list({ namespace: NS, facet: "ENTITY:FOO" }))).toEqual([foo.id]);
        expect(byFacet(await store.list({ namespace: NS, facet: "conflict:foo" }))).toEqual([marked.id]);
        expect((await store.list({ namespace: NS, facet: "entity:none" })).total).toBe(0);
        // Without the slice, nothing changes.
        expect((await store.list({ namespace: NS })).total).toBe(3);

        const vs = await store.vectorSearch({ namespace: NS, queryEmbedding: [0.2, 0], limit: 10, facet: "entity:bar" });
        expect(vs.map((r) => r.memory.id)).toEqual([bar.id]);
        const lex = await store.lexicalCandidates!({ namespace: NS, query: "kestrel", limit: 10, facet: "conflict:foo" });
        // All three rows hold the query token, so the facet slice is what narrowed it.
        expect(lex.length).toBeGreaterThan(0);
        expect(lex.map((r) => r.memory.id)).toEqual([marked.id]);
      } finally {
        store.close();
      }
    });
  }
});

// ---------------------------------------------------------------------------
// 6. The stats counter.
// ---------------------------------------------------------------------------

describe("stats.pendingConflicts", () => {
  const row = (over: Partial<Memory>): Memory => ({
    id: over.id ?? Math.random().toString(36).slice(2),
    namespace: "test:1", project: null, kind: "note",
    knowledgeId: null, knowledgeSection: null,
    type: "semantic", text: "the API listens on port 8787",
    embedding: [], importance: 0.5, strength: 0.5, lastUsedAt: null, useCount: 0,
    tags: [], supersedesId: null, isDeleted: 0, visibility: "private", status: "active",
    pin: 0, createdAt: 0, updatedAt: 0, ...over
  });

  it("counts readable-live marked rows only, and hands the rows to the panel", () => {
    const s = summarize([
      row({ tags: ["entity:api", "conflict:api"] }),
      row({ tags: ["conflict:api"], isDeleted: 1 }),          // tombstone: the pair is gone
      row({ tags: ["conflict:sqlite"], status: "archived" }), // out of every read the panel sees
      row({ tags: ["entity:pnpm"] }),                          // never marked
      row({ tags: ["Conflict:Auth"] }),                       // prefix matching is case-insensitive
    ], 1_000);
    expect(s.pendingConflicts).toBe(2);
    expect(s.pendingConflictRows.map((r) => r.conflicts[0]).sort()).toEqual(["conflict:api", "conflict:auth"]);
    expect(s.pendingConflictRows.every((r) => r.text.length > 0)).toBe(true);
  });
});

/** The raw file, opened beside the store the way `tests/facets-index.test.ts` reads it. */
function raw(file: string): DatabaseSync {
  return new DatabaseSync(file);
}
