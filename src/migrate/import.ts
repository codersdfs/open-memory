import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * One-time import from the stores that existed before ADR-0007.
 *
 * Two kinds of source:
 *  - **SQLite stores** written by an earlier version of this project (a `memory.db`
 *    that is not the configured one, e.g. one left in a checkout);
 *  - **Markdown/instruction files** other agents maintain (CLAUDE.md, AGENTS.md,
 *    wayfinder notes), which carry durable project facts that were never in any store.
 *
 * Import is conservative and idempotent: it runs through the normal `save` path, so
 * near-duplicates collapse instead of doubling the store.
 */

export interface ImportSource {
  id: string;
  kind: "sqlite" | "markdown";
  path: string;
  detail: string;
}

export interface ImportedItem {
  text: string;
  type: "semantic" | "procedural" | "episodic";
  importance: number;
  tags: string[];
  source: string;
}

/** Markdown files whose bullet/paragraph content is durable project knowledge. */
const MARKDOWN_CANDIDATES = [
  "CLAUDE.md",
  "AGENTS.md",
  "CONTEXT.md",
  "README.md",
  path.join(".claude", "CLAUDE.md"),
  path.join(".github", "copilot-instructions.md"),
  path.join("wiki", "index.md")
];

export function discoverSources(cwd = process.cwd(), extraSqlite: string[] = []): ImportSource[] {
  const out: ImportSource[] = [];
  for (const rel of extraSqlite) {
    const abs = path.resolve(cwd, rel);
    if (existsSync(abs)) out.push({ id: `sqlite:${rel}`, kind: "sqlite", path: abs, detail: "SQLite memory store" });
  }
  for (const rel of MARKDOWN_CANDIDATES) {
    const abs = path.resolve(cwd, rel);
    if (existsSync(abs)) out.push({ id: `md:${rel}`, kind: "markdown", path: abs, detail: "markdown instructions/notes" });
  }
  const wayfinder = path.resolve(cwd, "wayfinder");
  if (existsSync(wayfinder)) {
    out.push({ id: "md:wayfinder", kind: "markdown", path: wayfinder, detail: "wayfinder notes directory" });
  }
  return out;
}

export function listMarkdownFiles(dir: string, limit = 50): string[] {
  const found: string[] = [];
  const walk = (d: string) => {
    if (found.length >= limit) return;
    let entries: { name: string; isDirectory(): boolean }[] = [];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= limit) return;
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        walk(full);
      } else if (/\.(md|mdx|txt)$/i.test(entry.name)) {
        found.push(full);
      }
    }
  };
  walk(dir);
  return found;
}

/** Turn markdown into candidate memories: headings + bullets + substantial paragraphs. */
export function extractFromMarkdown(content: string, sourcePath: string): ImportedItem[] {
  const items: ImportedItem[] = [];
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  let heading = "";
  // Fenced code is documentation of commands, not a durable fact: importing the
  // body produced memories made of shell snippets. Track the fence and skip it whole.
  let inFence = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (/^(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (!line) continue;
    const h = /^#{1,6}\s+(.*)$/.exec(line);
    if (h) {
      heading = h[1]!.trim();
      continue;
    }
    const bullet = /^[-*+]\s+(.*)$/.exec(line) ?? /^\d+[.)]\s+(.*)$/.exec(line);
    const text = (bullet ? bullet[1]! : line).replace(/\s+/g, " ").trim();
    if (text.length < 24 || text.length > 600) continue;
    if (text.startsWith("```") || text.startsWith("|") || text.startsWith(">")) continue;
    if (/^https?:\/\//.test(text)) continue;
    items.push({
      text: heading ? `${heading}: ${text}` : text,
      type: /^(run|use|always|never|prefer|install|build|test|command)/i.test(text) ? "procedural" : "semantic",
      importance: 0.5,
      tags: ["imported"],
      source: `import:${path.basename(sourcePath)}`
    });
  }
  return items;
}

export function readMarkdownSource(src: ImportSource): ImportedItem[] {
  const files = src.id === "md:wayfinder" ? listMarkdownFiles(src.path) : [src.path];
  const out: ImportedItem[] = [];
  for (const f of files) {
    try {
      out.push(...extractFromMarkdown(readFileSync(f, "utf8"), f));
    } catch {
      // unreadable file: skip, import is best-effort
    }
  }
  return out;
}

interface Row {
  text: string;
  type?: string;
  importance?: number;
  tags?: string;
  source?: string | null;
}

/**
 * Read rows from another SQLite store using the same schema this project writes.
 * `node:sqlite` is imported dynamically because it only exists on Node >= 22.5 and a
 * missing module must not break the rest of the CLI.
 */
export async function readSqliteSource(src: ImportSource, limit = 5000): Promise<ImportedItem[]> {
  let DatabaseSync: new (p: string) => {
    prepare(sql: string): { all(...args: unknown[]): unknown[] };
    close(): void;
  };
  try {
    ({ DatabaseSync } = (await import("node:sqlite")) as unknown as { DatabaseSync: typeof DatabaseSync });
  } catch (err) {
    throw new Error(`node:sqlite unavailable (${(err as Error).message}); cannot import ${src.path}`);
  }
  const db = new DatabaseSync(src.path);
  try {
    const rows = db
      .prepare(`SELECT text, type, importance, tags, source FROM memories WHERE is_deleted = 0 ORDER BY created_at DESC LIMIT ?`)
      .all(limit) as Row[];
    return rows.map((r) => ({
      text: String(r.text),
      type: (r.type as ImportedItem["type"]) ?? "semantic",
      importance: typeof r.importance === "number" ? r.importance : 0.5,
      tags: typeof r.tags === "string" && r.tags ? safeTags(r.tags) : ["imported"],
      source: r.source ?? `import:${path.basename(src.path)}`
    }));
  } finally {
    db.close();
  }
}

function safeTags(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : ["imported"];
  } catch {
    return ["imported"];
  }
}

export async function readSource(src: ImportSource): Promise<ImportedItem[]> {
  return src.kind === "sqlite" ? readSqliteSource(src) : readMarkdownSource(src);
}
