import { ClaudeAdapter } from "./claude.js";
import { GenericAdapter } from "./generic.js";
import { readSpecs } from "./specs.js";
import { CodexAdapter } from "./codex.js";
import { DshAdapter } from "./dsh.js";
import { PiAdapter } from "./pi.js";
import { makeRegistry, type Adapter, type AdapterRegistry } from "./types.js";

export type { Adapter, AdapterRegistry } from "./types.js";
export { ClaudeAdapter } from "./claude.js";
export { CodexAdapter } from "./codex.js";
export { DshAdapter } from "./dsh.js";
export { PiAdapter } from "./pi.js";
export { GenericAdapter } from "./generic.js";
export { agentsFilePath, readSpecs, writeSpecs, validateSpec, SERVER_NAME, type AgentSpec } from "./specs.js";
export { mcpCommandSpec, cliEntryPath } from "./fs.js";

/** The agents ADR-0007 promises to support, in the order `agent list` shows them. */
export function createRegistry(adapters?: Adapter[]): AdapterRegistry {
  if (adapters) return makeRegistry(adapters);
  const builtIns = defaultAdapters();
  return makeRegistry([...builtIns, ...specAdapters(undefined, builtIns)]);
}

/** Ids a declaration may not take: the built-ins own them. */
export function isBuiltIn(id: string): boolean {
  return defaultAdapters().some((a) => a.id === id);
}

/**
 * Agents the user declared in `~/.ai-memory/agents.json`.
 *
 * A declared id that collides with a built-in is dropped rather than applied. The
 * built-in does more than write an MCP entry — Claude Code's hooks, Codex's TOML
 * section and managed instructions block — so letting a declaration win would
 * silently remove work nobody asked to lose. `agent add` refuses those ids outright;
 * this covers the file edited by hand. A file we cannot parse is reported and
 * ignored too: `agent list` has to answer either way.
 */
export function specAdapters(file?: string, builtIns: Adapter[] = defaultAdapters()): Adapter[] {
  const reserved = new Set(builtIns.map((a) => a.id));
  const { specs, errors } = readSpecs(file);
  for (const error of errors) warnOnce(`ai-memory: ignoring an agent declaration — ${error}\n`);
  const adapters: Adapter[] = [];
  for (const [id, spec] of Object.entries(specs)) {
    if (reserved.has(id)) {
      warnOnce(
        `ai-memory: ignoring the declared agent "${id}" — that id is built in, and a declaration would drop what it does ` +
          `(hooks, managed instructions). Rename the declaration, or link it as it is: ai-memory agent link --agent ${id} --write\n`
      );
      continue;
    }
    adapters.push(new GenericAdapter(id, spec));
  }
  return adapters;
}

export function defaultAdapters(): Adapter[] {
  return [new ClaudeAdapter(), new CodexAdapter(), new DshAdapter(), new PiAdapter()];
}

/**
 * `runAgentCommand` builds a registry per call and `doctor` builds another, so a
 * declaration problem would otherwise be printed two or three times in one command.
 * One process, one warning.
 */
const reported = new Set<string>();
function warnOnce(message: string): void {
  if (reported.has(message)) return;
  reported.add(message);
  process.stderr.write(message);
}
