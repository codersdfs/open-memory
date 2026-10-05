import { loadPages, buildGraph, suggestPages, addLink } from "../src/core/graph.js";

const dir = process.env.WIKI_DIR ?? "wiki";
const a = process.argv.slice(2);
const flag = (n: string) => a.includes(n);
const after = (n: string) => { const i = a.indexOf(n); return i === -1 ? [] : a.slice(i + 1); };

if (flag("--help") || flag("-h")) {
  console.log("wiki-links — graph over wiki/ links\n" +
    "  tsx scripts/wiki-links.ts                     # nodes/edges table\n" +
    "  tsx scripts/wiki-links.ts --suggest <slug>    # link candidates, no write\n" +
    "  tsx scripts/wiki-links.ts --add <from> <to>   # append [[to]] to <from>\n" +
    "\nWIKI_DIR overrides the wiki folder (default ./wiki)");
  process.exit(0);
}

const pages = await loadPages(dir);
const die = (m: string): never => { console.error(m); process.exit(1); };

if (flag("--suggest")) {
  const [id] = after("--suggest");
  if (!id || !pages.some((p) => p.id === id)) die("no such page: " + (id ?? ""));
  const s = suggestPages(pages, id);
  console.log(s.length ? s.map((p) => "  " + p.id + "  — " + p.title).join("\n") : "  (no candidates)");
  process.exit(0);
}

if (flag("--add")) {
  const [from, to] = after("--add");
  if (!from || !to) die("--add <from> <to>");
  if (!pages.some((p) => p.id === from)) die("no such page: " + from);
  await addLink(dir, from, to);
  console.log("linked " + from + " -> " + to);
  process.exit(0);
}

const g = buildGraph(pages);
console.log(g.nodes.length + " nodes · " + g.edges.length + " edges · " +
  g.nodes.filter((n) => n.dangling).length + " dangling\n");
for (const n of g.nodes) {
  const linked = g.edges.filter((e) => e.from === n.id || e.to === n.id).map((e) => (e.from === n.id ? e.to : "<-" + e.from));
  console.log("  " + String(n.deg).padStart(2) + "  " + n.id + (n.dangling ? " [dangling]" : "") +
    (linked.length ? "  " + linked.join(" ") : ""));
}
