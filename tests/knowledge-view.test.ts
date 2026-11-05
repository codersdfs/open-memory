/**
 * ADR-0030: the knowledge read path used to list whole partitions and throw most of
 * the rows away. These tests pin the shape of the answer — what counts as a page,
 * which rows are excluded, how edges are grouped — so the filtering rewrite cannot
 * quietly change the page tree while it gets faster.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HashEmbeddingProvider } from "../src/core/embedding/hash.js";
import { knowledgeIndex, knowledgePages, neighborsOf } from "../src/core/knowledge/view.js";
import { SqliteVectorStore } from "../src/core/store/sqlite.js";
import type { MemoryInput } from "../src/core/types.js";

let dir: string;
let store: SqliteVectorStore;
const embedder = new HashEmbeddingProvider();

const NS = "shared:frank";

function save(input: Partial<MemoryInput> & { text: string }): Promise<unknown> {
  const text = input.text;
  const full: MemoryInput = {
    namespace: NS,
    type: "semantic",
    ...input,
    text
  } as MemoryInput;
  return embedder.embed(text).then((vec) => store.insert(full, vec));
}

async function open(): Promise<SqliteVectorStore> {
  const s = new SqliteVectorStore(path.join(dir, "memory.db"));
  await s.init();
  return s;
}

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "om-kview-"));
  store = await open();
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("knowledgePages", () => {
  it("builds a page per knowledge id and ignores ordinary memories", async () => {
    for (let i = 0; i < 50; i++) await save({ text: `ordinary chat memory number ${i}` });
    await save({ text: "[alpha] Setup: install the thing.", knowledgeId: "alpha", knowledgeSection: "s1" });
    await save({ text: "[alpha] Gotchas: it fails on windows.", knowledgeId: "alpha", knowledgeSection: "s2" });
    await save({ text: "[beta] Setup: a different page.", knowledgeId: "beta", knowledgeSection: "s1" });

    const pages = await knowledgePages(store, { namespaces: [NS] });

    expect(pages.map((p) => p.id)).toEqual(["alpha", "beta"]);
    expect(pages[0]!.sections.map((s) => s.key)).toEqual(["s1", "s2"]);
    expect(pages[0]!.project).toBeNull();
    // The 50 ordinary rows are not sections of anything.
    expect(pages.reduce((n, p) => n + p.sections.length, 0)).toBe(3);
  });

  it("drops deleted, archived and draft rows like list does", async () => {
    await save({ text: "[alpha] Kept: yes.", knowledgeId: "alpha", knowledgeSection: "a" });
    await save({ text: "[alpha] Deleted: gone.", knowledgeId: "alpha", knowledgeSection: "b" });
    await save({ text: "[alpha] Archived: gone.", knowledgeId: "alpha", knowledgeSection: "c" });
    await save({ text: "[alpha] Draft: gone.", knowledgeId: "alpha", knowledgeSection: "d" });

    const rows = await store.list({ namespace: NS, withVectors: false });
    const doomed = rows.memories.filter((m) => m.knowledgeSection !== "a");
    // Ordered by created_at DESC, so section "d" is first, then c, b.
    await store.updateMeta(doomed[0]!.id, { status: "draft" });
    await store.updateMeta(doomed[1]!.id, { status: "archived" });
    await store.deleteSoft(doomed[2]!.id);

    const pages = await knowledgePages(store, { namespaces: [NS] });

    expect(pages).toHaveLength(1);
    expect(pages[0]!.sections.map((s) => s.key)).toEqual(["a"]);
  });

  it("groups links, backlinks and dangling edges without a per-page scan", async () => {
    for (const id of ["alpha", "beta", "gone"]) {
      await save({ text: `[${id}] Setup: page ${id}.`, knowledgeId: id, knowledgeSection: "s1" });
    }
    await store.knowledge.replaceLinks("alpha", [
      { from: "alpha", to: "beta", target: "Beta" },
      { from: "alpha", to: null, target: "Missing page" }
    ]);
    await store.knowledge.replaceLinks("beta", [{ from: "beta", to: "alpha", target: "Alpha" }]);

    const pages = await knowledgePages(store, { namespaces: [NS] });
    const alpha = pages.find((p) => p.id === "alpha")!;
    const beta = pages.find((p) => p.id === "beta")!;

    expect(alpha.links).toHaveLength(2);
    expect(alpha.dangling.map((e) => e.target)).toEqual(["Missing page"]);
    expect(alpha.backlinks.map((e) => e.from)).toEqual(["beta"]);
    expect(beta.backlinks.map((e) => e.from)).toEqual(["alpha"]);
    // A page nobody links to has an empty list, not undefined.
    expect(pages.find((p) => p.id === "gone")!.backlinks).toEqual([]);
  });

  it("only reads the requested namespaces", async () => {
    await save({ text: "[alpha] Setup: mine.", knowledgeId: "alpha", knowledgeSection: "s1" });
    const other = await open();
    try {
      await other.insert(
        { namespace: "claude:someone-else", type: "semantic", text: "[beta] Setup: theirs.", knowledgeId: "beta" } as MemoryInput,
        await embedder.embed("[beta] Setup: theirs.")
      );
    } finally {
      other.close();
    }

    const pages = await knowledgePages(store, { namespaces: [NS] });

    expect(pages.map((p) => p.id)).toEqual(["alpha"]);
    // The row exists in the file, in a partition nobody asked for.
    expect((await store.list({ namespace: "claude:someone-else" })).total).toBe(1);
  });

  it("falls back to list for a store without a page-tree query", async () => {
    await save({ text: "[alpha] Setup: install it.", knowledgeId: "alpha", knowledgeSection: "s1" });
    await save({ text: "ordinary memory", knowledgeId: null });

    // A store from before the page-tree query: `list` is all it has.
    const legacy = Object.create(store) as SqliteVectorStore;
    Object.defineProperty(legacy, "knowledge", {
      value: { ...store.knowledge, listKnowledge: undefined }
    });
    const links = store.knowledge.links.bind(store.knowledge);
    Object.defineProperty(legacy.knowledge, "links", { value: links });

    const viaFallback = await knowledgePages(legacy, { namespaces: [NS] });
    const direct = await knowledgePages(store, { namespaces: [NS] });

    expect(viaFallback).toEqual(direct);
    expect(viaFallback.map((p) => p.id)).toEqual(["alpha"]);
  });
});

describe("knowledgeIndex", () => {
  it("counts pages, edges and dangling links", async () => {
    for (const id of ["alpha", "beta"]) {
      await save({ text: `[${id}] Setup: page ${id}.`, knowledgeId: id, knowledgeSection: "s1" });
    }
    await store.knowledge.replaceLinks("alpha", [
      { from: "alpha", to: "beta", target: "Beta" },
      { from: "alpha", to: null, target: "Nowhere" }
    ]);

    const index = await knowledgeIndex(store, { namespaces: [NS] });

    expect(index.pages.map((p) => p.id)).toEqual(["alpha", "beta"]);
    expect(index.pages[0]!.sections).toBe(1);
    expect(index.pages[0]!.links).toBe(2);
    expect(index.pages[1]!.backlinks).toBe(1);
    expect(index.edges).toBe(1);
    expect(index.dangling.map((e) => e.target)).toEqual(["Nowhere"]);
  });
});

describe("neighborsOf", () => {
  it("walks one hop and de-duplicates both directions", () => {
    const edges = [
      { from: "a", to: "b", target: "B" },
      { from: "b", to: "a", target: "A" },
      { from: "a", to: "c", target: "C" }
    ];

    expect(neighborsOf(edges, "a").sort()).toEqual(["b", "c"]);
    expect(neighborsOf(edges, "d")).toEqual([]);
  });
});
