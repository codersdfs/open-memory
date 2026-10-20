import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { buildServer } from "../src/api/server.js";
import { MemoryService } from "../src/core/memoryService.js";
import { InMemoryVectorStore } from "../src/core/store/memory.js";
import { HashEmbeddingProvider } from "../src/core/embedding/hash.js";
import { splitKnowledgeSections, renderSectionText, sectionKey, titleOfSectionText } from "../src/core/knowledge/sections.js";
import { neighborsOf } from "../src/core/knowledge/view.js";
import { archiveStale } from "../src/core/lifecycle/decay.js";
import type { KnowledgeEdge } from "../src/core/types.js";

/**
 * The knowledge dimension (ADR-0023): the markdown file is the truth, the row is its index.
 *
 * These tests pin the three promises that make that sentence safe:
 *   1. a sync is idempotent — re-reading unchanged files embeds nothing and rewrites nothing;
 *   2. a section's identity is its heading, not its position — editing one section updates
 *      one row, and deleting one removes one row (not a re-flow of all the others);
 *   3. links live beside the rows, never inside retrieval — a search shows them, an explicit
 *      `neighbors` call walks them, and nothing expands implicitly.
 */

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 19, 12, 0, 0);
const NS = "knowledge-test:user";
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

let dir: string;
let store: InMemoryVectorStore;
let svc: MemoryService;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ai-memory-knowledge-"));
  store = new InMemoryVectorStore();
  svc = new MemoryService({ store, embedder: new HashEmbeddingProvider() });
});

afterEach(() => {
  // Windows keeps the vault files open for a moment after the spawn-based CLI test;
  // the retries are what make this teardown deterministic there.
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  } catch {
    // best effort: a leftover temp dir is not a failing assertion
  }
});

const PROSE = {
  alpha: "Tokens are counted as cjk characters plus one quarter of the latin characters, so a Chinese sentence costs roughly twice what its length suggests.",
  alphaSecond: "The budget is enforced greedily: a memory that would overflow the remaining space is skipped, and the next cheaper one still gets in.",
  beta: "Brief assembly spends its budget in a fixed order: conventions, decisions, gotchas, open tasks, then recent notes, and an unused share rolls forward.",
  gamma: "Neighbours are walked only when asked for, so a search result never drags five more pages into the context window by itself."
};

function writePage(name: string, body: string, frontmatter = ""): void {
  const file = join(dir, `${name}.md`);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, `${frontmatter}${body}`, "utf8");
}

function alphaPage(extraLink = ""): string {
  return `## How tokens work

${PROSE.alpha}

## How the budget behaves

${PROSE.alphaSecond}

See [[beta]] for the brief. ${extraLink}`;
}

describe("section splitting", () => {
  it("keys a section by its heading, not its position", () => {
    expect(sectionKey("How tokens work", 0)).toBe("how-tokens-work");
    // punctuation-only and empty headings fall back to position, never to ""
    expect(sectionKey("###", 2)).toBe("section-3");
    expect(sectionKey("", 0)).toBe("section-1");
    // CJK keeps its letters instead of collapsing to a dash run
    expect(sectionKey("如何工作", 0)).toBe("如何工作");
  });

  it("titles rows so a later sync can find their page again", () => {
    const text = renderSectionText("Alpha page", "How tokens work", PROSE.alpha);
    expect(text.startsWith("[Alpha page] How tokens work: ")).toBe(true);
    expect(titleOfSectionText(text)).toBe("Alpha page");
    // the heading is the part between the title and the first colon
    expect(text.slice(text.indexOf("]") + 1).trimStart().split(": ")[0]).toBe("How tokens work");
  });

  it("ignores hashes inside code fences and drops prose too short to be knowledge", () => {
    const body = [
      "## Real heading",
      PROSE.beta,
      "```",
      "## not a heading",
      "```",
      "## Stub",
      "too short"
    ].join("\n\n");
    const sections = splitKnowledgeSections(body);
    expect(sections.map((s) => s.key)).toEqual(["real-heading"]);
  });

  it("disambiguates repeated headings and caps the page", () => {
    const repeated = ["## Notes", PROSE.alpha, "## Notes", PROSE.beta].join("\n\n");
    expect(splitKnowledgeSections(repeated).map((s) => s.key)).toEqual(["notes", "notes-2"]);
    const many = Array.from({ length: 20 }, (_, i) => `## Heading ${i}\n\n${PROSE.gamma}`).join("\n\n");
    expect(splitKnowledgeSections(many).length).toBe(12);
    expect(splitKnowledgeSections(many, { maxSections: 3 }).length).toBe(3);
  });
});

