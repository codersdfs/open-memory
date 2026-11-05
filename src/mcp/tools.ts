import type { MemoryService } from "../core/memoryService.js";
import type { Memory, MemoryKind, MemoryType, SearchResult } from "../core/types.js";
import { stripEmbedding } from "../core/types.js";
import { resolveAgent, resolveRequestScope, resolveWriteKey, type MemoryScope } from "../core/scope.js";

/**
 * The tool surface exposed over MCP.
 *
 * Names are `memory_*` on purpose: the pi extension already teaches agents a
 * `memory_search` tool, and cross-agent memory should not force every prompt to be
 * rewritten. Every tool accepts `scope`, because "is this fact mine or everyone's"
 * is the one decision the model must make explicitly.
 */

export interface ToolContext {
  service: MemoryService;
  /** Agent this server is running for (`--agent`, else detection). */
  defaultAgent: string;
  /** Default scope when a call omits it. */
  defaultScope?: MemoryScope;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

const SCOPE_PROP = {
  type: "string",
  enum: ["private", "shared"],
  description:
    "private = only this agent's layer; shared = the cross-agent layer every agent can read. Default: private for writes, both layers for reads."
};

const TYPE_PROP = { type: "string", enum: ["episodic", "semantic", "procedural", "working"] };

const KIND_PROP = {
  type: "string",
  enum: ["decision", "convention", "gotcha", "fact", "task", "note"],
  description:
    "What kind of memory this is. decision/convention/gotcha are never aged out; fact/task/note expire after 90/7/30 days if never used. Omit to let the store classify by wording."
};

const PROJECT_PROP = {
  type: "string",
  description: "Project slug this memory belongs to. Defaults to the repository this server is running in, and null means unscoped."
};

export const MEMORY_TOOLS: McpTool[] = [
  {
    name: "memory_search",
    description:
      "Search long-term memory (this agent's private notes plus the shared cross-agent layer). Returns scored memories and the token budget used. Use before guessing about past decisions, conventions, or user preferences.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to recall." },
        scope: SCOPE_PROP,
        k: { type: "integer", description: "Max memories to return (default 5)." },
        budgetTokens: { type: "integer", description: "Hard token cap for the result (default 800)." },
        threshold: { type: "number", description: "Minimum hybrid score (default 0.35)." },
        type: TYPE_PROP,
        kind: KIND_PROP,
        project: PROJECT_PROP
      },
      required: ["query"]
    }
  },
  {
    name: "memory_brief",
    description:
      "Everything this project already decided, without searching: conventions, decisions, gotchas, open tasks and what happened recently, in one budgeted block. Use it at the start of a session on an existing repository, before asking the user how things work here.",
    inputSchema: {
      type: "object",
      properties: {
        scope: SCOPE_PROP,
        project: PROJECT_PROP,
        budgetTokens: { type: "integer", description: "Hard token cap (default 600)." },
        sinceDays: { type: "integer", description: "How far back `open` and `recent` look (default 14)." }
      }
    }
  },
  {
    name: "memory_remember",
    description:
      "Store one durable fact. Use scope=shared for anything another agent would need (project conventions, commands, environment facts); scope=private for notes that only make sense for this agent or this user.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The memory, self-contained and specific." },
        scope: SCOPE_PROP,
        type: TYPE_PROP,
        kind: KIND_PROP,
        project: PROJECT_PROP,
        importance: { type: "number", description: "0..1, default 0.5." },
        tags: { type: "array", items: { type: "string" } },
        source: { type: "string", description: "Where this came from (file, task, conversation)." }
      },
      required: ["text"]
    }
  },
  {
    name: "memory_list",
    description: "List the most recent memories in the resolved scope(s).",
    inputSchema: {
      type: "object",
      properties: {
        scope: SCOPE_PROP,
        limit: { type: "integer", description: "Default 20." },
        type: TYPE_PROP,
        kind: KIND_PROP,
        project: PROJECT_PROP
      }
    }
  },
  {
    name: "memory_get",
    description: "Fetch one memory by id.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"]
    }
  },
  {
    name: "memory_forget",
    description:
      "Soft-delete a memory (it is kept and can be restored). Use for facts that are wrong or obsolete rather than for tidying.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"]
    }
  },
  {
    name: "memory_knowledge",
    description:
      "Read the knowledge index built from the vault's markdown pages: list pages, show one page's sections and links, expand a page's neighbours, or sync the .md files into memory. Use it to answer \"what do we have written down about X\" and \"what is connected to this page\". `sync` re-reads the vault; everything else is a read.",
    inputSchema: {
      type: "object",
      properties: {
        op: {
          type: "string",
          enum: ["list", "show", "neighbors", "sync"],
          description: "list (default): pages; show: one page; neighbors: pages linked from/to that page; sync: index the vault now."
        },
        id: { type: "string", description: "Page id for show/neighbors." },
        depth: { type: "integer", description: "Neighbour hops for neighbors (1-3, default 1)." },
        dir: { type: "string", description: "Vault directory for sync (default VAULT_DIR or `vault`)." },
        dryRun: { type: "boolean", description: "sync only: report what would change without writing." },
        scope: SCOPE_PROP
      }
    }
  },
  {
    name: "memory_stats",
    description:
      "Counts per scope and type, including archived rows and rows that have never been retrieved, plus which embedding provider is in use.",
    inputSchema: {
      type: "object",
      properties: { scope: SCOPE_PROP, all: { type: "boolean" } }
    }
  }
];

