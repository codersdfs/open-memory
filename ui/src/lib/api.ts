/**
 * The subset of the HTTP API the console reads, plus one thin `api` object.
 *
 * Types are declared here instead of imported from `src/core/*` on purpose: the
 * console is its own package (own tsconfig, no node types, bundled by vite), and
 * the thing this file must match is the *wire* shape anyway. Every field cites
 * the file and line it was read from, so a rename in `src/core` shows up as a
 * stale citation rather than a silently wrong type.
 *
 * Every call uses an absolute path (`/memories`, never a configured base): the
 * same build then works behind the vite dev proxy and behind `server.ts`.
 */

// src/core/types.ts:1 TYPES
export type MemoryType = "episodic" | "semantic" | "procedural" | "working";
// src/core/types.ts:2 STATUSES
export type MemoryStatus = "active" | "archived" | "draft" | "superseded";

/** src/core/types.ts:23-48 Memory — the row as the server serializes it. */
export interface Memory {
  id: string;
  namespace: string;
  type: MemoryType;
  text: string;
  /**
   * Absent on every HTTP response unless the call passes `embedding=1` — a 384-float
   * vector is ~9 kB and both in-repo consumers discard it after receipt.
   */
  embedding?: number[];
  importance: number;
  strength: number;
  lastUsedAt: number | null;
  source?: string;
  tags?: string[];
  supersedesId?: string | null;
  isDeleted: number; // 0/1
  visibility: "private";
  status: MemoryStatus;
  pin: number; // 0/1
  createdAt: number; // epoch ms
  updatedAt: number;
}

/** src/core/types.ts:109-117 ScoreBreakdown — present only when `explain` was asked for. */
export interface ScoreBreakdown {
  vector: number;
  bm25: number;
  recency: number;
  strength: number;
  pinBoost: number;
  weighted: { vector: number; bm25: number; recency: number; strength: number };
  final: number;
}

/** src/core/types.ts:95-102 SearchResultItem. */
export interface SearchResultItem extends Memory {
  explain?: ScoreBreakdown;
  score: number;
  vectorScore: number;
  bm25Score: number;
  recencyScore: number;
  tokens: number;
}

/** src/core/types.ts:119-129 SearchResult. */
export interface SearchResult {
  memories: SearchResultItem[];
  tokensUsed: number;
  truncated: boolean;
  summary: string | null;
  agent?: string;
  scopes?: string[];
}

/** src/core/stats.ts:26-29 StatsBucket. */
export interface StatsBucket {
  label: string;
  count: number;
}

/** src/core/stats.ts:31-39 DecayCandidate. */
export interface DecayCandidate {
  id: string;
  type: MemoryType;
  createdAt: number;
  importance: number;
  strength: number;
  isDeleted: number;
  text: string;
}

/** src/core/stats.ts:41-59 StatsSummary. */
export interface StatsSummary {
  total: number;
  byType: Record<string, number>;
  byStatus: Record<string, number>;
  active: number;
  deleted: number;
  pinned: number;
  reinforced: number;
  neverUsed: number;
  supersedesLinks: number;
  supersedeHeads: number;
  strength: StatsBucket[];
  age: StatsBucket[];
  decayCandidates: DecayCandidate[];
  textChars: number;
  textTokensEstimate: number;
}

/**
 * What `GET /stats?full=1` actually answers: the summary above plus the base
 * fields every `/stats` response carries and the two extras only `full=1` adds.
 *
 * src/api/server.ts:145-146 base; src/api/server.ts:157 rowsScanned/dbPath/dbBytes.
 */
export interface StatsResponse extends StatsSummary {
  namespace: string;
  embedding: string;
  dim: number;
  rowsScanned: number;
  dbPath: string | null;
  dbBytes: number | null;
}

/** src/core/sessions.ts:23-31 SessionTurn. */
export interface SessionTurn {
  index: number;
  role: string;
  tool: string | null;
  timestamp: number | null;
  isError: boolean;
  text: string;
}

/** src/core/sessions.ts:33-40 SessionInfo. */
export interface SessionInfo {
  /** Root-relative posix path — the id every other call takes. */
  id: string;
  file: string;
  dir: string;
  mtimeMs: number;
  sizeBytes: number;
}

