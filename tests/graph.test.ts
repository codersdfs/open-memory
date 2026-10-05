import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parsePage, buildGraph, suggestPages, addLink } from "../src/core/graph.js";

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
