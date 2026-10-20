import { existsSync, readFileSync } from "node:fs";

/**
 * The managed instructions block — how memory reaches an agent that has no MCP
 * client, and a reminder to the ones that do.
 *
 * One marker pair per file, so a second `agent link` updates the block instead of
 * stacking another one, and `unlink` can find exactly what `link` added.
 */
const BEGIN = "<!-- ai-memory:begin -->";
const END = "<!-- ai-memory:end -->";

export const MANAGED_BLOCK_BEGIN = BEGIN;
export const MANAGED_BLOCK_END = END;

export function renderAgentsBlock(): string {
  return [
    BEGIN,
    "## Memory (ai-memory)",
    "",
    "You have a shared long-term memory available as MCP tools (`memory_search`, `memory_remember`,",
    "`memory_list`, `memory_get`, `memory_forget`, `memory_stats`), and as the `ai-memory` CLI in a shell.",
    "",
    "- Search before guessing about past decisions, project conventions, or user preferences.",
    "- Store durable facts with `memory_remember`. Use `scope: \"shared\"` for anything another agent",
    "  would need; keep agent-specific notes `scope: \"private\"`.",
    "- Never store secrets, tokens, or credentials.",
    END
  ].join("\n");
}

/** Replace the managed block, appending it if absent. Never touches other content. */
export function upsertManagedBlock(content: string, block: string): string {
  const start = content.indexOf(BEGIN);
  const end = content.indexOf(END);
  if (start >= 0 && end > start) {
    return content.slice(0, start) + block + content.slice(end + END.length);
  }
  const sep = content.trim() === "" ? "" : content.endsWith("\n") ? "\n" : "\n\n";
  return content + sep + block + "\n";
}

export function removeManagedBlock(content: string): string {
  const start = content.indexOf(BEGIN);
  const end = content.indexOf(END);
  if (start < 0 || end <= start) return content;
  return (content.slice(0, start) + content.slice(end + END.length)).replace(/\n{3,}/g, "\n\n").trimStart();
}

/** Read a file for managed-block editing; missing is the same as empty. */
export function readManagedFile(file: string): string {
  return existsSync(file) ? readFileSync(file, "utf8").replace(/^\uFEFF/, "") : "";
}
