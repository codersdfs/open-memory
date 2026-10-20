import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { InMemoryVectorStore } from "../src/core/store/memory.js";
import { MemoryService } from "../src/core/memoryService.js";
import { archiveStale } from "../src/core/lifecycle/decay.js";
import { projectSlug, normalizeProject, resolveProject, resetProjectCache } from "../src/core/project.js";
import { deriveKind, isDurableKind, KIND_RETENTION_MS, KIND_IMPORTANCE } from "../src/core/write/kind.js";
import type { MemoryKind, MemoryType } from "../src/core/types.js";

/**
 * Direction B: a project's memory, not just a ranked list of rows (ADR-0020/0021/0022).
 *
 * The three questions these tests answer, in order:
 *   1. does a memory know which project it belongs to, and which *kind* of thing it is;
 *   2. can two projects share one partition without contaminating each other's reads;
 *   3. does a session that starts with no query get the durable rows, in a stable order,
 *      inside its budget — and nothing that has expired.
 */

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 19, 12, 0, 0);
const NS = "claude:frank";
const SHARED = "shared:frank";

let store: InMemoryVectorStore;
let svc: MemoryService;

beforeEach(() => {
  store = new InMemoryVectorStore();
  svc = new MemoryService({ store });
});

interface Seed {
  text: string;
  project?: string | null;
  kind?: MemoryKind;
  type?: MemoryType;
  namespace?: string;
  importance?: number;
  ageDays?: number;
}

async function seed(row: Seed) {
  const saved = await svc.save({
    text: row.text,
    namespace: row.namespace ?? NS,
    project: row.project === undefined ? "memory" : row.project,
    kind: row.kind,
    type: row.type ?? "semantic",
    importance: row.importance
  });
  if (row.ageDays) {
    // Age is set on the row directly: `save` cannot backdate, and sleeping in a test is
    // a worse seam than moving the row's own clock. `map` is the in-memory store's own
    // row table, reached through a cast on purpose — production code never does this.
    const rows = (store as unknown as { map: Map<string, { createdAt: number }> }).map;
    rows.get(saved.id)!.createdAt = NOW - row.ageDays * DAY;
  }
  return saved;
}

describe("project resolution", () => {
  afterEach(() => resetProjectCache());

  it("slugs a human name into a stable key", () => {
    expect(projectSlug("My Project!")).toBe("my-project");
    expect(projectSlug("C:\\memory")).toBe("c-memory");
    expect(projectSlug("  open_memory.v2  ")).toBe("open_memory.v2");
    expect(projectSlug("***")).toBeNull();
    expect(normalizeProject(undefined)).toBeNull();
    expect(normalizeProject(42)).toBeNull();
  });

  it("prefers explicit, then env, then the git root", () => {
    resetProjectCache();
    expect(resolveProject("other", { cwd: "C:\\memory", env: {} }).project).toBe("other");
    expect(resolveProject(null, { cwd: "C:\\memory", env: { MEMORY_PROJECT: "From Env" } })).toMatchObject({
      project: "from-env",
      source: "env"
    });
    const fromGit = resolveProject(undefined, { cwd: process.cwd(), env: {} });
    expect(fromGit.source).toBe("git");
    expect(fromGit.project).toBe(projectSlug(fromGit.root!.split(/[\\/]/).pop()!));
  });
});

describe("kind classification", () => {
  it("reads decisions, conventions, gotchas and tasks out of both languages", () => {
    expect(deriveKind("We chose float32 blobs over JSON because it parses once")).toBe("decision");
    expect(deriveKind("决定用 term_df 维护倒排的文档频率")).toBe("decision");
    expect(deriveKind("Always run npm run lint before committing")).toBe("convention");
    expect(deriveKind("一律不要在 store 里直接 JSON.parse")).toBe("convention");
    expect(deriveKind("The Windows sandbox bites when rmSync runs right after close")).toBe("gotcha");
    expect(deriveKind("Windows 下 close 后立刻 rmSync 会 EPERM")).toBe("gotcha");
    expect(deriveKind("TODO: wire the console to the new decay report")).toBe("task");
    expect(deriveKind("下一步把 brief 接进 MCP")).toBe("task");
    expect(deriveKind("| 层 | 位置 | 状态 |")).toBe("note");
  });

  it("lets the caller override the wording, and prices the kind", () => {
    expect(deriveKind("some plain sentence", { explicit: "decision" })).toBe("decision");
    expect(deriveKind("ignored", { explicit: "nonsense" })).not.toBe("nonsense");
    expect(isDurableKind("decision")).toBe(true);
    expect(isDurableKind("task")).toBe(false);
    expect(KIND_RETENTION_MS.task).toBe(7 * DAY);
    expect(KIND_RETENTION_MS.fact).toBe(90 * DAY);
  });

  it("gives an explicitly-kinded memory the importance that kind deserves", async () => {
    const decision = await seed({ text: "We are using one SQLite file per store", kind: "decision" });
    expect(decision.kind).toBe("decision");
    expect(decision.importance).toBe(KIND_IMPORTANCE.decision);
    const plain = await seed({ text: "random musing about the weather" });
    expect(plain.kind).toBe("note");
    expect(plain.importance).toBe(0.5);
  });
});

