/**
 * Thin client for the local memory daemon (`src/api/server.ts`).
 *
 * The daemon stays the canonical writer. Every CLI/MCP operation tries it first and
 * silently falls back to an in-process store when it is not running, which is what
 * lets any agent use memory with no setup and still share state once the daemon is up.
 *
 * P7 (ADR-0049): every request this client sends carries the daemon's principal token
 * (read once, lazily, from the memory home's `principal.key` — the same file the daemon
 * binds). A missing file means no header, and the daemon's 401 names the path; this
 * client never guesses a token and never sends one it did not read from disk.
 */

import { PRINCIPAL_HEADER, readPrincipal } from "../core/principal.js";

export type HttpResult<T> = { ok: true; data: T } | { ok: false; status: number; error: string };

/**
 * Unwrap a memory from a daemon response.
 *
 * `{ memory: {...} }` is the current contract; older daemons answered with the bare
 * memory object. Accepting both keeps a newer CLI working against a stale daemon, and
 * — more importantly — turns "unexpected shape" into a loud error instead of the CLI
 * printing `undefined` and reporting success.
 */
export function unwrapMemory<T extends { id: string }>(data: unknown): T {
  if (data && typeof data === "object") {
    const wrapped = (data as { memory?: unknown }).memory;
    if (wrapped && typeof wrapped === "object") return wrapped as T;
    if ("id" in (data as Record<string, unknown>)) return data as T;
  }
  throw new Error(`memory daemon returned an unexpected response: ${JSON.stringify(data)?.slice(0, 120) ?? String(data)}`);
}

export function defaultServerUrl(): string {
  if (process.env.AI_MEMORY_SERVER?.trim()) return process.env.AI_MEMORY_SERVER.replace(/\/$/, "");
  const port = process.env.PORT ?? process.env.MEMORY_PORT ?? "3000";
  const host = process.env.MEMORY_HOST ?? "127.0.0.1";
  return `http://${host}:${port}`;
}

export class MemoryClient {
  constructor(
    private baseUrl = defaultServerUrl(),
    private timeoutMs = Number(process.env.AI_MEMORY_HTTP_TIMEOUT ?? 1500)
  ) {}

  get url(): string {
    return this.baseUrl;
  }

  /**
   * The principal token for this process, read from the key file at most once. Memoized
   * per instance: a hook or a CLI invocation issues a handful of calls against one
   * daemon, and the file does not change under a running client (recover issues a new
   * token, and the next process picks it up — the documented recovery contract).
   */
  private principalToken: string | null | undefined;

  private async token(): Promise<string | null> {
    if (this.principalToken !== undefined) return this.principalToken;
    const principal = await readPrincipal();
    return (this.principalToken = principal?.token ?? null);
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<HttpResult<T>> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      const token = await this.token();
      const headers: Record<string, string> = body === undefined ? {} : { "content-type": "application/json" };
      if (token) headers[PRINCIPAL_HEADER] = token;
      const res = await fetch(this.baseUrl + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctl.signal
      });
      const text = await res.text();
      const parsed = text ? (JSON.parse(text) as unknown) : {};
      if (!res.ok) {
        const msg =
          typeof parsed === "object" && parsed && "error" in parsed
            ? String((parsed as { error: unknown }).error)
            : `HTTP ${res.status}`;
        return { ok: false, status: res.status, error: msg };
      }
      return { ok: true, data: parsed as T };
    } catch (err) {
      return { ok: false, status: 0, error: (err as Error).message };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Liveness probe used to decide daemon-vs-in-process. Never throws. */
  /** The daemon's self-report, or null when nothing answers there. */
  async health(): Promise<{ ok?: boolean; embedding?: string; dim?: number; version?: string } | null> {
    const r = await this.call<{ ok?: boolean; embedding?: string; dim?: number; version?: string }>("GET", "/health");
    return r.ok ? r.data : null;
  }

  async healthy(): Promise<boolean> {
    return (await this.health())?.ok === true;
  }

  get<T>(path: string): Promise<HttpResult<T>> {
    return this.call<T>("GET", path);
  }

  post<T>(path: string, body: unknown): Promise<HttpResult<T>> {
    return this.call<T>("POST", path, body);
  }

  patch<T>(path: string, body: unknown): Promise<HttpResult<T>> {
    return this.call<T>("PATCH", path, body);
  }

  del<T>(path: string): Promise<HttpResult<T>> {
    return this.call<T>("DELETE", path);
  }

  static query(params: Record<string, string | number | boolean | undefined | null>): string {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === "") continue;
      qs.set(k, String(v));
    }
    const s = qs.toString();
    return s ? `?${s}` : "";
  }
}