describe("sync: file is the truth", () => {
  it("indexes each section as one searchable row", async () => {
    writePage("alpha", alphaPage(), "---\ntitle: Alpha page\nslug: alpha\n---\n");
    const report = await svc.syncKnowledge({ dir, namespace: NS });

    expect(report.pages).toBe(1);
    expect(report.sections).toBe(2);
    expect(report.inserted).toBe(2);
    expect(report.embedCalls).toBe(1);

    const index = await svc.knowledge({ namespaces: [NS] });
    expect(index.pages.map((p) => p.id)).toEqual(["alpha"]);
    expect(index.pages[0]!.sections).toBe(2);

    const found = await svc.search({ query: "tokens counted cjk characters", namespaces: [NS], threshold: 0 });
    expect(found.memories.some((m) => m.knowledgeId === "alpha")).toBe(true);
  });

  it("a second sync of unchanged files writes and embeds nothing", async () => {
    writePage("alpha", alphaPage(), "---\ntitle: Alpha page\nslug: alpha\n---\n");
    await svc.syncKnowledge({ dir, namespace: NS });
    const before = await store.list({ namespace: NS, limit: 100 });
    const ids = before.memories.map((m) => m.id).sort();

    const again = await svc.syncKnowledge({ dir, namespace: NS });
    expect(again.inserted).toBe(0);
    expect(again.updated).toBe(0);
    expect(again.unchanged).toBe(2);
    expect(again.embedCalls).toBe(0);
    expect((await store.list({ namespace: NS, limit: 100 })).memories.map((m) => m.id).sort()).toEqual(ids);
  });

  it("editing one section updates one row and keeps its id", async () => {
    writePage("alpha", alphaPage(), "---\ntitle: Alpha page\nslug: alpha\n---\n");
    await svc.syncKnowledge({ dir, namespace: NS });
    const before = (await store.list({ namespace: NS, limit: 100 })).memories;
    const first = before.find((m) => m.knowledgeSection === "how-tokens-work")!;

    writePage("alpha", alphaPage().replace(PROSE.alpha, `${PROSE.alpha} It is a heuristic, not a tokenizer.`), "---\ntitle: Alpha page\nslug: alpha\n---\n");
    const report = await svc.syncKnowledge({ dir, namespace: NS });

    expect(report.updated).toBe(1);
    expect(report.inserted).toBe(0);
    expect(report.unchanged).toBe(1);
    const after = (await store.list({ namespace: NS, limit: 100 })).memories;
    const updated = after.find((m) => m.knowledgeSection === "how-tokens-work")!;
    expect(updated.id).toBe(first.id);
    expect(updated.text).toContain("heuristic, not a tokenizer");
  });

  it("deleting a section removes exactly that row", async () => {
    writePage("alpha", alphaPage(), "---\ntitle: Alpha page\nslug: alpha\n---\n");
    await svc.syncKnowledge({ dir, namespace: NS });

    writePage("alpha", `## How tokens work\n\n${PROSE.alpha}\n`, "---\ntitle: Alpha page\nslug: alpha\n---\n");
    const report = await svc.syncKnowledge({ dir, namespace: NS });

    expect(report.removed).toBe(1);
    const listed = await store.list({ namespace: NS, limit: 100, includeDeleted: true });
    const deleted = listed.memories.filter((m) => m.isDeleted === 1);
    expect(deleted).toHaveLength(1);
    expect(deleted[0]!.knowledgeSection).toBe("how-the-budget-behaves");
  });

  it("deleting a page soft-deletes its rows and clears its edges", async () => {
    writePage("alpha", alphaPage("Also see [[gamma]].\n"), "---\ntitle: Alpha page\nslug: alpha\n---\n");
    writePage("beta", `## Brief order\n\n${PROSE.beta}\n`, "---\ntitle: Beta page\nslug: beta\n---\n");
    writePage("gamma", `## Neighbours\n\n${PROSE.gamma}\n`, "---\ntitle: Gamma page\nslug: gamma\n---\n");
    await svc.syncKnowledge({ dir, namespace: NS });
    expect((await store.knowledge!.links()).length).toBeGreaterThanOrEqual(2);

    rmSync(join(dir, "alpha.md"));
    const report = await svc.syncKnowledge({ dir, namespace: NS });

    expect(report.pagesRemoved).toBe(1);
    expect(report.removed).toBe(2);
    const index = await svc.knowledge({ namespaces: [NS] });
    expect(index.pages.map((p) => p.id).sort()).toEqual(["beta", "gamma"]);
    const orphans = (await store.knowledge!.links()).filter((e) => e.from === "alpha");
    expect(orphans).toEqual([]);
  });

  it("reports the links a file declares, including the ones that go nowhere", async () => {
    writePage(
      "alpha",
      `## How tokens work\n\n${PROSE.alpha}\n\nSee [[beta]], [[beta|the brief page]], [[beta#Brief order]] and [[ghost]].\n`,
      "---\ntitle: Alpha page\nslug: alpha\nlinks: [gamma]\n---\n"
    );
    writePage("beta", `## Brief order\n\n${PROSE.beta}\n`, "---\ntitle: Beta page\nslug: beta\n---\n");
    writePage("gamma", `## Neighbours\n\n${PROSE.gamma}\n`, "---\ntitle: Gamma page\nslug: gamma\n---\n");

    const report = await svc.syncKnowledge({ dir, namespace: NS });
    // Body links normalise to two targets (three spellings of `beta` collapse into one
    // edge; `ghost` does not resolve) and the frontmatter adds `gamma`.
    expect(report.dangling).toBe(1);
    expect(report.edges).toBe(3);

    const alpha = await svc.knowledgePage({ namespaces: [NS], id: "alpha" });
    expect(alpha!.links.filter((e) => e.to === "beta")).toHaveLength(1);
    expect(alpha!.links.some((e) => e.to === "gamma")).toBe(true);
    expect(alpha!.dangling.map((e) => e.target)).toEqual(["ghost"]);

    const beta = await svc.knowledgePage({ namespaces: [NS], id: "beta" });
    expect(beta!.backlinks.length).toBeGreaterThanOrEqual(1);

    writePage("gamma", `## Neighbours\n\n${PROSE.gamma}\n\nBack: [[alpha]].\n`, "---\ntitle: Gamma page\nslug: gamma\n---\n");
    await svc.syncKnowledge({ dir, namespace: NS });
    const gamma = await svc.knowledgePage({ namespaces: [NS], id: "gamma" });
    expect(gamma!.backlinks.map((e) => e.from)).toContain("alpha");
  });

  it("dryRun reports the work without doing it", async () => {
    writePage("alpha", alphaPage(), "---\ntitle: Alpha page\nslug: alpha\n---\n");
    const report = await svc.syncKnowledge({ dir, namespace: NS, dryRun: true });
    expect(report.inserted).toBe(2);
    expect(report.embedCalls).toBe(0);
    expect((await store.list({ namespace: NS, limit: 100 })).memories).toHaveLength(0);
  });
});