export interface McpToolResult {
  /** Human/model readable block. */
  text: string;
  /** Structured payload for clients that want it. */
  structured: unknown;
  isError?: boolean;
}

const asScope = (v: unknown): MemoryScope | undefined => (v === "shared" ? "shared" : v === "private" ? "private" : undefined);

function renderSearch(r: SearchResult, budget: number): string {
  if (r.memories.length === 0) return "no memories matched";
  const lines = r.memories.map((m) => {
    const flags = [m.type, m.kind, m.namespace, typeof m.score === "number" ? m.score.toFixed(3) : "-"].join("/");
    return `[${m.id}] (${flags}) ${m.text.replace(/\s+/g, " ").trim()}`;
  });
  lines.push(`tokens: ${r.tokensUsed}/${budget}${r.truncated ? " (truncated)" : ""}`);
  return lines.join("\n");
}

/**
 * Count active rows in one partition that have never been retrieved.
 *
 * `lastUsedAt` is not a column `list()` can filter on, so this pages through the
 * partition. It is worth the scan: 308 of 335 rows in the real store have never been
 * retrieved, and that ratio is the difference between a memory and a write-only log.
 */
async function countNeverRetrieved(service: MemoryService, namespace: string): Promise<number> {
  const pageSize = 500;
  let count = 0;
  for (let offset = 0; ; offset += pageSize) {
    const page = await service.list({ namespace, status: "active", limit: pageSize, offset });
    for (const memory of page.memories) if (memory.lastUsedAt === null) count++;
    if (page.memories.length === 0 || offset + page.memories.length >= page.total) return count;
  }
}

