import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { InMemoryVectorStore } from "../src/core/store/memory.js";
import { MemoryService } from "../src/core/memoryService.js";
import { archiveStale } from "../src/core/lifecycle/decay.js";
import { HashEmbeddingProvider } from "../src/core/embedding/hash.js";
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

/**
 * ADR-0042: management rides the dimension. A project exists because rows carry it,
 * so every operation here must be explainable as a statement over `memories.project`
 * — and the one row management is allowed to create (the init marker) must cost the
 * brief nothing.
 */
describe("project management", () => {
  it("init writes one durable marker into the shared layer, and is idempotent", async () => {
    const first = await svc.initProject({ project: "alpha", user: "frank" });
    expect(first.created).toBe(true);
    expect(first.memory!.namespace).toBe(SHARED);
    expect(first.memory!.kind).toBe("decision");
    expect(first.memory!.tags).toContain("project:init");
    const again = await svc.initProject({ project: "alpha", user: "frank" });
    expect(again.created).toBe(false);
    expect((await svc.list({ namespace: SHARED, project: "alpha", limit: 10 })).total).toBe(1);
  });

  it("files the note as the marker's decision instead of the generic sentence", async () => {
    const out = await svc.initProject({ project: "beta", note: "We decided to track beta work in this store", user: "frank" });
    expect(out.created).toBe(true);
    expect(out.memory!.text).toContain("beta work");
  });

  it("keeps the marker out of the brief — visibility is not a brief line", async () => {
    await svc.initProject({ project: "memory", user: "frank" });
    const brief = await svc.brief({ namespaces: [NS, SHARED], project: "memory", now: NOW });
    expect(brief.text).not.toContain("initialized");
  });

  it("lists every project with counts, kinds and last activity; unscoped included", async () => {
    await seed({ text: "Always squash before merging in alpha", project: "alpha", kind: "convention" });
    await seed({ text: "We chose pnpm for alpha because scripts compose", project: "alpha", kind: "decision" });
    await seed({ text: "a preference about the user, not a repository", project: null });
    // Archived rows are audit, not a live population: the count says what a read can hand out.
    const archived = await seed({ text: "an alpha row decay archived", project: "alpha" });
    await svc.updateMeta(archived.id, { status: "archived" });

    const projects = await svc.listProjects();
    const alpha = projects.find((p) => p.project === "alpha")!;
    expect(alpha.rows).toBe(2);
    expect(alpha.byKind).toEqual({ convention: 1, decision: 1 });
    expect(alpha.lastActivityAt).toBeGreaterThan(0);
    const unscoped = projects.find((p) => p.project === null)!;
    expect(unscoped.rows).toBe(1);
  });

  it("rename moves every row, tombstones included, and guards an occupied target", async () => {
    await seed({ text: "alpha convention row", project: "alpha", kind: "convention" });
    const tombstoned = await seed({ text: "alpha decision row", project: "alpha", kind: "decision" });
    await svc.delete(tombstoned.id);
    await seed({ text: "beta row that stays", project: "beta" });

    // A rename onto an occupied slug folds two efforts' history: legal, never a typo's side effect.
    await expect(svc.renameProject("alpha", "beta")).rejects.toThrow(/merge/);
    const out = await svc.renameProject("alpha", "beta", { merge: true });
    expect(out.renamed).toBe(2);

    const beta = (await svc.listProjects()).find((p) => p.project === "beta")!;
    expect(beta.rows).toBe(2);
    // The audit trail belongs to the project it documented, so it moves too.
    expect((await svc.get(tombstoned.id))!.project).toBe("beta");
    await expect(svc.renameProject("nope", "gamma")).rejects.toThrow(/unknown project/);
  });

  it("forget soft-deletes by default and restore revives row by row", async () => {
    const row = await seed({ text: "an alpha row worth keeping", project: "alpha" });
    const out = await svc.forgetProject("alpha");
    expect(out.deleted).toBe(1);
    expect((await svc.list({ namespace: NS, project: "alpha", limit: 10 })).total).toBe(0);
    await svc.updateMeta(row.id, { isDeleted: 0 });
    expect((await svc.list({ namespace: NS, project: "alpha", limit: 10 })).total).toBe(1);
  });

  it("detach unscopes instead of deleting", async () => {
    await seed({ text: "a row that outlives its project", project: "alpha" });
    const out = await svc.forgetProject("alpha", { mode: "detach" });
    expect(out.detached).toBe(1);
    const unscoped = await svc.list({ namespace: NS, project: null, limit: 10 });
    expect(unscoped.total).toBe(1);
    expect((await svc.listProjects()).find((p) => p.project === "alpha")).toBeUndefined();
  });

  it("rejects slugs that do not normalize", async () => {
    await expect(svc.initProject({ project: "***", user: "frank" })).rejects.toThrow(/no project/);
    await expect(svc.forgetProject("***")).rejects.toThrow(/does not normalize/);
  });

  it("answers listProjects from a sweep when the store predates the capability", async () => {
    await seed({ text: "a row in a legacy store", project: "legacy" });
    const bare = new Proxy(store, {
      get(target, prop, recv) {
        if (prop === "listProjects") return undefined;
        return Reflect.get(target, prop, recv);
      }
    });
    const legacy = new MemoryService({ store: bare, embedder: new HashEmbeddingProvider() });
    const projects = await legacy.listProjects();
    expect(projects.map((p) => p.project)).toContain("legacy");
  });
});
