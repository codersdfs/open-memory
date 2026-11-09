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
export type MemoryStatus = "active" | "archived" | "draft";

/** src/core/types.ts:23-48 Memory — the row as the server serializes it. */
export interface Memory {
  id: string;
  namespace: string;
  type: MemoryType;
  /** src/core/types.ts:47 — the project slug this row is filed under; null is unscoped (ADR-0042). */
  project?: string | null;
  /** src/core/types.ts:16 KINDS — decision|convention|gotcha|fact|task|note, derived on write. */
  kind?: string;
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

/** src/core/types.ts:213-219 SearchNearMiss — a candidate the gate rejected, kept for the empty-result story (ADR-0037). */
export interface SearchNearMiss {
  text: string;
  relevance: number;
  bm25: number;
  vector: number;
  coverage: number;
}

/** src/core/types.ts:227-249 SearchDiagnostics — present when the search explains itself (ADR-0037/0039). */
export interface SearchDiagnostics {
  threshold: number;
  partitions: { namespace: string; count: number }[];
  nearMisses: SearchNearMiss[];
  outside?: { namespace: string; count: number }[];
}

/** src/core/types.ts:119-129 SearchResult — `diagnostics` rides along on explain'd searches. */
export interface SearchResult {
  memories: SearchResultItem[];
  tokensUsed: number;
  truncated: boolean;
  summary: string | null;
  agent?: string;
  scopes?: string[];
  diagnostics?: SearchDiagnostics;
}

/**
 * src/api/server.ts:503-505 GET /projects, fed by `listProjects` (src/core/memoryService.ts:433).
 * `project: null` is the ungrouped bucket — rows the process's project resolution left unscoped.
 */
export interface ProjectSummary {
  project: string | null;
  rows: number;
  byKind: Record<string, number>;
  lastActivityAt: number | null;
}

/** src/core/stats.ts:26-29 StatsBucket. */
export interface StatsBucket {
  label: string;
  count: number;
}

/** src/core/stats.ts:56-71 DecayCandidate. */
export interface DecayCandidate {
  id: string;
  type: MemoryType;
  createdAt: number;
  importance: number;
  strength: number;
  /** Retrievals so far — what the hotness preview weighs (src/core/lifecycle/decay.ts). */
  useCount: number;
  isDeleted: number;
  text: string;
  /** `archive` is the default pass (reversible status change); `prune` is the opt-in hard pass. */
  action: 'archive' | 'prune';
}

/** src/core/stats.ts:63-75 PendingConflict — one side of an unjudged contradiction pair (P5). */
export interface PendingConflict {
  id: string;
  type: MemoryType;
  createdAt: number;
  text: string;
  /** The `conflict:*` facets the row carries — the entity(ies) the pair was named after. */
  conflicts: string[];
}

/** src/core/stats.ts:73-97 StatsSummary. */
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
  /** P5 (ADR-0047): live rows wearing a `conflict:*` facet, waiting on an adjudication. */
  pendingConflicts: number;
  pendingConflictRows: PendingConflict[];
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
  /** P2: when the daemon's maintenance pass last ran (epoch ms), null = never. */
  lastMaintenanceAt: number | null;
  /** What the last maintenance pass did, as one line; null = never ran. */
  lastMaintenanceResult: string | null;
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

// P7 (ADR-0049): the console authenticates like every other client. The daemon serves
// its token to nobody — an injected meta tag was tried and removed by review (any
// unauthenticated GET of a static page would hand the live token to a same-machine
// process, the exact threat the boundary exists for) — so the operator pastes the token
// once into the 401 gate (PrincipalGate) and the browser keeps it in localStorage,
// scoped to this origin. An absent stored token sends no header and the server answers
// 401, which is what the gate keys off. Nothing the server renders ever contains it.
const TOKEN_STORAGE_KEY = 'ai-memory-principal';

/** The principal token this browser holds, or null when the gate has not been passed. */
export function storedPrincipalToken(): string | null {
  return localStorage.getItem(TOKEN_STORAGE_KEY);
}

/** Store (or clear) the principal token the console sends on every request. */
export function setStoredPrincipalToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_STORAGE_KEY, token);
  else localStorage.removeItem(TOKEN_STORAGE_KEY);
}

