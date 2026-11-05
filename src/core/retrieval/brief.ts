import type { VectorStore } from "../store/interface.js";
import type {
  BriefItem,
  BriefOptions,
  BriefResult,
  BriefSection,
  BriefSectionName,
  Memory,
  MemoryKind
} from "../types.js";
import { BRIEF_SECTIONS } from "../types.js";
import { countTokens } from "./tokens.js";
import { KIND_LABELS } from "../write/kind.js";

/**
 * Project brief (ADR-0022): the deterministic "what should I know before I touch
 * this repository".
 *
 * A search is demand-driven and needs a query; the moment a session starts there
 * is no query yet. Making the agent guess one ("search: project overview") is how
 * a memory system ends up unused. So the brief is not a search: it reads the
 * project's durable rows by kind, in a fixed order, and renders them into a fixed
 * budget. Same store, same zero-LLM rule, no ranking surprises between runs.
 *
 * Order is the argument. Conventions first (how to move here), then decisions
 * (what is already settled, newest wins), then gotchas (what costs a day), then
 * open work, then what happened lately. Each section gets a share of the budget
 * and passes an unused share down, so a project with no gotchas spends that space
 * on decisions or recent history rather than returning a short brief.
 */

export const DEFAULT_BRIEF_BUDGET = 600;
export const DEFAULT_SINCE_MS = 14 * 86_400_000;

const SECTION_SHARE: Record<BriefSectionName, number> = {
  conventions: 0.25,
  decisions: 0.3,
  gotchas: 0.2,
  open: 0.15,
  recent: 0.1
};

const SECTION_KIND: Record<BriefSectionName, MemoryKind | null> = {
  conventions: "convention",
  decisions: "decision",
  gotchas: "gotcha",
  open: "task",
  recent: null
};

const SECTION_LIMIT: Record<BriefSectionName, number> = {
  conventions: 12,
  decisions: 12,
  gotchas: 12,
  open: 6,
  recent: 6
};

/** Rows read per section per partition before ranking. Bounded on purpose. */
const FETCH_LIMIT = 80;

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Rank one section. The tie-breaks are ordered and total, because a brief that
 * changes order between two identical runs is a brief nobody can diff.
 */
function rank(name: BriefSectionName, rows: Memory[]): Memory[] {
  const byRecency = name === "decisions" || name === "open" || name === "recent";
  return [...rows].sort((a, b) => {
    if (!byRecency) {
      if (b.importance !== a.importance) return b.importance - a.importance;
    }
    if (b.strength !== a.strength) return b.strength - a.strength;
    if (b.createdAt !== a.createdAt) return b.createdAt - a.createdAt;
    return a.id.localeCompare(b.id);
  });
}

