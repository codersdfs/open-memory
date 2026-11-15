import { countTokens } from "../retrieval/tokens.js";
import type { VectorStore } from "../store/interface.js";
import type { CodebaseSearchItem, CodebaseSearchResult, CodebaseSymbolDetail, CodeSymbolRow } from "./types.js";

/**
 * Reads over the code index (ADR-0050).
 *
 * Symbol search is deterministic, not hybrid: a symbol's name is its content, so
 * exact > prefix > substring > signature, and ties break by exported, then fan-in,
 * then path. No embedding call, no BM25 corpus, and the same query always returns
 * the same rows — what an agent navigating a repository needs is stability, not
 * relevance tuning. Results still answer under a hard token budget, like every
 * other read in this store.
 */

export interface CodebaseSearchOptions {
  project: string;
  query: string;
  k?: number;
  budgetTokens?: number;
}

const DEFAULT_K = 5;
const DEFAULT_BUDGET = 800;
const CANDIDATE_LIMIT = 400;

function scoreSymbol(row: CodeSymbolRow, query: string): number {
  const q = query.toLowerCase();
  const name = row.name.toLowerCase();
  const qualified = row.qualifiedName.toLowerCase();
  if (name === q || qualified === q) return 1;
  if (name.startsWith(q)) return 0.8;
  if (name.includes(q)) return 0.6;
  if (qualified.includes(q)) return 0.5;
  if (row.signature.toLowerCase().includes(q)) return 0.4;
  return 0;
}

const sortKey = (a: CodebaseSearchItem, b: CodebaseSearchItem): number =>
  b.score - a.score ||
  Number(b.exported) - Number(a.exported) ||
  b.fanIn - a.fanIn ||
  a.path.localeCompare(b.path) ||
  a.qualifiedName.localeCompare(b.qualifiedName);

export function renderCodeSymbol(row: CodeSymbolRow, score?: number): string {
  const flags = [row.kind, row.exported ? "exported" : "internal", `in=${row.fanIn}`].join(", ");
  const where = `${row.path}:${row.lineStart ?? 0}`;
  const sig = row.signature ? ` — ${row.signature}` : "";
  return `${row.qualifiedName} (${flags}) ${where}${sig}${score === undefined ? "" : ` [${score.toFixed(2)}]`}`;
}

export async function codebaseSearch(store: VectorStore, opts: CodebaseSearchOptions): Promise<CodebaseSearchResult> {
  const cap = store.codebase;
  if (!cap) throw new Error("codebase memory: this store does not implement the codebase capability");
  const query = opts.query.trim();
  if (!query) return { project: opts.project, symbols: [], tokensUsed: 0, truncated: false };
  const rows = await cap.codeSymbolsMatching(opts.project, query, CANDIDATE_LIMIT);
  const scored: CodebaseSearchItem[] = [];
  for (const row of rows) {
    const score = scoreSymbol(row, query);
    if (score > 0) scored.push({ ...row, score });
  }
  scored.sort(sortKey);
  const k = Math.max(1, opts.k ?? DEFAULT_K);
  const budget = Math.max(1, opts.budgetTokens ?? DEFAULT_BUDGET);
  const picked: CodebaseSearchItem[] = [];
  let tokens = 0;
  let truncated = false;
  for (const item of scored.slice(0, k)) {
    const cost = countTokens(renderCodeSymbol(item)) + 1;
    if (tokens + cost > budget && picked.length > 0) {
      truncated = true;
      break;
    }
    picked.push(item);
    tokens += cost;
  }
  return { project: opts.project, symbols: picked, tokensUsed: tokens, truncated };
}

export interface CodebaseSymbolOptions {
  project: string;
  /** A symbol id, or an exact name. */
  idOrName: string;
}

export async function codebaseSymbolDetail(store: VectorStore, opts: CodebaseSymbolOptions): Promise<CodebaseSymbolDetail | null> {
  const cap = store.codebase;
  if (!cap) throw new Error("codebase memory: this store does not implement the codebase capability");
  const wanted = opts.idOrName.trim();
  if (!wanted) return null;
  let symbol = await cap.codeSymbolById(opts.project, wanted);
  if (!symbol) {
    const matches = (await cap.codeSymbolsMatching(opts.project, wanted, CANDIDATE_LIMIT)).filter((r) => r.name === wanted);
    if (matches.length === 0) return null;
    if (matches.length > 1) {
      const listing = matches
        .slice(0, 8)
        .map((m) => `${m.qualifiedName} (${m.path}:${m.lineStart ?? 0})`)
        .join("; ");
      throw new Error(`ambiguous symbol name "${wanted}" — ${matches.length} matches: ${listing}`);
    }
    symbol = matches[0]!;
  }

  const [inEdges, outEdges] = await Promise.all([
    cap.codeEdges(opts.project, symbol.id, "in"),
    cap.codeEdges(opts.project, symbol.id, "out")
  ]);
  const endpointIds = new Set<string>();
  for (const edge of [...inEdges, ...outEdges]) {
    endpointIds.add(edge.fromId);
    endpointIds.add(edge.toId);
  }
  const endpoints = await cap.codeSymbolsByIds(opts.project, [...endpointIds]);
  const byId = new Map(endpoints.map((r) => [r.id, r] as const));
  const live = (id: string): CodeSymbolRow | null => byId.get(id) ?? null;

  const importers: CodeSymbolRow[] = [];
  const callers: CodeSymbolRow[] = [];
  for (const edge of inEdges) {
    if (edge.toId !== symbol.id) continue;
    const from = live(edge.fromId);
    if (!from) continue;
    if (edge.kind === "imports") importers.push(from);
    else if (from.kind !== "module") callers.push(from);
  }
  const callees: CodeSymbolRow[] = [];
  for (const edge of outEdges) {
    if (edge.kind !== "calls" || edge.fromId !== symbol.id) continue;
    const to = live(edge.toId);
    if (to && to.kind !== "module") callees.push(to);
  }
  const byPath = (a: CodeSymbolRow, b: CodeSymbolRow): number => a.path.localeCompare(b.path) || (a.lineStart ?? 0) - (b.lineStart ?? 0);
  importers.sort(byPath);
  callers.sort(byPath);
  callees.sort(byPath);
  return { symbol, importers, callers, callees };
}