function principalHeaders(): Record<string, string> {
  const token = storedPrincipalToken();
  return token ? { 'x-ai-memory-principal': token } : {};
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { ...principalHeaders(), ...init?.headers } });
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
   * GET /namespaces — ticket 014 D5, served at src/api/server.ts:211 and fed by
   * `store.distinctNamespaces()` (src/core/store/interface.ts:34). App.tsx offers these
   * through a datalist, so the read fan-out (own + shared + legacy) is visible on sight.
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
  decay: (): Promise<{ archived: number; pruned: number; affected: number }> =>
    request('/decay', sendInit('POST')),

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

  /**
   * GET /settings — src/api/server.ts:306-320. Credentials arrive masked (`…` plus the last
   * four characters, src/core/settings.ts:326-328); there is no route that echoes a value.
   */
  getSettings: (): Promise<SettingsPayload> => request("/settings"),

  /**
   * POST /settings — src/api/server.ts:322-353. A flat body of names to values; the route
   * refuses a key the environment already sets (`400 … is set in the environment`) rather
   * than writing a value nothing would read.
   */
  patchSettings: (patch: Record<string, string>): Promise<{ saved: string[]; restartRequired: boolean }> =>
    request("/settings", sendInit("POST", patch)),

  /**
   * POST /settings/adopt-env — src/api/server.ts:358-366, fed by `adoptEnvKeys`
   * (src/core/settings.ts:242). `notAdopted` is what stayed in `.env`; `backupPath` is the
   * `.env.bak` written before anything was commented out.
   */
  adoptEnv: (): Promise<{ adopted: string[]; notAdopted: string[]; backupPath: string | null; restartRequired: true }> =>
    request("/settings/adopt-env", sendInit("POST", {})),

  /** GET /projects — src/api/server.ts:503-505 (ADR-0042: projects are a derived dimension). */
  projects: (): Promise<{ projects: ProjectSummary[] }> => request("/projects"),

  /** POST /brief — src/api/server.ts:485-497, fed by `service.brief` (src/core/types.ts:293-301). */
  brief: (p: { namespace?: string; budgetTokens?: number }): Promise<BriefResult> =>
    request("/brief", sendInit("POST", p)),

  /** GET /graph — src/api/server.ts:442-445, fed by `buildGraph(loadPages(vaultDir()))` (src/core/graph.ts:110). */
  graph: (): Promise<GraphData> => request("/graph"),

  /** GET /positions — src/api/server.ts:446-465; keys are node ids, values canvas coords. */
  positions: (): Promise<Record<string, { x: number; y: number }>> => request("/positions"),

  /** POST /positions — persists one node's canvas coords to `<vault>/.positions.json`. */
  savePosition: (slug: string, x: number, y: number): Promise<{ ok: true; count: number }> =>
    request("/positions", sendInit("POST", { slug, x: Math.round(x), y: Math.round(y) })),

  /** GET /knowledge/:id — src/api/server.ts:565-576; the page's section outline (headings only). */
  knowledgePage: (id: string): Promise<KnowledgePageView> => request(`/knowledge/${encodeURIComponent(id)}`),

  /** GET /agent/status — src/api/server.ts (ADR-0043). `llm:false` keys the console's local mode. */
  agentStatus: (): Promise<AgentStatus> => request("/agent/status"),

  /**
   * POST /agent/chat — src/api/server.ts (ADR-0043). Answers 200 {reply, trace, model} when a
   * key sits on the server's merged seam; 501 {error:"no-model", hint} when it does not — the
   * caller falls back to the deterministic engine in `lib/agent.ts`. 502 carries the loop's
   * failure (endpoint down, non-JSON, did not converge).
   */
  agentChat: (body: AgentChatRequest): Promise<AgentChatResponse> =>
    request("/agent/chat", sendInit("POST", body)),
};

/** src/api/agent.ts sanitizeIncoming — what the wire accepts from the console. */
export interface AgentChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AgentChatRequest {
  messages: AgentChatMessage[];
  /** The picker's partition; the server defaults it. */
  namespace?: string;
}

/** src/api/agent.ts agentStatus. */
export interface AgentStatus {
  llm: boolean;
  model: string | null;
  base: string;
}

/** src/api/agent.ts AgentTraceStep — one executed tool call, in order. */
export interface AgentTraceStep {
  tool: string;
  args: Record<string, unknown>;
  summary: string;
}

export interface AgentChatResponse {
  reply: string;
  trace: AgentTraceStep[];
  model: string;
}

/** src/core/types.ts:293-301 BriefResult — the fields the console renders. */
export interface BriefResult {
  project: string | null;
  text: string;
  tokensUsed: number;
  budgetTokens: number;
  truncated: boolean;
}

/** src/core/graph.ts:14-16 GraphEdge; `mutual` edges are drawn hotter than one-way ones. */
export interface GraphEdge {
  from: string;
  to: string;
  mutual: boolean;
}

/** src/core/graph.ts GraphNode — `folder` is the first path segment ("" at root), `dangling`
 *  marks a link whose target file does not exist. */
export interface GraphNode {
  id: string;
  title: string;
  source: string;
  deg: number;
  dangling: boolean;
  folder: string;
  tags: string[];
  file: string;
}

/** src/core/graph.ts:17 Graph — the whole vault graph; small by design (a repo's wiki). */
export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** src/core/knowledge/view.ts:20-30 KnowledgePageView — the console renders the section outline. */
export interface KnowledgeSectionView {
  key: string;
  heading: string;
  chars: number;
}

export interface KnowledgePageView {
  id: string;
  title: string;
  project: string | null;
  sections: KnowledgeSectionView[];
  links: { from: string; to: string; target: string }[];
  backlinks: { from: string; to: string; target: string }[];
  dangling: { from: string; to: string; target: string }[];
}

/** One entry of `GET /embedding`'s `presets` — the factory's own defaults (ticket 015 D3). */
export interface EmbeddingPreset {
  provider: 'hash' | 'openai' | 'openai-local' | 'nim';
  /**
   * The environment variable this provider reads, **by name**; `null` when none is
   * needed — which since ADR-0048 covers `hash` (no credential exists) and
   * `openai-local` (a key is optional: empty sends no Authorization header).
   */
  keyEnv: string | null;
  model: string | null;
  /** `0` for `openai-local`: the endpoint's model decides, so `EMBEDDING_DIM` is a user setting. */
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
 * src/core/settings.ts:355-369 SettingsEntry — one line of `GET /settings`.
 *
 * `masked` is null for every non-secret key (there is no `value` field at all: a plain
 * setting is not read back either) and for a credential with nothing behind it.
 */
export interface SettingsEntry {
  /** A writable key for every console field; env-only keys appear too, with `writable: false`. */
  name: string;
  kind: "secret" | "plain";
  source: "env" | "file" | "default" | "absent";
  masked: string | null;
  effect: "immediate" | "restart";
  writable: boolean;
}

/** `GET /settings` — src/api/server.ts:306-320. */
export interface SettingsPayload {
  entries: SettingsEntry[];
  settingsPath: string;
  envPath: string;
  /** Measured against what this process serves, the same way `/embedding` measures it. */
  restartRequired: boolean;
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
