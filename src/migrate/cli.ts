import { MemoryService } from "../core/memoryService.js";
import { resolveAgent, resolveWriteKey } from "../core/scope.js";
import type { MemoryScope } from "../core/scope.js";
import { discoverSources, readSource, type ImportSource } from "./import.js";

/**
 * `ai-memory import` — move older, per-agent knowledge into the shared store.
 *
 * Dry-run by default (`import run` shows counts and a sample; `--write` saves).
 * Everything is written to the *shared* layer unless `--scope private` is given,
 * because the point of importing CLAUDE.md/AGENTS.md content is that every agent
 * should see it.
 */

export interface Ctx {
  json: boolean;
  out: (s: string) => void;
  err: (s: string) => void;
}

interface Flags {
  [key: string]: string | boolean;
}

function str(flags: Flags, name: string): string | undefined {
  const v = flags[name];
  return typeof v === "string" ? v : undefined;
}

function bool(flags: Flags, name: string): boolean {
  const v = flags[name];
  return v === true || v === "true" || v === "1";
}

export async function runImportCommand(positionals: string[], flags: Flags, ctx: Ctx): Promise<number> {
  const sub = positionals[0] ?? "list";
  const extra = str(flags, "from") ? [str(flags, "from")!] : [];
  const sources = discoverSources(process.cwd(), extra);

  if (sub === "list" || sub === "status") {
    if (ctx.json) {
      ctx.out(JSON.stringify(sources, null, 2));
      return 0;
    }
    if (sources.length === 0) {
      ctx.out("no importable sources found (looked for CLAUDE.md, AGENTS.md, CONTEXT.md, wayfinder/, and --from <db>)");
      return 0;
    }
    for (const s of sources) ctx.out(`${s.kind.padEnd(8)} ${s.path}  (${s.detail})`);
    ctx.out(`\nrun: ai-memory import run --write`);
    return 0;
  }

  if (sub !== "run") {
    ctx.err(`import: unknown subcommand "${sub}" (list | run)`);
    return 2;
  }

  const only = str(flags, "source");
  const write = bool(flags, "write");
  const limit = Number(str(flags, "limit") ?? 200) || 200;
  const scope = (str(flags, "scope") as MemoryScope | undefined) ?? "shared";
  const agent = resolveAgent(str(flags, "agent"));
  const namespace = resolveWriteKey({ agent, scope });

  const chosen: ImportSource[] = only ? sources.filter((s) => s.id.includes(only) || s.path.includes(only)) : sources;
  if (chosen.length === 0) {
    ctx.err(`import: no source matched "${only}"`);
    return 1;
  }

  const svc = new MemoryService({ dbPath: str(flags, "db") });
  await svc.init();
  try {
    const report: { source: string; found: number; saved: number; sample: string[] }[] = [];
    for (const src of chosen) {
      const items = await readSource(src);
      const sample = items.slice(0, 3).map((i) => i.text.slice(0, 120));
      let saved = 0;
      if (write) {
        for (const item of items.slice(0, limit)) {
          await svc.save({
            namespace,
            text: item.text,
            type: item.type,
            importance: item.importance,
            tags: item.tags,
            source: item.source
          });
          saved++;
        }
      }
      report.push({ source: src.id, found: items.length, saved, sample });
      if (!ctx.json) {
        ctx.out(`${src.id}: ${items.length} candidate(s)${write ? `, ${saved} processed (namespace ${namespace})` : " (dry run; add --write)"}`);
        for (const s of sample) ctx.out(`    · ${s}`);
      }
    }
    if (ctx.json) ctx.out(JSON.stringify({ write, namespace, report }, null, 2));
    return 0;
  } finally {
    await svc.close();
  }
}
