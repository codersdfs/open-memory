import { MemoryService } from "./core/memoryService.js";

/** Agent ids the scope model understands by convention (any string is legal). */
export const SCOPE_AGENT = ["claude", "codex", "dsh", "pi"] as const;
export type ScopeAgent = (typeof SCOPE_AGENT)[number] | string;

export interface MemoryInput {
  text: string;
  type?: "episodic" | "semantic" | "procedural" | "working";
  importance?: number;
  tags?: string[];
  source?: string;
  scope?: "private" | "shared";
}

export interface RecallOptions {
  limit?: number;
  types?: MemoryInput["type"][];
  scope?: "private" | "shared";
}

export function home(): string {
  return process.env.HOME || process.env.USERPROFILE || ".";
}

export function memDir(env = process.env, homedir = home()): string {
  return env.AI_MEMORY_HOME?.trim() || `${homedir}/.ai-memory`;
}

export function projectKey(cwd = process.cwd()): string {
  const base = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = base.split("/").filter(Boolean);
  const name = parts[parts.length - 1] ?? "root";
  return name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
}

export function serviceFor(cwd = process.cwd()): MemoryService {
  return new MemoryService({ dbPath: process.env.MEMORY_DB_PATH || `${memDir()}/memory.db` });
}