function day(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export interface BriefInput extends BriefOptions {
  namespaces: string[];
}

/**
 * Read + assemble. `namespaces` is resolved by the caller (MemoryService) because
 * partition resolution belongs to scope.ts, not to the renderer.
 */
export async function assembleBrief(store: VectorStore, input: BriefInput): Promise<BriefResult> {
  const budgetTokens = Math.max(60, input.budgetTokens ?? DEFAULT_BRIEF_BUDGET);
  const now = input.now ?? Date.now();
  const since = now - (input.sinceMs ?? DEFAULT_SINCE_MS);
  const project = input.project ?? null;
  const wanted = (input.sections && input.sections.length > 0 ? input.sections : BRIEF_SECTIONS)
    .filter((name): name is BriefSectionName => (BRIEF_SECTIONS as readonly string[]).includes(name));

  const seen = new Set<string>();
  const sections: BriefSection[] = [];
  const counts = Object.fromEntries(BRIEF_SECTIONS.map((n) => [n, 0])) as Record<BriefSectionName, number>;
  let carry = 0;
  let truncated = false;

  for (const name of BRIEF_SECTIONS) {
    if (!wanted.includes(name)) continue;
    const kind = SECTION_KIND[name];
    const collected: Memory[] = [];
    for (const namespace of input.namespaces) {
      const rows = await store.list({
        namespace,
        project,
        kind: kind ?? undefined,
        limit: FETCH_LIMIT,
        status: "active"
      });
      for (const memory of rows.memories) {
        // The init marker (ADR-0042) makes an empty project visible to management;
        // in a brief it would be a permanent "decision" spending budget on itself.
        if (memory.tags?.includes("project:init")) continue;
        // `recent` is deliberately type-shaped: what happened is episodic, and a
        // decision written today already appears above. Re-listing it here would
        // spend the newest-section budget on a duplicate.
        if (name === "recent" && memory.type !== "episodic") continue;
        if (name === "recent" && memory.createdAt < now - 7 * 86_400_000) continue;
        if ((name === "open" || name === "recent") && memory.createdAt < since) continue;
        collected.push(memory);
      }
    }

    const ranked = rank(name, collected);
    const items: BriefItem[] = [];
    let sectionTokens = 0;
    const allowance = Math.floor(budgetTokens * SECTION_SHARE[name]) + carry;
    carry = 0;

    for (const memory of ranked) {
      if (items.length >= SECTION_LIMIT[name]) {
        truncated = true;
        break;
      }
      const key = normalizeText(memory.text);
      if (seen.has(key)) continue;
      if (name === "recent" && memory.importance < 0.5) continue;
      const tokens = countTokens(memory.text);
      if (sectionTokens + tokens > allowance) {
        // Keep going: a shorter row later in the ranking may still fit, and the
        // ordering promise only needs the rows to appear in rank order.
        truncated = true;
        continue;
      }
      seen.add(key);
      items.push({
        id: memory.id,
        kind: memory.kind,
        text: memory.text,
        tokens,
        createdAt: memory.createdAt,
        importance: memory.importance,
        strength: memory.strength,
        namespace: memory.namespace
      });
      sectionTokens += tokens;
    }

    counts[name] = items.length;
    carry = Math.max(0, allowance - sectionTokens);
    sections.push({ name, items, tokens: sectionTokens });
  }

  // The section shares bound the *item* text; headers and the trailer are real tokens
  // too, and this block is prepended to a prompt, so it cannot exceed the caller's cap.
  // Trim from the least important end — the last section's last item — until it fits.
  let text = renderBrief(project, sections, now);
  let tokensUsed = countTokens(text);
  while (tokensUsed > budgetTokens) {
    let last: BriefSection | undefined;
    for (const section of sections) if (section.items.length > 0) last = section;
    if (!last) break;
    const dropped = last.items.pop();
    if (dropped) {
      last.tokens -= dropped.tokens;
      counts[last.name] = last.items.length;
      truncated = true;
    }
    text = renderBrief(project, sections, now);
    tokensUsed = countTokens(text);
  }

  return {
    project,
    text,
    tokensUsed,
    budgetTokens,
    truncated: truncated || tokensUsed > budgetTokens,
    sections,
    counts,
    scopes: input.namespaces
  };
}

/**
 * Render for a prompt, not for a screen: no ids, no scores, one line per memory,
 * a date when the date is the point. Everything a human would want to click on is
 * in the structured `sections`, and the CLI prints it from there.
 */
export function renderBrief(project: string | null, sections: BriefSection[], now: number): string {
  const total = sections.reduce((n, s) => n + s.items.length, 0);
  if (total === 0) {
    return project
      ? `# project ${project}\n(nothing remembered yet)`
      : `# project (unscoped)\n(nothing remembered yet)`;
  }
  const lines: string[] = [project ? `# project ${project}` : `# project (unscoped)`];
  for (const section of sections) {
    if (section.items.length === 0) continue;
    lines.push("");
    for (const item of section.items) {
      const label = KIND_LABELS[item.kind] ?? item.kind;
      const dated = item.kind === "decision" || item.kind === "task";
      lines.push(dated ? `- [${label} ${day(item.createdAt)}] ${item.text}` : `- [${label}] ${item.text}`);
    }
  }
  if (sections.some((s) => s.name === "recent" && s.items.length > 0)) {
    lines.push("", `_as of ${day(now)}_`);
  }
  return lines.join("\n");
}
