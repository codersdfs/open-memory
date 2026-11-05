import { existsSync } from "node:fs";
import { ClaudeAdapter } from "./claude.js";
import { GenericAdapter } from "./generic.js";
import { findKnown, KNOWN_AGENTS, type KnownAgent } from "./known.js";
import { readSpecs } from "./specs.js";
import { CodexAdapter } from "./codex.js";
import { DshAdapter } from "./dsh.js";
import { PiAdapter } from "./pi.js";
import { homedir } from "node:os";
import { makeRegistry, type Adapter, type AdapterRegistry } from "./types.js";

export type { Adapter, AdapterRegistry } from "./types.js";
export { ClaudeAdapter } from "./claude.js";
export { CodexAdapter } from "./codex.js";
export { DshAdapter } from "./dsh.js";
export { PiAdapter } from "./pi.js";
export { GenericAdapter } from "./generic.js";
export { KNOWN_AGENTS, ALIASES, detectKnown, findKnown, type KnownAgent } from "./known.js";
export { agentsFilePath, readSpecs, writeSpecs, validateSpec, SERVER_NAME, type AgentSpec } from "./specs.js";
export { mcpCommandSpec, cliEntryPath } from "./fs.js";

/**
 * The agents ADR-0007 promises to support, in the order `agent list` shows them.
 *
 * Three tiers, and the difference is visible to the user:
 *   - **built-in classes** (claude, codex, dsh, pi) always appear, because each one
 *     writes something a declaration cannot express (hooks, TOML, managed block);
 *   - **known clients** (cursor, zed, windsurf, …) always appear too, and say whether
 *     they were detected. They are included even when absent on purpose: `agent list`
 *     is the screen that answers "can ai-memory talk to my editor?", and a client
 *     missing from the list looks like one that is not supported at all. Detection
 *     only decides the installed/not-found column.
 *   - **declarations** come last, so a declared id never shadows a known one.
 *
 * The member set is therefore a pure function of the files on disk, not of what is
 * installed on the machine running the tests — the `home` argument exists so callers
 * and tests can point detection somewhere other than this process's `$HOME`.
 */
export function createRegistry(adapters?: Adapter[], opts: { home?: string } = {}): AdapterRegistry {
  if (adapters) return makeRegistry(adapters);
  const builtIns = defaultAdapters();
  return makeRegistry([...builtIns, ...knownAdapters(builtIns, { includeAll: true, home: opts.home }), ...specAdapters(undefined, builtIns)]);
}

/** Ids a declaration may not take: the built-ins and the known clients own them. */
export function isBuiltIn(id: string): boolean {
  return defaultAdapters().some((a) => a.id === id) || Boolean(findKnown(id));
}

/** Every id `agent --agent` accepts, for error messages that do not lie. */
export function knownAgentIds(): string[] {
  return [...defaultAdapters().map((a) => a.id), ...KNOWN_AGENTS.map((k) => k.id)];
}

/**
 * Known clients as adapters.
 *
 * The default (`includeAll`) returns every known client, detected or not, because the
 * registry's member set should not depend on what happens to be installed: a caller
 * can then list them all and show detection as a column. `includeAll: false` narrows
 * to the detected ones, for callers that only want to act on live installs.
 */
export function knownAdapters(
  builtIns: Adapter[] = defaultAdapters(),
  opts: { includeAll?: boolean; home?: string } = {}
): Adapter[] {
  const reserved = new Set(builtIns.map((a) => a.id));
  const out: Adapter[] = [];
  const home = opts.home;
  const includeAll = opts.includeAll ?? true;
  for (const known of KNOWN_AGENTS) {
    if (reserved.has(known.id)) continue;
    if (!includeAll && !detected(known, home)) continue;
    out.push(knownAdapter(known, home));
  }
  return out;
}

function detected(known: KnownAgent, home?: string): boolean {
  return known.detect(userHome(home)).some((p) => existsSync(p));
}

/**
 * Known clients live under the *user's* home (`~/.cursor`), not under the memory
 * store's home (`~/.ai-memory`). `resolveHome()` names the latter, so using it here
 * pointed every client at `~/.ai-memory/.cursor/mcp.json` — a directory nothing
 * reads — and detection then reported "installed" for folders the store itself had
 * created. The `home` argument exists for tests and for `--home`-style overrides.
 */
function userHome(explicit?: string): string {
  return explicit?.trim() || homedir();
}

/**
 * A known client is a `GenericAdapter` with its label filled in; nothing about how
 * it writes differs from a user declaration, which is the point of specs.ts.
 */
export function knownAdapter(known: KnownAgent, home?: string): Adapter {
  return new GenericAdapter(known.id, known.spec(userHome(home)), known.label, known);
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
 *
 * Known clients are reserved the same way. They are shadowed either way — the
 * registry keeps whichever adapter came first, and `knownAdapters` runs before this
 * function — so the only choice left is whether the declaration is dropped quietly.
 * It must not be: someone who declared `zed` to point at a config in a non-standard
 * place has a declaration that is not doing anything, and only a warning says so.
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
    const known = findKnown(id);
    if (known) {
      const declared = spec.mcpFile;
      const builtInPath = known.spec(homedir()).mcpFile;
      if (declared !== builtInPath) {
        warnOnce(
          `ai-memory: ignoring the declared agent "${id}" — it is a known client, and its own config (${builtInPath}) is ` +
            `linked directly: ai-memory agent link --agent ${id} --write. Declaration pointed at ${declared}.\n`
        );
      }
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
