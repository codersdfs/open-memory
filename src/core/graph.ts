import { promises as fs } from "node:fs";
import path from "node:path";

export interface GraphNode {
  id: string;
  title: string;
  source: string;
  deg: number;
  dangling: boolean;
  /** First path segment, "" at the vault root. Colour groups key off this. */
  folder: string;
  tags: string[];
  /** Vault-relative file path, "" for a dangling node. */
  file: string;
}
export interface GraphEdge { from: string; to: string; mutual: boolean }
export interface Graph { nodes: GraphNode[]; edges: GraphEdge[] }
export interface Page {
  id: string;
  title: string;
  source: string;
  links: string[];
  tags: string[];
  file: string;
  text: string;
}

/**
 * Vault root. `VAULT_DIR` names the knowledge vault; `WIKI_DIR` is the v1 name
 * and still wins when set, so no existing invocation or script breaks.
 */
export function vaultDir(): string {
  return process.env.VAULT_DIR ?? process.env.WIKI_DIR ?? "vault";
}

const base = (id: string) => id.slice(id.lastIndexOf("/") + 1);

/** Read one frontmatter key: title / slug / source / links / tags. */
function fm(head: string, key: string): string {
  const line = head.split("\n").find((l) => l.startsWith(key + ":"));
  return line ? line.slice(key.length + 1).trim() : "";
}
const unquote = (s: string) => s.replace(/^["']|["']$/g, "");

/** Frontmatter list value: `["a", "b"]` or `[a, b]`. */
function fmList(head: string, key: string): string[] {
  const line = fm(head, key);
  if (!line) return [];
  return line.replace(/^\[|\]$/g, "").split(",").map((s) => unquote(s.trim())).filter(Boolean);
}

/** `[[dir/b|alias#heading]]` -> `dir/b`. Backslashes and a .md suffix are noise. */
const linkTarget = (l: string) =>
  l.split("|")[0]!.split("#")[0]!.trim().replace(/\\/g, "/").replace(/\.md$/i, "");

/**
 * Obsidian does not link inside code, and neither do we: a note *documenting*
 * `[[wikilinks]]` would otherwise grow a hollow node per example — the exact
 * "graph lies about intent" failure this design refuses.
 */
export function stripCode(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/~~~[\s\S]*?~~~/g, " ")
    .replace(/`[^`\n]*`/g, " ");
}

/**
 * Body wikilinks. This is where a vault actually writes its links; the
 * frontmatter `links:` list is ingest's copy of the same idea, so the two are
 * unioned rather than chosen between. Reading only frontmatter is why
 * `wiki-links --add` used to append a link the graph could not see.
 */
function bodyLinks(body: string): string[] {
  return [...body.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => linkTarget(m[1]!)).filter(Boolean);
}

/** Inline #tags. `# Heading` does not match — a tag needs a word character after the hash. */
function bodyTags(body: string): string[] {
  return [...body.matchAll(/(?:^|\s)#([\w:/-]+)/g)].map((m) => m[1]!).filter(Boolean);
}

/**
 * Parse one vault page. `file` is vault-relative (`adr/x.md`) and becomes the
 * node id without the extension; a bare filename still parses, so callers that
 * have only a name keep working.
 */
export function parsePage(file: string, raw: string): Page {
  const rel = file.split(path.sep).join("/");
  const id = rel.replace(/\.md$/i, "");
  const end = raw.indexOf("\n---", 3);
  const head = raw.startsWith("---") && end !== -1 ? raw.slice(0, end + 4) : "";
  const body = raw.slice(head.length);
  const h1 = body.match(/^#[ \t]+(.+)$/m);
  const scan = stripCode(body);
  return {
    id,
    title: unquote(fm(head, "title")) || h1?.[1]?.trim() || base(id),
    source: unquote(fm(head, "source")),
    links: [...new Set([...fmList(head, "links"), ...bodyLinks(scan)])],
    tags: [...new Set([...fmList(head, "tags"), ...bodyTags(scan)])],
    file: rel,
    text: body,
  };
}

export function buildGraph(pages: Page[]): Graph {
  const byId = new Map(pages.map((p) => [p.id, p]));
  const byBase = new Map<string, string[]>();
  for (const p of pages) {
    const b = base(p.id);
    byBase.set(b, [...(byBase.get(b) ?? []), p.id]);
  }
  /**
   * Exact relative id first, then a unique basename (Obsidian's shorthand). Two
   * files sharing a basename are ambiguous, so the link stays unresolved and
   * renders as a hollow node — guessing would draw an edge the author never wrote.
   */
  const resolve = (link: string): string => {
    const t = linkTarget(link);
    if (!t) return "";
    if (byId.has(t)) return t;
    const hits = byBase.get(base(t)) ?? [];
    return hits.length === 1 ? hits[0]! : t;
  };

  const nodes = new Map<string, GraphNode>();
  const touch = (id: string, dangling: boolean) => {
    const n = nodes.get(id);
    if (n) { if (!dangling) n.dangling = false; return; }
    const src = byId.get(id);
    nodes.set(id, {
      id,
      title: src?.title ?? id,
      source: src?.source ?? "",
      deg: 0,
      dangling,
      folder: id.includes("/") ? id.slice(0, id.indexOf("/")) : "",
      tags: src?.tags ?? [],
      file: src?.file ?? "",
    });
  };
  for (const p of pages) touch(p.id, false);
  for (const p of pages) for (const l of p.links) { const to = resolve(l); if (to && to !== p.id) touch(to, !byId.has(to)); }

  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  for (const p of pages) {
    for (const l of p.links) {
      const to = resolve(l);
      if (!to || to === p.id) continue;
      const a = p.id < to ? p.id : to, b = p.id < to ? to : p.id;
      const key = a + "\u0000" + b;
      if (seen.has(key)) continue;
      seen.add(key);
      const back = byId.get(to)?.links.some((x) => resolve(x) === p.id) ?? false;
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
  const g = buildGraph(pages);
  const linked = new Set(
    g.edges.filter((e) => e.from === id || e.to === id).map((e) => (e.from === id ? e.to : e.from)),
  );
  const mine = new Set(terms(me.title));
  return pages
    .filter((p) => p.id !== id && !linked.has(p.id))
    .map((p) => ({ p, score: terms(p.title).filter((t) => mine.has(t)).length }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.p.id.localeCompare(b.p.id))
    .slice(0, k)
    .map((x) => x.p);
}

/** Append [[id]] to a page body — a real text edit, so re-ingest and the graph both see it. */
export async function addLink(dir: string, from: string, to: string): Promise<void> {
  const file = path.join(dir, from + ".md");
  const raw = await fs.readFile(file, "utf8");
  if (raw.includes("[[" + to + "]]")) return;
  await fs.writeFile(file, raw.trimEnd() + "\n\n[[" + to + "]]\n", "utf8");
}

const skip = (rel: string) => rel.split("/").some((s) => s.startsWith(".") || s === "node_modules");

/** Every *.md under the vault, recursively, sorted. Dot dirs and node_modules are not knowledge. */
export async function loadPages(dir: string): Promise<Page[]> {
  const names = (await fs.readdir(dir, { recursive: true }).catch(() => [] as string[]))
    .map((n) => String(n).split(path.sep).join("/"))
    .sort();
  const pages: Page[] = [];
  for (const rel of names) {
    if (!/\.md$/i.test(rel) || skip(rel)) continue;
    pages.push(parsePage(rel, await fs.readFile(path.join(dir, rel), "utf8")));
  }
  return pages;
}
