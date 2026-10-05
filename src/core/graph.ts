import { promises as fs } from "node:fs";
import path from "node:path";

export interface GraphNode { id: string; title: string; source: string; deg: number; dangling: boolean }
export interface GraphEdge { from: string; to: string; mutual: boolean }
export interface Graph { nodes: GraphNode[]; edges: GraphEdge[] }
export interface Page { id: string; title: string; source: string; links: string[]; text: string }

/** Read one frontmatter key: title / slug / source / links. */
function fm(head: string, key: string): string {
  const line = head.split("\n").find((l) => l.startsWith(key + ":"));
  return line ? line.slice(key.length + 1).trim() : "";
}
const unquote = (s: string) => s.replace(/^["']|["']$/g, "");

/** "[[a/b]]" -> "b": wiki links can carry a path, the graph is flat. */
const bare = (link: string) => link.replace(/\.md$/, "").split("/").pop()!.trim();

/**
 * Parse one wiki page. Frontmatter links are the edge source — wiki-ingest
 * already writes them, and a second pass over the body would only find links
 * ingest missed.
 */
export function parsePage(file: string, raw: string): Page {
  const id = path.basename(file, ".md");
  const end = raw.indexOf("\n---", 3);
  const head = raw.startsWith("---") && end !== -1 ? raw.slice(0, end + 4) : "";
  const links = (fm(head, "links").match(/"[^"]+"/g) ?? []).map(unquote);
  const h1 = raw.slice(head.length).match(/^#[ \t]+(.+)$/m);
  return {
    id,
    title: unquote(fm(head, "title")) || h1?.[1]?.trim() || id,
    source: unquote(fm(head, "source")),
    links,
    text: raw.slice(head.length),
  };
}

export function buildGraph(pages: Page[]): Graph {
  const byId = new Map(pages.map((p) => [p.id, p]));
  const nodes = new Map<string, GraphNode>();
  const touch = (id: string, dangling: boolean) => {
    const n = nodes.get(id);
    if (n) { if (!dangling) n.dangling = false; return; }
    const src = byId.get(id);
    nodes.set(id, { id, title: src?.title ?? id, source: src?.source ?? "", deg: 0, dangling });
  };
  for (const p of pages) touch(p.id, false);
  for (const p of pages) for (const l of p.links) { const to = bare(l); if (to && to !== p.id) touch(to, !byId.has(to)); }

  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  for (const p of pages) {
    for (const l of p.links) {
      const to = bare(l);
      if (!to || to === p.id) continue;
      const a = p.id < to ? p.id : to, b = p.id < to ? to : p.id;
      const key = a + "\u0000" + b;
      if (seen.has(key)) continue;
      seen.add(key);
      const back = byId.get(to)?.links.some((x) => bare(x) === p.id) ?? false;
      edges.push({ from: p.id, to, mutual: back });
    }
  }
  for (const e of edges) { nodes.get(e.from)!.deg++; nodes.get(e.to)!.deg++; }
  return {
    nodes: [...nodes.values()].sort((x, y) => y.deg - x.deg || x.id.localeCompare(y.id)),
    edges,
  };
}

const STOP = new Set(["the", "a", "an", "of", "to", "for", "and", "in", "on", "via", "no", "not", "by", "at", "is", "it"]);
const terms = (s: string) =>
  s.toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/).filter((t) => t.length > 2 && !STOP.has(t));

/**
 * Suggest links for a page: pages sharing title terms, excluding current
 * neighbours. No model call — an LLM would cost a round trip per page and
 * shared title terms are the cheap 80% of it.
 *
 * ponytail: title terms only. Body-term scoring next if suggestions feel thin.
 */
export function suggestPages(pages: Page[], id: string, k = 5): Page[] {
  const me = pages.find((p) => p.id === id);
  if (!me) return [];
  const linked = new Set(me.links.map(bare));
  const mine = new Set(terms(me.title));
  return pages
    .filter((p) => p.id !== id && !linked.has(p.id))
    .map((p) => ({ p, score: terms(p.title).filter((t) => mine.has(t)).length }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.p.id.localeCompare(b.p.id))
    .slice(0, k)
    .map((x) => x.p);
}

/** Append [[id]] to a page body — a real text edit, so re-ingest sees it. */
export async function addLink(dir: string, from: string, to: string): Promise<void> {
  const file = path.join(dir, from + ".md");
  const raw = await fs.readFile(file, "utf8");
  if (raw.includes("[[" + to + "]]")) return;
  await fs.writeFile(file, raw.trimEnd() + "\n\n[[" + to + "]]\n", "utf8");
}

export async function loadPages(dir: string): Promise<Page[]> {
  const entries = await fs.readdir(dir).catch(() => [] as string[]);
  const pages: Page[] = [];
  for (const f of entries) {
    if (f.endsWith(".md")) pages.push(parsePage(f, await fs.readFile(path.join(dir, f), "utf8")));
  }
  return pages;
}