/** src/core/sessions.ts:42-49 SessionFile — what `readSession` returns. */
export interface SessionDetail {
  id: string;
  file: string;
  total: number;
  turns: SessionTurn[];
  truncated: boolean;
}

/** src/api/server.ts:62-82 parseCreate — the body `POST /memories` accepts. */
export interface CreateMemory {
  namespace?: string;
  type: MemoryType;
  text: string;
  importance?: number;
  source?: string;
  tags?: string[];
  supersedesId?: string | null;
  status?: MemoryStatus;
  pin?: 0 | 1;
}

/**
 * src/api/server.ts:84-101 parseSearch.
 *
 * `namespace` stays optional because the server defaults it to `default:default`
 * (src/api/server.ts:89); the console always sends the picker's value.
 */
export interface SearchParams {
  query: string;
  namespace?: string;
  type?: MemoryType;
  k?: number;
  threshold?: number;
  budgetTokens?: number;
  status?: MemoryStatus;
  includeArchived?: boolean;
  includeDraft?: boolean;
  explain?: boolean;
}

/**
 * GET /memories — src/api/server.ts:232-244.
 *
 * The server reads the free-text filter as `q.q ?? q.query`, so `q` is what this
 * client sends and `query` keeps working for anything that used it first.
 */
export interface ListParams {
  namespace?: string;
  type?: MemoryType;
  includeDeleted?: boolean;
  status?: MemoryStatus;
  includeArchived?: boolean;
  includeDraft?: boolean;
  limit?: number;
  offset?: number;
  q?: string;
}

/** The error every non-2xx answer arrives as: `{ error }` per src/api/server.ts:120-123 send(). */
export interface ApiError extends Error {
  status: number;
  body: unknown;
}

function apiError(status: number, body: unknown, message: string): ApiError {
  return Object.assign(new Error(message), { name: "ApiError", status, body }) as ApiError;
}

function serverMessage(body: unknown, status: number): string {
  if (body !== null && typeof body === "object" && "error" in body) {
    const text = (body as { error?: unknown }).error;
    if (typeof text === "string" && text.length > 0) return text;
  }
  return `HTTP ${status}`;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const body: unknown = await res.json().catch(() => null);
  // The server's message is the useful one ("text required (1-5000 chars)"); a
  // generic "request failed" throws that away.
  if (!res.ok) throw apiError(res.status, body, serverMessage(body, res.status));
  return body as T;
}

