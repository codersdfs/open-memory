import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Seed fixtures, never into a store the operator did not ask for.
 *
 * `src/config.ts` loads `.env` on import, and this checkout's `.env` contains
 * `MEMORY_DB_PATH=memory.db` — which is exactly how 19 seed/test fixtures ended up in the
 * real store. So read the environment *before* anything can inject `.env` values, and
 * only an explicit `MEMORY_DB_PATH` / `AI_MEMORY_DB` counts as "seed this store".
 * Otherwise this seeds a fresh temp store and prints where it went.
 */
const explicitDbPath = process.env.MEMORY_DB_PATH || process.env.AI_MEMORY_DB;

// Dynamic on purpose: a static import would evaluate config.ts's `loadEnvFile()` before
// the snapshot above, making the checkout's `.env` indistinguishable from an explicit
// choice by the operator. MemoryService imports config itself, so `.env` is still applied
// to the environment — just not before the snapshot.
const { MemoryService } = await import("../src/core/memoryService.js");
const { resolveDbPath } = await import("../src/core/dbPath.js");

const ns = process.env.NAMESPACE ?? "default:default";

let dbPath: string;
let usedTempDir = false;
if (explicitDbPath) {
  // Same resolution the server and CLI use for an explicit path.
  dbPath = resolveDbPath(explicitDbPath);
} else {
  // Fixtures are demo data; a dedicated store per run means `seed` is always safe to run
  // to inspect the UI, and never leaks test rows into a store an agent reads.
  const dir = await mkdtemp(path.join(tmpdir(), "ai-memory-seed-"));
  dbPath = path.join(dir, "memory.db");
  usedTempDir = true;
}
console.log(`db: ${dbPath}${usedTempDir ? " (temporary store; set MEMORY_DB_PATH to seed another one)" : ""}`);

const svc = new MemoryService({ dbPath });
await svc.init();

const samples: { type: "semantic" | "episodic" | "procedural" | "working"; text: string; importance?: number; tags?: string[] }[] = [
  { type: "semantic", text: "user lives in Berlin and prefers answers in German", importance: 0.9, tags: ["user", "geo"] },
  { type: "semantic", text: "user is a TypeScript engineer who hates boilerplate", importance: 0.7, tags: ["user", "pref"] },
  { type: "episodic", text: "2026-08-30: user decided to build a local-first AI memory with sqlite-vec", importance: 0.6, tags: ["project"] },
  { type: "episodic", text: "2026-08-29: we discussed token burning vs context burning and hard budget 800", importance: 0.6 },
  { type: "procedural", text: "How to deploy the memory UI: npm run memory:ui then open localhost:3000", importance: 0.5 },
  { type: "procedural", text: "When user says 'save this', call memory.save with type semantic and importance 0.8", importance: 0.5 },
  { type: "working", text: "current task: inspect memories in the simplest UI", importance: 0.4 },
  { type: "semantic", text: "user's cat is named Mimi", importance: 0.8, tags: ["user"] },
];

for (const s of samples) {
  const m = await svc.save({ namespace: ns, ...s });
  console.log(`seeded ${m.type} ${m.id.slice(0, 8)}: ${m.text}`);
}

const stats = await svc.list({ namespace: ns, limit: 100 });
console.log(`total ${stats.total} in ${ns}`);
svc.close();
