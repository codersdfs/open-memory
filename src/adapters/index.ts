import { ClaudeAdapter } from "./claude.js";
import { CodexAdapter } from "./codex.js";
import { DshAdapter } from "./dsh.js";
import { PiAdapter } from "./pi.js";
import { makeRegistry, type Adapter, type AdapterRegistry } from "./types.js";

export type { Adapter, AdapterRegistry } from "./types.js";
export { ClaudeAdapter } from "./claude.js";
export { CodexAdapter } from "./codex.js";
export { DshAdapter } from "./dsh.js";
export { PiAdapter } from "./pi.js";
export { mcpCommandSpec, cliEntryPath } from "./fs.js";

/** The agents ADR-0007 promises to support, in the order `agent list` shows them. */
export function createRegistry(adapters: Adapter[] = defaultAdapters()): AdapterRegistry {
  return makeRegistry(adapters);
}

export function defaultAdapters(): Adapter[] {
  return [new ClaudeAdapter(), new CodexAdapter(), new DshAdapter(), new PiAdapter()];
}