describe("neighbours", () => {
  const edges = (pairs: [string, string][]): KnowledgeEdge[] =>
    pairs.map(([from, to]) => ({ from, to, target: to }));

  it("walks one hop by default, honours depth, and survives cycles", () => {
    const graph = edges([
      ["a", "b"],
      ["b", "c"],
      ["c", "a"]
    ]);
    expect(neighborsOf(graph, "a", 1).sort()).toEqual(["b", "c"]);
    expect(neighborsOf(graph, "a", 2).sort()).toEqual(["b", "c"]);
    expect(neighborsOf(edges([["a", "b"], ["b", "c"]]), "a", 2).sort()).toEqual(["b", "c"]);
    expect(neighborsOf(graph, "a", 9).sort()).toEqual(["b", "c"]);
    expect(neighborsOf(graph, "missing", 1)).toEqual([]);
  });

  it("answers over the index: neighbours of a page are its linked pages", async () => {
    writePage("alpha", `## How tokens work\n\n${PROSE.alpha}\n\nSee [[beta]].\n`, "---\ntitle: Alpha page\nslug: alpha\n---\n");
    writePage("beta", `## Brief order\n\n${PROSE.beta}\n\nSee [[gamma]].\n`, "---\ntitle: Beta page\nslug: beta\n---\n");
    writePage("gamma", `## Neighbours\n\n${PROSE.gamma}\n`, "---\ntitle: Gamma page\nslug: gamma\n---\n");
    await svc.syncKnowledge({ dir, namespace: NS });

    const one = await svc.knowledgeNeighbors({ namespaces: [NS], id: "alpha", depth: 1 });
    expect(one.neighbors.map((p) => p.id)).toEqual(["beta"]);
    const two = await svc.knowledgeNeighbors({ namespaces: [NS], id: "alpha", depth: 2 });
    expect(two.neighbors.map((p) => p.id).sort()).toEqual(["beta", "gamma"]);
  });
});

