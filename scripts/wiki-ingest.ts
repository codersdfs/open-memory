import "../src/config.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { MemoryService } from "../src/core/memoryService.js";

const ns = process.env.NAMESPACE ?? "default:default";
const dbPath = process.env.MEMORY_DB_PATH ?? "memory.db";

function slugify(file: string): string {
  return path.basename(file, path.extname(file)).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "page";
}

function extractTitle(md: string, fallback: string): string {
  const m = md.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : fallback;
}

/**
 * Split a markdown file into storable units.
 *
 * Storing the whole document as one Memory is what put six full ADR texts into
 * the store: a 1.5k-char blob is not a memory, it is a file. It matched on any
 * word it happened to share with the query ("token", "burning") and spent half
 * the recall budget printing back a decision record the agent can just read.
 *
 * A section is the right unit: it carries its own heading as context and is
 * small enough to answer from. Code fences are dropped — a shell command is not
 * context, it is an instruction to a machine.
 *
 * ponytail: heading split, no summarizer. An LLM summary would be nicer and
 * would cost a call per file on every ingest. If a section still reads badly,
 * add one — don't reach for a model first.
 */
export function toSections(md: string, maxSections = 5): { heading: string; text: string }[] {
  // Splitting on the heading marker leaves [preamble, hashes, "Title\n\nbody", ...]
  // — title and body arrive in the SAME part, so each one has to be taken apart
  // again at its first newline.
  const parts = md.split(/^#{1,3}[ \t]+/m);
  const out: { heading: string; text: string }[] = [];
  for (let i = 1; i < parts.length; i++) {
    const nl = parts[i].indexOf("\n");
    const heading = (nl === -1 ? parts[i] : parts[i].slice(0, nl)).trim();
    const body = nl === -1 ? "" : parts[i].slice(nl + 1);
    const prose = body
      .replace(/\x60\x60\x60[\s\S]*?\x60\x60\x60/g, " ")
      .replace(/\n{2,}/g, "\n")
      .trim();
    if (prose.length < 40) continue;
    out.push({ heading, text: prose.slice(0, 600) });
    if (out.length >= maxSections) break;
  }
  return out;
}

function extractLinks(md: string): string[] {
  // [[link]] and frontmatter links: ["a","b"]
  const w: string[] = [];
  for (const m of md.matchAll(/\[\[([^\]]+)\]\]/g)) w.push(m[1].trim());
  // markdown links [text](slug) inside wiki
  for (const m of md.matchAll(/\[([^\]]+)\]\(\s*([^)]+)\s*\)/g)) {
    const href = m[2].trim();
    if (!href.startsWith("http") && href.length < 80) w.push(href.replace(/\.md$/, ""));
  }
  return [...new Set(w)].slice(0, 10);
}

async function collectFiles(p: string): Promise<string[]> {
  const stat = await fs.stat(p).catch(() => null);
  if (!stat) return [];
  if (stat.isFile()) return [p];
  const out: string[] = [];
  const entries = await fs.readdir(p, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(p, e.name);
    if (e.isDirectory()) {
      if (e.name.startsWith(".") || e.name === "node_modules" || e.name === ".codegraph" || e.name === "wiki") continue;
      out.push(...(await collectFiles(full)));
    } else if (e.isFile() && (e.name.endsWith(".md") || e.name.endsWith(".txt"))) {
      out.push(full);
    }
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help")) {
    console.log(`wiki-ingest — 003 hybrid: docs → ./wiki/*.md + semantic scope:wiki

Usage: npx tsx scripts/wiki-ingest.ts <file|dir> [--out ./wiki] [--ns default:default]
       npm run wiki:ingest -- ./docs/foo.md
       npm run wiki:ingest -- ./docs
`);
    process.exit(0);
  }
  const outIdx = args.indexOf("--out");
  const outDir = outIdx !== -1 ? args[outIdx + 1] : "wiki";
  const nsIdx = args.indexOf("--ns");
  const effNs = nsIdx !== -1 ? args[nsIdx + 1] : ns;
  // positional
  const inputs = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--out" && args[i - 1] !== "--ns");
  if (inputs.length === 0) { console.error("no input"); process.exit(1); }

  const files: string[] = [];
  for (const inp of inputs) files.push(...(await collectFiles(inp)));
  if (files.length === 0) { console.error("no files found"); process.exit(1); }

  await fs.mkdir(outDir, { recursive: true });
  const svc = new MemoryService({ dbPath });
  await svc.init();

  let ok = 0, failed = 0;
  for (const f of files) {
    try {
      const raw = await fs.readFile(f, "utf8");
      const slug = slugify(f);
      const title = extractTitle(raw, slug);
      const links = extractLinks(raw);
      // body: heuristic — take raw, truncate to 4000 chars, keep headings
      const body = raw.slice(0, 4000);
      const frontmatter = `---\ntitle: "${title.replace(/"/g, '\\"')}"\nslug: ${slug}\nsource: "${f.replace(/"/g, '\\"')}"\nlinks: [${links.map(l => `"${l.replace(/"/g, '\\"')}"`).join(", ")}]\n---\n\n`;
      const wikiPath = path.join(outDir, `${slug}.md`);
      await fs.writeFile(wikiPath, frontmatter + body + `\n\n> Source: ${f}\n`, "utf8");
      const sections = toSections(raw);
      for (const [n, sec] of sections.entries()) {
        await svc.save({
          namespace: effNs,
          type: "semantic",
          // The doc title travels with every section: "Why solo" means nothing
          // on its own once it is out of the file.
          text: `${title} — ${sec.heading}: ${sec.text}`,
          // Whole-doc importance was 0.7; a section is less load-bearing and it
          // competes with the user's own memories for the same budget.
          importance: 0.5,
          source: `wiki:${f}`,
          tags: ["scope:wiki", `wiki:${slug}`, `section:${n}`, `source:${f}`],
          status: "active"
        });
      }
      console.log(`ingested ${f} → ${wikiPath} → ${sections.length} semantic sections (${links.length} links)`);
      ok++;
    } catch (e) {
      console.error(`failed ${f}: ${(e as Error).message}`);
      failed++;
    }
  }

  // generate index.md
  const wikiFiles = await fs.readdir(outDir).catch(() => []);
  const indexLines = ["# Wiki index — generated", "", `> ${new Date().toISOString()} · ${ok} pages\n`, "| slug | title | source | links |", "|---|---|---|---|"];
  for (const wf of wikiFiles.filter(f => f.endsWith(".md") && f !== "index.md")) {
    try {
      const c = await fs.readFile(path.join(outDir, wf), "utf8");
      const m = c.match(/^---\n([\s\S]*?)\n---/);
      const fm = m ? m[1] : "";
      const title = fm.match(/title:\s*"([^"]+)"/)?.[1] ?? wf;
      const src = fm.match(/source:\s*"([^"]+)"/)?.[1] ?? "";
      const links = fm.match(/links:\s*\[(.*)\]/)?.[1] ?? "";
      indexLines.push(`| ${wf.replace(/\.md$/, "")} | ${title} | ${src} | ${links} |`);
    } catch {}
  }
  await fs.writeFile(path.join(outDir, "index.md"), indexLines.join("\n"), "utf8");
  console.log(`wiki: ${ok} ok, ${failed} failed → ${outDir}/index.md`);
  svc.close();
}

// Only when run directly. Importing this file for toSections() must not
// start an ingest or exit the process — that made the function untestable.
const invokedDirectly =
  process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href;
if (invokedDirectly) main().catch((e) => { console.error(e); process.exit(1); });