function sendInit(method: "POST" | "PATCH" | "DELETE", body?: unknown): RequestInit {
  if (body === undefined) return { method };
  return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

// Takes `object`, not `Record<string, ...>`: interfaces have no implicit index
// signature, so `qs(listParams)` would not type-check against a Record.
function qs(params: object): string {
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) sp.set(key, String(value));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

const enc = (id: string) => encodeURIComponent(id);
const memPath = (id: string) => `/memories/${enc(id)}`;

export const api = {
  /** GET /health — src/api/server.ts:131-140. */
  health: (): Promise<{ version: string; [k: string]: unknown }> => request("/health"),

  /**
   * GET /namespaces — added by the server ticket (D5), not in `server.ts` yet.
   * `store.distinctNamespaces()` is at src/core/store/interface.ts:34.
   */
  namespaces: (): Promise<{ namespaces: string[] }> => request("/namespaces"),

  /** GET /stats?full=1 — src/api/server.ts:142-158. */
  stats: (namespace: string, full = true): Promise<StatsResponse> =>
    request(`/stats${qs({ namespace, full: full ? "1" : undefined })}`),

  /** POST /memories/search — src/api/server.ts:191-196. The console always wants the decomposition (D4). */
  search: (p: SearchParams): Promise<SearchResult> =>
    request("/memories/search", sendInit("POST", { ...p, explain: true })),

  /** GET /memories — src/api/server.ts:232-244. */
  list: (p: ListParams): Promise<{ memories: Memory[]; total: number }> => request(`/memories${qs(p)}`),

  /** GET /memories/:id — src/api/server.ts:222-225. */
  get: (id: string): Promise<Memory> => request(memPath(id)),

  /** POST /memories — src/api/server.ts:227-231, answers 201. */
  create: (body: CreateMemory): Promise<Memory> => request("/memories", sendInit("POST", body)),

  /** PATCH /memories/:id — src/api/server.ts:209-221. */
  patchMeta: (id: string, patch: { status?: MemoryStatus; pin?: 0 | 1; isDeleted?: 0 | 1 }): Promise<Memory> =>
    request(memPath(id), sendInit("PATCH", patch)),

  /** DELETE /memories/:id — src/api/server.ts:226-229 (soft delete). */
  remove: (id: string): Promise<{ ok: true }> => request(memPath(id), sendInit("DELETE")),

  /** POST /memories/:id/supersede — src/api/server.ts:203-208, answers 201. */
  supersede: (id: string, body: CreateMemory): Promise<Memory> =>
    request(`${memPath(id)}/supersede`, sendInit("POST", body)),

  /** POST /extract — src/api/server.ts:250-256. */
  extract: (body: unknown): Promise<{ extracted: number; memories: Memory[] }> =>
    request("/extract", sendInit("POST", body)),

  /** POST /decay — src/api/server.ts:183-186. */
  decay: (): Promise<{ pruned: number }> => request("/decay", sendInit("POST")),

  /** GET /sessions — src/api/server.ts:261-268. */
  sessions: (limit?: number, offset?: number): Promise<{ root: string; total: number; sessions: SessionInfo[] }> =>
    request(`/sessions${qs({ limit, offset })}`),

  /** GET /sessions/:id — src/api/server.ts:269-288; `full` lifts the per-turn char clip (src/core/sessions.ts:56-58). */
  session: (id: string, p?: { offset?: number; limit?: number; full?: boolean }): Promise<SessionDetail> =>
    request(`/sessions/${enc(id)}${qs({ offset: p?.offset, limit: p?.limit, full: p?.full ? "1" : undefined })}`),

  /** GET /embedding — added by ticket 015 (D3), not in `src/api/server.ts` yet. */
  embedding: (): Promise<EmbeddingInfo> => request("/embedding"),

  /**
   * POST /embedding — ticket 015 D4. The body is the *environment-variable* vocabulary
   * (`{ EMBEDDING_PROVIDER: "nim", EMBEDDING_DIM: "2048", NIM_EMBED_MODEL: "…" }`), never a
   * key; the write lands in the settings file and the running embedder is untouched (ADR-0009).
   */
  setEmbedding: (
    patch: Partial<Record<string, string>>,
  ): Promise<{ ok: true; needsRestart: true; target: { provider: string; dim: number; model: string | null } }> =>
    request("/embedding", sendInit("POST", patch)),

  /** POST /embedding/reembed — ticket 015 D5. Answers 409 while a job is already running. */
  reembed: (p: { dryRun: boolean }): Promise<ReembedJob> => request("/embedding/reembed", sendInit("POST", p)),

  /** GET /embedding/reembed — the in-memory job, polled while it runs (no SSE). */
  reembedJob: (): Promise<ReembedJob> => request("/embedding/reembed"),
};

/** One entry of `GET /embedding`'s `presets` — the factory's own defaults (ticket 015 D3). */
export interface EmbeddingPreset {
  provider: "hash" | "openai" | "nim";
  /** The environment variable this provider needs, **by name**; `null` for `hash`. */
  keyEnv: string | null;
  model: string | null;
  dim: number;
}

/** The single in-memory migration job (ticket 015 D5). `done`/`total` are 0/0 when idle. */
export interface ReembedJob {
  state: "idle" | "running" | "done" | "error";
  dryRun: boolean;
  scanned: number;
  rewritten: number;
  done: number;
  total: number;
  failed: { id: string; error: string }[];
  startedAt: number | null;
  finishedAt: number | null;
  error: string | null;
}

/**
 * `GET /embedding` — ticket 015 D3. `target` is `null` when what the settings would build
 * is already what is live; `keys` carries variable names and booleans, never a value.
 */
export interface EmbeddingInfo {
  live: { provider: string; dim: number; model: string | null; source: "env" | "settings" | "default" };
  target: { provider: string; dim: number; model: string | null } | null;
  needsRestart: boolean;
  presets: EmbeddingPreset[];
  keys: { env: string; present: boolean }[];
  /** Settings keys the real environment already sets — a write of those is a 400. */
  shadowed: string[];
  settingsPath: string;
  stored: { byVectorDim: Record<string, number>; unreadable: number };
  reembed: ReembedJob;
}