describe("knowledge rows are rows, with boundaries", () => {
  it("a search can be restricted to knowledge, or to everything but it", async () => {
    writePage("alpha", alphaPage(), "---\ntitle: Alpha page\nslug: alpha\n---\n");
    await svc.syncKnowledge({ dir, namespace: NS });
    await svc.save({ namespace: NS, type: "semantic", text: "chat note: tokens are counted somewhere in the codebase" });

    const onlyKnowledge = await svc.search({ query: "tokens counted", namespaces: [NS], knowledge: "alpha", threshold: 0 });
    expect(onlyKnowledge.memories.length).toBeGreaterThan(0);
    expect(onlyKnowledge.memories.every((m) => m.knowledgeId === "alpha")).toBe(true);

    const chatOnly = await svc.search({ query: "tokens counted", namespaces: [NS], knowledge: null, threshold: 0 });
    expect(chatOnly.memories.length).toBe(1);
    expect(chatOnly.memories[0]!.knowledgeId).toBeNull();
  });

  it("reconcile never folds a chat sentence into a knowledge row", async () => {
    writePage("alpha", alphaPage(), "---\ntitle: Alpha page\nslug: alpha\n---\n");
    await svc.syncKnowledge({ dir, namespace: NS });
    const knowledgeRows = () => store.list({ namespace: NS, limit: 100 }).then((r) => r.memories.filter((m) => m.knowledgeId !== null));

    const before = await knowledgeRows();
    const alphaText = renderSectionText("Alpha page", "How tokens work", PROSE.alpha);
    await svc.save({ namespace: NS, type: "semantic", text: alphaText });

    const after = await knowledgeRows();
    expect(after.map((m) => m.id).sort()).toEqual(before.map((m) => m.id).sort());
    expect(after.every((m) => m.isDeleted === 0)).toBe(true);
    const ordinary = (await store.list({ namespace: NS, limit: 100 })).memories.filter((m) => m.knowledgeId === null);
    expect(ordinary).toHaveLength(1);
  });

  it("decay does not archive a knowledge row, however old it is", async () => {
    writePage("alpha", alphaPage(), "---\ntitle: Alpha page\nslug: alpha\n---\n");
    await svc.syncKnowledge({ dir, namespace: NS });
    const rows = (store as unknown as { map: Map<string, { createdAt: number; importance: number }> }).map;
    const knowledgeRow = [...rows.values()].find((r) => (r as unknown as { knowledgeId: string | null }).knowledgeId !== null)!;
    knowledgeRow.createdAt = NOW - 400 * DAY;
    knowledgeRow.importance = 0.1;

    const ordinary = await svc.save({ namespace: NS, type: "semantic", text: "an ordinary note that aged out for comparison" });
    rows.get(ordinary.id)!.createdAt = NOW - 400 * DAY;
    rows.get(ordinary.id)!.importance = 0.1;

    const archived = await archiveStale(store, { now: NOW });
    expect(archived).toBe(1);
    // `list` hides archived rows, so the control row is read back by id.
    expect((await store.getById(ordinary.id))!.status).toBe("archived");
    const stillLive = (await store.list({ namespace: NS, limit: 100 })).memories.filter((m) => m.knowledgeId !== null);
    expect(stillLive.every((m) => m.status === "active")).toBe(true);
  });

  it("adopts the rows the old wiki ingest wrote, instead of duplicating them", async () => {
    writePage("alpha", alphaPage(), "---\ntitle: Alpha page\nslug: alpha\n---\n");
    const legacy = await store.insert(
      {
        namespace: NS,
        type: "semantic",
        text: renderSectionText("Alpha page", "How tokens work", PROSE.alpha),
        importance: 0.5,
        source: "wiki:alpha.md",
        tags: ["scope:wiki", "wiki:alpha", "section:1"]
      },
      await svc.embedder.embed(renderSectionText("Alpha page", "How tokens work", PROSE.alpha), { inputType: "passage" })
    );

    const report = await svc.syncKnowledge({ dir, namespace: NS });

    expect(report.adopted).toBe(1);
    expect(report.inserted).toBe(1); // only the second section is new
    const rows = (await store.list({ namespace: NS, limit: 100 })).memories;
    const adopted = rows.find((m) => m.id === legacy.id)!;
    expect(adopted.knowledgeId).toBe("alpha");
    expect(adopted.knowledgeSection).toBe("how-tokens-work");
  });
});

