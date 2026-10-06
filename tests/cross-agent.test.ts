import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MemoryService } from "../src/core/memoryService.js";
import { InMemoryVectorStore } from "../src/core/store/memory.js";
import { LEGACY_NAMESPACE, resetScopeCache } from "../src/core/scope.js";

/**
 * Cross-agent recall (ADR-0007).
 *
 * The point of the shared layer: a fact learned by one agent is recallable by
 * another, without either agent being able to read the other's private notes.
 */

const USER = "itest";
const CLEAN = ["claude", "codex", "dsh", "pi"].map((a) => `${a}:${USER}`);

let svc: MemoryService;

beforeEach(async () => {
  process.env.AI_MEMORY_USER = USER;
  svc = new MemoryService({ store: new InMemoryVectorStore(), dedupThreshold: 0.99 });
  await svc.init();
  for (const ns of CLEAN) {
    for (const m of (await svc.store.list({ namespace: ns, limit: 1000 })).memories) {
      await svc.store.deleteSoft(m.id);
    }
  }
});

afterEach(() => {
  delete process.env.AI_MEMORY_USER;
});

describe("shared layer", () => {
  it("a shared fact is recallable by every agent", async () => {
    await svc.save({
      agent: "claude",
      scope: "shared",
      type: "semantic",
      text: "The staging deploy key rotates every 90 days and lives in 1Password.",
      importance: 0.9
    });

    for (const agent of ["claude", "codex", "dsh", "pi"]) {
      const r = await svc.search({
        query: "staging deploy key rotation",
        agent,
        threshold: 0.2,
        budgetTokens: 500
      });
      expect(r.memories.length, `${agent} should recall the shared fact`).toBeGreaterThan(0);
      expect(r.memories[0]!.text).toContain("staging deploy key");
      expect(r.memories[0]!.namespace).toBe(`shared:${USER}`);
      expect(r.scopes).toEqual([`${agent}:${USER}`, `shared:${USER}`, LEGACY_NAMESPACE]);
    }
  });

  it("a private fact stays with its own agent", async () => {
    await svc.save({
      agent: "claude",
      type: "semantic",
      text: "Frank prefers tabs over spaces in this private note.",
      importance: 0.9
    });

    const mine = await svc.search({ query: "tabs over spaces private note", agent: "claude", threshold: 0.2 });
    expect(mine.memories.length).toBeGreaterThan(0);

    for (const other of ["codex", "dsh", "pi"]) {
      const r = await svc.search({ query: "tabs over spaces private note", agent: other, threshold: 0.2 });
      expect(r.memories.length, `${other} must not see claude's private note`).toBe(0);
    }
  });

  it("different users never share even the shared layer", async () => {
    await svc.save({
      agent: "claude",
      scope: "shared",
      type: "semantic",
      text: "User A only: the VPN gateway is at vpn-a.internal.",
      importance: 0.9
    });
    process.env.AI_MEMORY_USER = "someoneelse";
    const r = await svc.search({ query: "VPN gateway internal", agent: "codex", threshold: 0.2 });
    expect(r.memories.length).toBe(0);
  });
});

describe("merge behaviour", () => {
  it("merges both layers into one budgeted result, own layer first on ties", async () => {
    await svc.save({
      agent: "claude",
      type: "semantic",
      text: "Release train: cargo release runs on Tuesdays.",
      importance: 0.5
    });
    await svc.save({
      agent: "codex",
      scope: "shared",
      type: "semantic",
      text: "Shared release train: cargo release runs on Tuesdays.",
      importance: 0.5
    });

    const r = await svc.search({ query: "release train cargo release Tuesdays", agent: "claude", threshold: 0.2 });
    const namespaces = r.memories.map((m) => m.namespace);
    expect(namespaces).toContain(`claude:${USER}`);
    expect(namespaces).toContain(`shared:${USER}`);
    // One budget, not one per layer.
    expect(r.tokensUsed).toBeLessThanOrEqual(r.memories.reduce((s, m) => s + m.tokens, 0));
  });

  it("an explicit namespace still searches exactly one partition", async () => {
    await svc.save({
      agent: "claude",
      scope: "shared",
      type: "semantic",
      text: "Only in shared: the build cache is warm.",
      importance: 0.5
    });
    const r = await svc.search({
      query: "build cache warm",
      namespace: `shared:${USER}`,
      threshold: 0.2
    });
    expect(r.memories.length).toBeGreaterThan(0);
    expect(r.scopes).toEqual([`shared:${USER}`]);

    const other = await svc.search({ query: "build cache warm", namespace: `codex:${USER}`, threshold: 0.2 });
    expect(other.memories.length).toBe(0);
  });

  it("deduplicates an id reachable from a repeated partition", async () => {
    await svc.save({
      agent: "claude",
      type: "semantic",
      text: "Repeated partition guard: the sentinel is orange.",
      importance: 0.5
    });
    const r = await svc.search({
      query: "sentinel is orange",
      namespaces: [`claude:${USER}`, `claude:${USER}`],
      threshold: 0.2
    });
    const ids = r.memories.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  // The bug this guards: every memory written before ADR-0007 lives in
  // `default:default`, and an agent marker in the environment made a bare CLI call
  // resolve to `pi:<user>` alone — so `ai-memory search "..."` printed "no
  // memories matched" while all 46 rows sat in the legacy partition.
  it("an agent-scoped search still finds memories written before layering existed", async () => {
    await svc.save({
      namespace: LEGACY_NAMESPACE,
      type: "semantic",
      text: "user is a TypeScript engineer who hates boilerplate",
      importance: 0.7
    });
    const r = await svc.search({ query: "TypeScript engineer", agent: "pi", threshold: 0.2 });
    expect(r.memories.map((m) => m.text)).toContain("user is a TypeScript engineer who hates boilerplate");
    expect(r.scopes).toContain(LEGACY_NAMESPACE);
  });

  it("a bare search asks for one legacy partition, not a two-layer fan-out", async () => {
    // No partition and no agent → the pre-ADR-0007 default bucket, so a caller
    // that never learned about scopes still gets exactly its old behaviour.
    delete process.env.AI_MEMORY_USER;
    resetScopeCache();
    // `agent: "default"` is the explicit form of "I have no agent identity":
    // detection would otherwise pick up whatever harness is running the tests.
    const r = await svc.search({ query: "anything at all", agent: "default", threshold: 0.2 });
    // Two partitions, but both are legacy: no private/shared fan-out happened.
    expect(r.scopes).toHaveLength(2);
    expect(r.scopes![0]).toMatch(/^default:/);

    const legacy = await svc.search({ query: "anything at all", namespace: "default:default", threshold: 0.2 });
    expect(legacy.scopes).toEqual(["default:default"]);
  });
});
