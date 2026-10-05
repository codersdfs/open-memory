import "../src/config.js";
import { MemoryService } from "../src/core/memoryService.js";
import { resolveDbPath } from "../src/core/dbPath.js";

const ns = process.env.NAMESPACE ?? "default:default";
// Same resolution the server and CLI use. Writing ./memory.db here seeded a
// store nothing read — ADR-0007 moved the default to ~/.ai-memory/memory.db.
const dbPath = resolveDbPath(process.env.MEMORY_DB_PATH);

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
