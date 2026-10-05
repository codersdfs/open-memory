import { writeText } from "./fs.js";

/**
 * Tiny TOML section editor.
 *
 * Codex's `~/.codex/config.toml` mixes hand-written comments with machine state and
 * contains literal Windows paths in single-quoted strings. A full TOML round-trip
 * would reformat and re-escape all of it, so instead we operate on *sections*:
 * find the `[mcp_servers.ai-memory]` block and replace/remove only that block,
 * leaving every other byte of the file untouched.
 */

export interface SectionEdit {
  path: string;
  header: string;
  /** Lines of the section body (no header), or null to remove the section. */
  body: string[] | null;
}

function headerMatches(line: string, header: string): boolean {
  return line.trim() === `[${header}]`;
}

function isHeader(line: string): boolean {
  const t = line.trim();
  return t.startsWith("[") && t.endsWith("]");
}

/** Returns [before, sectionLines, after] line arrays; sectionLines includes the header. */
function splitAtSection(lines: string[], header: string): { before: string[]; section: string[] | null; after: string[] } {
  const start = lines.findIndex((l) => headerMatches(l, header));
  if (start === -1) return { before: lines, section: null, after: [] };
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (isHeader(lines[i]!)) {
      end = i;
      break;
    }
  }
  return { before: lines.slice(0, start), section: lines.slice(start, end), after: lines.slice(end) };
}

export function hasSection(content: string, header: string): boolean {
  return splitAtSection(content.split(/\r?\n/), header).section !== null;
}

/**
 * Replace or insert a section. Insertion goes at the end of the file, which is
 * always valid TOML (a table header ends the previous table).
 */
export function upsertSection(content: string, edit: SectionEdit): string {
  const lines = content.split(/\r?\n/);
  const { before, section, after } = splitAtSection(lines, edit.header);
  if (edit.body === null) {
    if (section === null) return content;
    const merged = [...before, ...after];
    return trimBlankRuns(merged);
  }
  const block = [`[${edit.header}]`, ...edit.body];
  if (section !== null) return trimBlankRuns([...before, ...block, ...after]);
  return trimBlankRuns([...lines, "", ...block]);
}

/** Collapse 3+ blank lines to one and drop trailing blanks to a single newline. */
function trimBlankRuns(lines: string[]): string {
  const out: string[] = [];
  for (const line of lines) {
    if (line.trim() === "" && out.length > 0 && out[out.length - 1]!.trim() === "") continue;
    out.push(line);
  }
  while (out.length > 0 && out[out.length - 1]!.trim() === "") out.pop();
  return out.join("\n") + "\n";
}

export function writeToml(path: string, content: string, write: boolean): void {
  writeText(path, content, write);
}

/** TOML literal string: no escaping needed, safe for Windows paths. */
export function tomlLiteral(value: string): string {
  return `'${value.replace(/'/g, "")}'`;
}

export function tomlString(value: string): string {
  return JSON.stringify(value);
}