describe("surfaces", () => {
  it("serves the index, one page, its neighbours and a sync over HTTP", async () => {
    writePage("alpha", `## How tokens work\n\n${PROSE.alpha}\n\nSee [[beta]].\n`, "---\ntitle: Alpha page\nslug: alpha\n---\n");
    writePage("beta", `## Brief order\n\n${PROSE.beta}\n`, "---\ntitle: Beta page\nslug: beta\n---\n");
    await svc.syncKnowledge({ dir, namespace: NS });

    const { app } = await buildServer({ service: svc });
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
    try {
      const index = (await (await fetch(`${base}/knowledge?namespace=${encodeURIComponent(NS)}`)).json()) as { pages: { id: string }[] };
      expect(index.pages.map((p) => p.id).sort()).toEqual(["alpha", "beta"]);

      const page = (await (await fetch(`${base}/knowledge/alpha?namespace=${encodeURIComponent(NS)}`)).json()) as { id: string; sections: unknown[] };
      expect(page.id).toBe("alpha");
      expect(page.sections).toHaveLength(1);

      const neighbours = (await (await fetch(`${base}/knowledge/alpha/neighbors?namespace=${encodeURIComponent(NS)}`)).json()) as { neighbors: { id: string }[] };
      expect(neighbours.neighbors.map((p) => p.id)).toEqual(["beta"]);

      const missing = await fetch(`${base}/knowledge/ghost?namespace=${encodeURIComponent(NS)}`);
      expect(missing.status).toBe(404);
      expect(((await missing.json()) as { error: string }).error).toMatch(/unknown knowledge page/);

      const synced = await fetch(`${base}/knowledge/sync`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dir, namespace: NS })
      });
      expect(synced.status).toBe(200);
      const report = (await synced.json()) as { pages: number; unchanged: number };
      expect(report.pages).toBe(2);
    } finally {
      await new Promise<void>((r) => app.close(() => r()));
    }
  });

  it("indexes a vault from the CLI and lists what it indexed", () => {
    writePage("alpha", `## How tokens work\n\n${PROSE.alpha}\n`, "---\ntitle: Alpha page\nslug: alpha\n---\n");
    const db = join(dir, "cli-memory.db");
    const run = (args: string[]) =>
      spawnSync(process.execPath, [join(root, "node_modules", "tsx", "dist", "cli.mjs"), join(root, "src", "cli", "index.ts"), ...args], {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          MEMORY_DB_PATH: db,
          AI_MEMORY_USER: "kb-cli",
          AI_MEMORY_AGENT: "codex",
          AI_MEMORY_CLI_FORCE_MAIN: "1",
          AI_MEMORY_SERVER: "http://127.0.0.1:1"
        }
      });

    const sync = run(["knowledge", "sync", "--dir", dir, "--json"]);
    expect(sync.status).toBe(0);
    const report = JSON.parse(sync.stdout) as { pages: number; inserted: number };
    expect(report.pages).toBe(1);
    expect(report.inserted).toBe(1);

    const list = run(["knowledge", "ls", "--scope", "shared", "--json"]);
    expect(list.status).toBe(0);
    const index = JSON.parse(list.stdout) as { pages: { id: string }[] };
    expect(index.pages.map((p) => p.id)).toEqual(["alpha"]);
  });
});