describe("project isolation", () => {
  it("keeps two projects in one partition apart on read, together on write", async () => {
    await seed({ text: "Always run the migration probe before shipping", project: "alpha" });
    await seed({ text: "Always run the migration probe before shipping", project: "beta" });
    await seed({ text: "the alpha store keeps vectors in a blob", project: "alpha" });

    const alpha = await svc.list({ namespace: NS, project: "alpha", limit: 10 });
    expect(alpha.total).toBe(2);
    const beta = await svc.list({ namespace: NS, project: "beta", limit: 10 });
    expect(beta.total).toBe(1);

    const search = await svc.search({ query: "migration probe", namespaces: [NS], project: "beta", k: 5, threshold: 0 });
    expect(search.memories.length).toBe(1);
    expect(search.memories[0]!.project).toBe("beta");
  });

  it("filters the brief by project too — that is the point of the dimension", async () => {
    await seed({ text: "Always squash before merging in alpha", project: "alpha" });
    await seed({ text: "Always squash before merging in beta", project: "beta" });
    const alpha = await svc.brief({ namespaces: [NS], project: "alpha", now: NOW });
    expect(alpha.text).toContain("alpha");
    expect(alpha.text).not.toContain("beta");
    expect(alpha.project).toBe("alpha");
  });
});

describe("brief assembly", () => {
  it("orders sections conventions → decisions → gotchas → open → recent", async () => {
    await seed({ text: "Always run npm run lint before committing", project: "memory" });
    await seed({ text: "We chose float32 blobs over JSON text because parsing was the cost", project: "memory" });
    await seed({ text: "The Windows sandbox bites when rmSync runs right after close", project: "memory" });
    await seed({ text: "TODO: wire the console to the decay report", project: "memory" });
    await seed({ text: "today we moved the vector column into its own table", project: "memory", type: "episodic" });

    const brief = await svc.brief({ namespaces: [NS], project: "memory", now: NOW });
    const order = ["[convention]", "[decision", "[gotcha]", "[open", "[note]"].map((raw) => brief.text.indexOf(raw));
    for (const index of order) expect(index).toBeGreaterThanOrEqual(0);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(brief.text).toContain("float32 blobs");
    expect(brief.sections.find((s) => s.name === "conventions")!.items.length).toBe(1);
    expect(brief.counts.recent).toBeGreaterThanOrEqual(1);
  });

  it("is byte-identical across runs, so it can be diffed", async () => {
    await seed({ text: "Always use pnpm", project: "memory" });
    await seed({ text: "We decided to keep the console zero-dependency", project: "memory" });
    const a = await svc.brief({ namespaces: [NS], project: "memory", now: NOW });
    const b = await svc.brief({ namespaces: [NS], project: "memory", now: NOW });
    expect(a.text).toBe(b.text);
    expect(a.tokensUsed).toBe(b.tokensUsed);
  });

  it("never exceeds its budget, and says when it dropped rows", async () => {
    for (let i = 0; i < 40; i++) {
      await seed({ text: `Always prefer convention number ${i} over the other one in this repository`, project: "memory" });
    }
    const brief = await svc.brief({ namespaces: [NS], project: "memory", budgetTokens: 200, now: NOW });
    expect(brief.tokensUsed).toBeLessThanOrEqual(200);
    expect(brief.truncated).toBe(true);
    expect(brief.sections.find((s) => s.name === "conventions")!.items.length).toBeLessThan(40);
  });

  it("keeps a superseded decision out and shows the replacement", async () => {
    const old = await seed({ text: "We decided to store vectors as JSON text", project: "memory", kind: "decision" });
    const replacement = await svc.supersede(old.id, {
      namespace: NS,
      project: "memory",
      kind: "decision",
      type: "semantic",
      text: "We decided to store vectors as float32 blobs"
    });
    const brief = await svc.brief({ namespaces: [NS], project: "memory", now: NOW });
    expect(brief.text).toContain(replacement.text.slice(0, 40));
    expect(brief.text).not.toContain("JSON text");
  });

  it("reaches another agent's rows through the shared layer", async () => {
    await seed({ text: "Always run the store migration with the daemon stopped", namespace: SHARED, project: "memory" });
    const brief = await svc.brief({ namespaces: [NS, SHARED], project: "memory", now: NOW });
    expect(brief.text).toContain("migration with the daemon stopped");
    expect(brief.scopes).toEqual([NS, SHARED]);
  });

  it("leaves expired tasks out of `open` and says nothing about unscoped rows", async () => {
    await seed({ text: "TODO: rotate the NIM key", project: "memory", ageDays: 20 });
    await seed({ text: "Always keep the key in auth.json", project: "memory" });
    const brief = await svc.brief({ namespaces: [NS], project: "memory", now: NOW });
    expect(brief.text).not.toContain("rotate the NIM key");
    const unscoped = await svc.brief({ namespaces: [NS], project: null, now: NOW });
    expect(unscoped.text).not.toContain("auth.json");
  });
});

describe("kind-aware decay", () => {
  it("never archives a durable kind, however old and unused", async () => {
    await seed({ text: "We decided the brief is deterministic on purpose", project: "memory", kind: "decision", ageDays: 400, importance: 0.4 });
    await seed({ text: "Always fail open in a hook", project: "memory", kind: "convention", ageDays: 400, importance: 0.4 });
    const archived = await archiveStale(store, { now: NOW });
    expect(archived).toBe(0);
  });

  it("archives a stale task at its own window, not the global one", async () => {
    await seed({ text: "TODO: rotate the NIM key", project: "memory", kind: "task", ageDays: 10, importance: 0.4 });
    await seed({ text: "TODO: tomorrow's job", project: "memory", kind: "task", ageDays: 2, importance: 0.4 });
    const archived = await archiveStale(store, { now: NOW });
    expect(archived).toBe(1);
    const listed = await svc.list({ namespace: NS, status: "archived", limit: 10 });
    expect(listed.memories[0]!.text).toContain("rotate the NIM key");
  });
});
