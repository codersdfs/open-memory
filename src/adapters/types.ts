import type { AdapterAction } from "./fs.js";

/**
 * One coding agent's integration surface.
 *
 * Every adapter answers the same four questions so `agent link`, `unlink`,
 * `status` and `doctor` can treat them identically:
 *   - where does it read MCP servers from?
 *   - where do its hooks / instruction files live?
 *   - how do I register myself without disturbing existing entries?
 *   - how do I remove exactly what I added?
 */
export interface Adapter {
  id: string;
  label: string;
  /** Best-effort "is this agent installed on this machine". */
  detect(): boolean;
  /** Paths this adapter would touch, for `--dry-run` output. */
  paths(): string[];
  /** Register the MCP server (and instructions file, if it has one). */
  link(opts: { write: boolean }): Promise<AdapterAction[]>;
  /** Remove only the entries this adapter added. */
  unlink(opts: { write: boolean }): Promise<AdapterAction[]>;
  /** Human-readable current state. */
  status(): Promise<{ linked: boolean; detail: string }>;
}

export interface AdapterRegistry {
  get(id: string): Adapter | undefined;
  all(): Adapter[];
  ids(): string[];
}

export function makeRegistry(adapters: Adapter[]): AdapterRegistry {
  const byId = new Map(adapters.map((a) => [a.id, a]));
  return {
    get: (id) => byId.get(id),
    all: () => [...adapters],
    ids: () => [...byId.keys()]
  };
}