/** Dispatch one `tools/call`. Errors become tool results, never protocol failures. */
export async function callTool(ctx: ToolContext, name: string, args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    switch (name) {
      case "memory_search": {
        const query = String(args.query ?? "").trim();
        if (!query) return { text: "memory_search: query is required", structured: null, isError: true };
        const budgetTokens = Number(args.budgetTokens ?? 800);
        const { namespaces } = resolveRequestScope({
          agent: ctx.defaultAgent,
          scope: asScope(args.scope) ?? ctx.defaultScope
        });
        const result = await ctx.service.search({
          query,
          namespaces,
          agent: ctx.defaultAgent,
          type: args.type as MemoryType | undefined,
          kind: args.kind as MemoryKind | undefined,
          project: args.project === undefined ? undefined : args.project === null ? null : String(args.project),
          k: args.k === undefined ? 5 : Number(args.k),
          budgetTokens,
          threshold: args.threshold === undefined ? 0.35 : Number(args.threshold)
        });
        return {
          text: renderSearch(result, budgetTokens),
          structured: { ...result, memories: result.memories.map(stripEmbedding) }
        };
      }

      case "memory_brief": {
        const { namespaces } = resolveRequestScope({
          agent: ctx.defaultAgent,
          scope: asScope(args.scope) ?? ctx.defaultScope
        });
        const sinceDays = args.sinceDays === undefined ? 14 : Math.max(1, Number(args.sinceDays));
        const brief = await ctx.service.brief({
          namespaces,
          project: args.project === undefined ? undefined : args.project === null ? null : String(args.project),
          budgetTokens: args.budgetTokens === undefined ? undefined : Number(args.budgetTokens),
          sinceMs: sinceDays * 24 * 60 * 60 * 1000
        });
        // The brief is written for a prompt, so it is returned verbatim rather than
        // re-rendered here: two renderers would drift, and this one is the contract.
        return {
          text: brief.text,
          structured: {
            ...brief,
            sections: brief.sections.map((s) => ({
              ...s,
              items: s.items.map((item) => ({ ...item }))
            }))
          }
        };
      }

      case "memory_remember": {
        const text = String(args.text ?? "").trim();
        if (!text) return { text: "memory_remember: text is required", structured: null, isError: true };
        const scope = asScope(args.scope) ?? ctx.defaultScope ?? "private";
        const namespace = resolveWriteKey({ agent: ctx.defaultAgent, scope });
        const { memory, decision } = await ctx.service.saveDetailed({
          namespace,
          text,
          type: (args.type as MemoryType | undefined) ?? "semantic",
          kind: args.kind as MemoryKind | undefined,
          project: args.project === undefined ? undefined : args.project === null ? null : String(args.project),
          importance: args.importance === undefined ? undefined : Number(args.importance),
          tags: Array.isArray(args.tags) ? (args.tags as string[]).map(String) : undefined,
          source: args.source === undefined ? `mcp:${ctx.defaultAgent}` : String(args.source)
        });
        // A supersede is the only outcome where an id the model may already have seen is
        // no longer current, so the response has to name it; the other two keep their old
        // wording because existing prompts and logs match on it.
        const head = decision.action === "supersede"
          ? `superseded ${decision.oldId}: ${memory.id}`
          : decision.action === "reinforce"
            ? `already known: ${memory.id}`
            : `stored: ${memory.id}`;
        return {
          text: `${head} → ${memory.namespace}`,
          structured: {
            ...stripEmbedding(memory),
            decision: { action: decision.action, reason: decision.reason, oldId: decision.oldId }
          }
        };
      }

      case "memory_list": {
        const { namespaces } = resolveRequestScope({
          agent: ctx.defaultAgent,
          scope: asScope(args.scope) ?? ctx.defaultScope
        });
        // The same 1..1000 clamp the HTTP GET /memories route applies (server.ts). Without it
        // `limit = -1` slipped through to SQLite as `LIMIT -1` (unlimited), the layers each
        // returned everything, and the `.slice(0, limit)` below silently dropped the OLDEST row
        // — a new shape of wrong. A non-numeric limit is refused by name rather than reaching
        // the store, where it would fail open to an empty page on the in-memory backend and a
        // type error on SQLite one — two backends, two behaviors.
        const rawLimit = args.limit === undefined ? 20 : Number(args.limit);
        if (!Number.isFinite(rawLimit)) {
          return { text: "memory_list: limit must be a finite number", structured: null, isError: true };
        }
        const limit = Math.max(1, Math.min(1000, Math.floor(rawLimit)));
        // One page per resolved namespace, each ordered `pin DESC, created_at DESC, id ASC` by
        // the store — the SAME tie-broken key the merge below uses, so the global top-`limit` is
        // genuinely a subset of the union of the per-layer top-`limit` pages: a row not in its
        // own partition's first `limit` (that exact key, no loose tie) cannot be in the merged
        // first `limit`. Fetching the layers concurrently mirrors the cross-partition search
        // fan-out (ADR-0007); `withVectors: false` because every embedding is stripped a few
        // lines below (ADR-0030 — same reasoning, an index read that never sees a vector).
        const pages = await Promise.all(namespaces.map((ns) =>
          ctx.service.list({
            namespace: ns,
            type: args.type as MemoryType | undefined,
            kind: args.kind === undefined ? undefined : String(args.kind),
            project: args.project === undefined ? undefined : args.project === null ? null : String(args.project),
            limit,
            withVectors: false
          })
        ));
        const memories: Memory[] = [];
        let total = 0;
        for (const page of pages) {
          memories.push(...page.memories);
          total += page.total;
        }
        // Re-order across the layers into one scope-wide sequence, then apply the caller's cap
        // once. Concatenating the pages, as this did, returned up to `limit × layers` rows *and*
        // put every private row ahead of every shared one regardless of age — the opposite of the
        // tool's promise: "list the most recent memories in the resolved scope(s)". The id
        // tie-break matches the store, so the merged order is byte-stable for a fixed store.
        const recent = memories
          .sort((a, b) => (b.pin - a.pin) || (b.createdAt - a.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
          .slice(0, limit);
        const text =
          recent.length === 0
            ? "no memories"
            : recent
                .map((m) => `[${m.id}] (${m.type}/${m.namespace}) ${m.text.replace(/\s+/g, " ").slice(0, 160)}`)
                .join("\n") + `\n→ ${recent.length} of ${total}`;
        return { text, structured: { memories: recent.map(stripEmbedding), total, scopes: namespaces } };
      }

      case "memory_get": {
        const id = String(args.id ?? "").trim();
        if (!id) return { text: "memory_get: id is required", structured: null, isError: true };
        // Answers an agent, so a tombstone counts as absent: a forgotten or superseded row
        // must not come back as context. Recovery is `ai-memory restore <id>` (CLI) or the
        // console, both of which read through `get`.
        const memory = await ctx.service.getActive(id);
        if (!memory) return { text: `no memory ${id}`, structured: null, isError: true };
        return { text: `[${memory.id}] (${memory.type}/${memory.namespace})\n${memory.text}`, structured: stripEmbedding(memory) };
      }

      case "memory_forget": {
        const id = String(args.id ?? "").trim();
        if (!id) return { text: "memory_forget: id is required", structured: null, isError: true };
        const memory = await ctx.service.getActive(id);
        if (!memory) return { text: `no memory ${id}`, structured: null, isError: true };
        await ctx.service.delete(id);
        return { text: `forgot ${id}`, structured: { id, deleted: true } };
      }

      case "memory_stats": {
        const { namespaces } = resolveRequestScope({
          agent: ctx.defaultAgent,
          scope: asScope(args.scope) ?? ctx.defaultScope,
          all: args.all === true
        });
        // Archived rows are excluded from `total` (list() hides them by default) and from
        // every retrieval path, so without these two counters an operator cannot see the
        // gap between "rows in the store" and "rows an agent can actually be handed".
        const perScope: Record<
          string,
          {
            total: number;
            byType: Record<string, number>;
            archived: number;
            archivedRatio: number;
            neverRetrieved: number;
            neverRetrievedRatio: number;
          }
        > = {};
        for (const ns of namespaces) {
          const byType: Record<string, number> = {};
          for (const t of ["episodic", "semantic", "procedural", "working"] as const) {
            byType[t] = (await ctx.service.list({ namespace: ns, type: t, limit: 1 })).total;
          }
          const total = (await ctx.service.list({ namespace: ns, limit: 1 })).total;
          const archived = (await ctx.service.list({ namespace: ns, status: "archived", limit: 1 })).total;
          const neverRetrieved = await countNeverRetrieved(ctx.service, ns);
          perScope[ns] = {
            total,
            byType,
            archived,
            // Over active+archived rows, the population an operator is deciding whether to
            // restore or clear; `total` alone is only the live half.
            archivedRatio: total + archived === 0 ? 0 : archived / (total + archived),
            neverRetrieved,
            // Over live rows only, because that is the context a caller can reach today.
            neverRetrievedRatio: total === 0 ? 0 : neverRetrieved / total
          };
        }
        const text = namespaces
          .map((ns) => {
            const s = perScope[ns]!;
            const archivedNote = s.archived > 0 ? ` (+${s.archived} archived)` : "";
            return `${ns}: ${s.total}${archivedNote} — never retrieved ${s.neverRetrieved}/${s.total}`;
          })
          .join("\n");
        return {
          text,
          structured: { scopes: namespaces, perScope, embedding: ctx.service.embedder.name, dim: ctx.service.embedder.dim }
        };
      }

      case "memory_knowledge": {
        const op = String(args.op ?? "list");
        const { namespaces } = resolveRequestScope({
          agent: ctx.defaultAgent,
          scope: asScope(args.scope) ?? ctx.defaultScope
        });
        const id = args.id === undefined ? "" : String(args.id);

        if (op === "sync") {
          const report = await ctx.service.syncKnowledge({
            dir: args.dir === undefined ? undefined : String(args.dir),
            dryRun: args.dryRun === true
          });
          const head = report.dryRun ? "dry run — nothing written" : "synced";
          return {
            text:
              `${head}: ${report.pages} page(s), ${report.sections} section(s) → ` +
              `${report.inserted} new, ${report.updated} updated, ${report.unchanged} unchanged, ` +
              `${report.removed} removed, ${report.dangling} dangling link(s), ${report.embedCalls} embedding call(s)`,
            structured: report
          };
        }

        if (op === "show" || op === "neighbors") {
          if (!id) return { text: `memory_knowledge: id is required for ${op}`, structured: null, isError: true };
          if (op === "neighbors") {
            const result = await ctx.service.knowledgeNeighbors({ namespaces, id, depth: args.depth === undefined ? 1 : Number(args.depth) });
            return {
              text: result.neighbors.length === 0
                ? `${id} has no neighbours`
                : `neighbours of ${id}:\n${result.neighbors.map((p) => `- [${p.id}] ${p.title}`).join("\n")}`,
              structured: result
            };
          }
          const page = await ctx.service.knowledgePage({ namespaces, id });
          if (!page) return { text: `unknown knowledge page: ${id}`, structured: null, isError: true };
          const lines = [
            `[${page.id}] ${page.title}`,
            ...page.sections.map((s) => `- ${s.key}: ${s.heading || "(preamble)"} (${s.chars} chars)`),
            page.links.length > 0 ? `links: ${page.links.map((e) => e.target).join(", ")}` : "links: none",
            page.backlinks.length > 0 ? `backlinks: ${page.backlinks.map((e) => e.from).join(", ")}` : "backlinks: none"
          ];
          return { text: lines.join("\n"), structured: page };
        }

        const index = await ctx.service.knowledge({ namespaces });
        return {
          text:
            index.pages.length === 0
              ? "no knowledge pages indexed — run op=sync with the vault directory"
              : index.pages.map((p) => `- [${p.id}] ${p.title} (${p.sections} sections, ${p.links}→ ${p.backlinks}←)`).join("\n") +
                (index.dangling.length > 0 ? `\ndangling: ${index.dangling.map((e) => `${e.from}→${e.target}`).join(", ")}` : ""),
          structured: index
        };
      }

      default:
        return { text: `unknown tool: ${name}`, structured: null, isError: true };
    }
  } catch (err) {
    return { text: `${name} failed: ${(err as Error).message}`, structured: null, isError: true };
  }
}

export function agentDescription(agent: string): string {
  return `ai-memory shared memory (agent: ${resolveAgent(agent)}). Private notes plus a shared layer all agents can read.`;
}
