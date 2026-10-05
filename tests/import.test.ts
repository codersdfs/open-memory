import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { discoverSources, listMarkdownFiles, extractFromMarkdown, readMarkdownSource, readSource } from "../src/migrate/import.js";
import type { ImportSource } from "../src/migrate/import.js";
import { MemoryService } from "../src/core/memoryService.js";
import { InMemoryVectorStore } from "../src/core/store/memory.js";

/**
 * Import tests.
 *
 * A migration is destructive when it is unreliable: it must never invent memories from
 * prose, never import the same line twice, and never fail the whole run over one bad
 * file. Each case below pins one of those down.
 */

let root: string;
const saved: Record<string, string | undefined> = {};
const KEYS = ["HOME", "USERPROFILE", "MEMORY_DB_PATH", "AI_MEMORY_USER", "AI_MEMORY_AGENT"];

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "ai-memory-import-"));
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  process.env.AI_MEMORY_USER = "importuser";
  process.env.AI_MEMORY_AGENT = "claude";
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
  rmSync(root, { recursive: true, force: true });
});

describe("markdown extraction", () => {
  it("keeps durable bullets and prefixes them with their heading", () => {
    const items = extractFromMarkdown(
      [
        "# Deploy runbook",
        "",
        "Deploy the billing worker with pnpm run deploy:billing.",
        "- Never run npm in this repo, it rewrites the lockfile.",
        "* The staging database password rotates on the first Monday.",
        "",
        "## Testing",
        "Run pnpm test before every commit to keep the suite green."
      ].join("\n"),
      "/tmp/AGENTS.md"
    );
    const texts = items.map((i) => i.text);
    expect(texts).toContain("Deploy runbook: Deploy the billing worker with pnpm run deploy:billing.");
    expect(texts).toContain("Deploy runbook: Never run npm in this repo, it rewrites the lockfile.");
    expect(texts).toContain("Testing: Run pnpm test before every commit to keep the suite green.");
    expect(items.every((i) => i.tags?.includes("imported"))).toBe(true);
    expect(items.every((i) => i.source === "import:AGENTS.md")).toBe(true);
  });

  it("classifies imperative lines as procedural and statements as semantic", () => {
    const items = extractFromMarkdown(
      ["- Run the migration script before deploying the service.", "- The service stores vectors in sqlite by default."].join("\n"),
      "NOTES.md"
    );
    expect(items.find((i) => i.text.includes("migration script"))!.type).toBe("procedural");
    expect(items.find((i) => i.text.includes("vectors in sqlite"))!.type).toBe("semantic");
  });

  it("skips noise: short lines, code fences, tables, quotes and raw urls", () => {
    const items = extractFromMarkdown(
      [
        "too short",
        "```bash",
        "pnpm run deploy:billing --with-a-very-long-flag-value",
        "```",
        "| column | column | column | value |",
        "> A quoted paragraph that is definitely long enough to qualify.",
        "https://example.com/some/long/path/that/is/definitely/long/enough",
        "- ok."
      ].join("\n"),
      "NOISE.md"
    );
    expect(items).toHaveLength(0);
  });

  it("drops paragraphs over the 600 character cap", () => {
    const long = "The deployment process requires careful sequencing and verification. ".repeat(12);
    expect(extractFromMarkdown(long, "LONG.md")).toHaveLength(0);
  });

  it("is deterministic: the same file yields the same items", () => {
    const md = "# Notes\n- The billing worker deploys on the first Monday of the month.";
    expect(extractFromMarkdown(md, "A.md")).toEqual(extractFromMarkdown(md, "A.md"));
  });
});

describe("source discovery", () => {
  it("finds the well-known agent files when they exist", () => {
    mkdirSync(path.join(root, ".claude"), { recursive: true });
    writeFileSync(path.join(root, ".claude", "CLAUDE.md"), "# Rules\n- Always run the tests before pushing a commit.");
    writeFileSync(path.join(root, "AGENTS.md"), "# Agents\n- Prefer pnpm over npm in this repository.");

    const sources = discoverSources(root);
    const paths = sources.map((s) => s.path);
    expect(paths).toContain(path.join(root, ".claude", "CLAUDE.md"));
    expect(paths).toContain(path.join(root, "AGENTS.md"));
    expect(sources.every((s) => s.kind === "markdown")).toBe(true);
  });

  it("returns nothing rather than throwing when there is nothing to import", () => {
    expect(discoverSources(root).filter((s) => s.kind === "markdown")).toHaveLength(0);
  });

  it("lists markdown and plain-text files recursively with a stable cap", () => {
    const dir = path.join(root, "wayfinder");
    mkdirSync(path.join(dir, "nested"), { recursive: true });
    for (let i = 0; i < 6; i++) writeFileSync(path.join(dir, `doc-${i}.md`), `# Doc ${i}\n- A fact number ${i} that is long enough to be imported.`);
    writeFileSync(path.join(dir, "nested", "deep.md"), "# Deep\n- A nested fact that is also long enough to import.");
    writeFileSync(path.join(dir, "ignore.txt"), "plain text notes are importable too");

    const files = listMarkdownFiles(dir, 50);
    expect(files).toHaveLength(8);
    expect(files.filter((f) => f.endsWith(".md"))).toHaveLength(7);
    expect(files).toContain(path.join(dir, "nested", "deep.md"));
    expect(listMarkdownFiles(dir, 3)).toHaveLength(3);
    expect(listMarkdownFiles(path.join(root, "does-not-exist"))).toEqual([]);
  });

  it("skips an unreadable file instead of failing the run", () => {
    const missing: ImportSource = { id: "md:file", kind: "markdown", path: path.join(root, "nope.md"), detail: "missing" };
    expect(readMarkdownSource(missing)).toEqual([]);
  });

  it("readSource dispatches on kind", async () => {
    const file = path.join(root, "MEMORY.md");
    writeFileSync(file, "# House\n- The build runs on every push to the main branch.");
    const items = await readSource({ id: "md:file", kind: "markdown", path: file, detail: "test" });
    expect(items).toHaveLength(1);
  });
});

describe("import into the store", () => {
  it("imports deduped items and is safe to run twice", async () => {
    const svc = new MemoryService({ store: new InMemoryVectorStore(), dedupThreshold: 0.99 });
    await svc.init();

    const md = [
      "# Conventions",
      "- Always run pnpm test before pushing to the main branch.",
      "- The staging database password rotates on the first Monday of the month."
    ].join("\n");
    const items = extractFromMarkdown(md, "AGENTS.md");
    expect(items).toHaveLength(2);

    for (const item of items) {
      await svc.save({ ...item, namespace: "shared:importuser" });
    }
    const first = await svc.list({ namespace: "shared:importuser" });
    expect(first.total).toBe(2);

    // A second import of the identical text must not duplicate.
    for (const item of items) {
      const existing = await svc.search({ query: item.text, namespace: "shared:importuser", threshold: 0.99, k: 1 });
      if (existing.memories.length === 0) await svc.save({ ...item, namespace: "shared:importuser" });
    }
    const second = await svc.list({ namespace: "shared:importuser" });
    expect(second.total).toBe(2);
  });

  it("keeps imported items out of the private agent layer", async () => {
    const svc = new MemoryService({ store: new InMemoryVectorStore(), dedupThreshold: 0.99 });
    await svc.init();
    const items = extractFromMarkdown("# Conventions\n- Always run the release checklist before tagging.", "AGENTS.md");
    for (const item of items) await svc.save({ ...item, namespace: "shared:importuser" });
    const privateLayer = await svc.list({ namespace: "claude:importuser" });
    expect(privateLayer.total).toBe(0);
  });
});
