import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parsePage, buildGraph, suggestPages, addLink, loadPages } from "../src/core/graph.js";

const page = (id: string, links: string[]) =>
  parsePage(
    id + ".md",
    ['---', 'title: "' + id + '"', 'slug: ' + id, 'source: "docs/' + id + '.md"',
     "links: [" + links.map((l) => '"' + l + '"').join(", ") + "]", "---", "", "# " + id, "", "body for " + id].join("\n"),
  );

describe("graph", () => {
  it("builds edges from frontmatter links only", () => {
    const g = buildGraph([page("a", ["b"]), page("b", [])]);
    expect(g.nodes.map((n) => n.id)).toEqual(["a", "b"]);
    expect(g.edges).toEqual([{ from: "a", to: "b", mutual: false }]);
    expect(g.nodes.find((n) => n.id === "b")!.deg).toBe(1);
  });

  it("keeps a dangling link as a node", () => {
    const ghost = buildGraph([page("a", ["ghost"])]).nodes.find((n) => n.id === "ghost")!;
    expect(ghost.dangling).toBe(true);
    expect(ghost.source).toBe("");
  });

  it("flags mutual links and does not duplicate the edge", () => {
    const g = buildGraph([page("a", ["b"]), page("b", ["a"])]);
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0].mutual).toBe(true);
  });

  it("a page with no links contributes a node and no edges", () => {
    const g = buildGraph([page("index", []), page("a", ["index"])]);
    expect(g.nodes.length).toBe(2);
    expect(g.edges).toHaveLength(1);
  });

  it("flattens a path link [[dir/b]] to node b", () => {
    expect(buildGraph([page("a", ["dir/b"]), page("b", [])]).edges[0].to).toBe("b");
  });

  it("suggests shared-title-term pages, excluding current neighbours", () => {
    const pages = [page("sqlite-vector", []), page("sqlite-tuning", []), page("unrelated", [])];
    expect(suggestPages(pages, "sqlite-vector").map((p) => p.id)).toEqual(["sqlite-tuning"]);
  });

  it("reads [[links]] out of the body, where a vault actually writes them", () => {
    const p = parsePage("a.md", "---\ntitle: \"a\"\n---\n\n# a\n\nsee [[b]] and [[dir/c|alias]] and [[d#heading]]\n");
    expect(p.links).toEqual(["b", "dir/c", "d"]);
    // an unresolved link still draws an edge — its hollow node is the maintenance debt
    expect(buildGraph([p, page("b", [])]).edges.map((e) => e.to)).toEqual(["b", "dir/c", "d"]);
  });

  it("ignores wikilinks inside code spans and fences", () => {
    const p = parsePage("a.md", "# a\n\nuse \`[[ghost]]\` like this\n\n\`\`\`\n[[fenced]]\n\`\`\`\n\nreal [[b]]\n");
    expect(p.links).toEqual(["b"]);
    expect(buildGraph([p, page("b", [])]).nodes.map((n) => n.id)).toEqual(["a", "b"]);
  });

  it("resolves [[x]] across folders by unique basename", () => {
    const g = buildGraph([parsePage("a.md", "# a\n\n[[y]]\n"), parsePage("adr/y.md", "# y\n")]);
    expect(g.edges[0]).toEqual({ from: "a", to: "adr/y", mutual: false });
  });

  it("leaves an ambiguous basename dangling rather than guessing", () => {
    const g = buildGraph([parsePage("a.md", "# a\n\n[[x]]\n"), parsePage("p/x.md", "# x\n"), parsePage("q/x.md", "# x\n")]);
    expect(g.edges[0]!.to).toBe("x");
    expect(g.nodes.find((n) => n.id === "x")!.dangling).toBe(true);
  });

  it("nested files get a path id, a first-segment folder and tags", () => {
    const p = parsePage("adr/x.md", "---\ntags: [\"scope:wiki\", design]\n---\n\n# x\n\nbody #second-brain\n");
    expect(p.id).toBe("adr/x");
    expect(p.tags).toEqual(["scope:wiki", "design", "second-brain"]);
    const n = buildGraph([p]).nodes[0]!;
    expect([n.folder, n.file, n.tags.length]).toEqual(["adr", "adr/x.md", 3]);
  });

  it("addLink then buildGraph keeps the edge — the --add path used to vanish", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "g-"));
    await fs.writeFile(path.join(dir, "a.md"), "# a\n", "utf8");
    await fs.writeFile(path.join(dir, "b.md"), "# b\n", "utf8");
    await addLink(dir, "b", "a");
    expect(buildGraph(await loadPages(dir)).edges).toEqual([{ from: "b", to: "a", mutual: false }]);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("loadPages recurses and skips dot dirs", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "g-"));
    await fs.mkdir(path.join(dir, "sub"), { recursive: true });
    await fs.mkdir(path.join(dir, ".hidden"), { recursive: true });
    await fs.writeFile(path.join(dir, "sub", "n.md"), "# n\n", "utf8");
    await fs.writeFile(path.join(dir, ".hidden", "x.md"), "# x\n", "utf8");
    expect((await loadPages(dir)).map((p) => p.id)).toEqual(["sub/n"]);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("addLink appends [[to]] once", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "g-"));
    await fs.writeFile(path.join(dir, "a.md"), page("a", []).text, "utf8");
    await addLink(dir, "a", "b");
    await addLink(dir, "a", "b");
    const raw = await fs.readFile(path.join(dir, "a.md"), "utf8");
    expect(raw.match(/\[\[b\]\]/g)).toHaveLength(1);
    await fs.rm(dir, { recursive: true, force: true });
  });
});
