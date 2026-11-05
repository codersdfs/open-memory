/**
 * JSONC — JSON with comments and trailing commas.
 *
 * Why this exists: several coding agents store their config in JSONC. Zed's
 * `settings.json` ships a commented header, and VS Code's `settings.json` is
 * documented as JSONC. A plain `JSON.parse` rejects both, and the previous
 * behaviour — refuse to touch the file — turns "one command, any agent" into "edit
 * your editor's config by hand, then find the comma you broke".
 *
 * The job here is twofold, and the second half is the one that matters:
 *   1. **parse** — strip comments and trailing commas so the settings object can be
 *      read and the server map modified;
 *   2. **splice** — write one key back into the *original text* without
 *      re-serializing the file. Round-tripping JSONC through `JSON.stringify` would
 *      delete every comment the user wrote and reformat the whole file; that is a
 *      destructive edit disguised as an install.
 *
 * The splice only needs to be good enough for the shapes these files actually have
 * (a top-level object, nested plain objects), and it verifies its own work: the
 * result is parsed again and compared against the intended object, so a splice that
 * would change anything else is refused rather than written.
 */

export interface JsoncEdit {
  /** The document after the edit. */
  text: string;
  /** False when the desired value is already there — nothing to write. */
  changed: boolean;
}

/** Remove `//` and `/* *\/` comments, honouring string literals. */
export function stripComments(text: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  let escaped = false;
  while (i < text.length) {
    const ch = text[i]!;
    const next = text[i + 1];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      i++;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i++;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** Drop trailing commas before `}` and `]`, honouring string literals. */
export function stripTrailingCommas(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ",") {
      // Look past whitespace and comments to the next significant character.
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j]!)) j++;
      if (text[j] === "}" || text[j] === "]") continue;
    }
    out += ch;
  }
  return out;
}

/** Parse JSONC text. Throws the underlying `JSON.parse` message on real errors. */
export function parseJsonc<T = unknown>(text: string): T {
  const cleaned = stripTrailingCommas(stripComments(text.replace(/^\uFEFF/, "")));
  return JSON.parse(cleaned) as T;
}

/**
 * Locate the byte range of a value in the original text.
 *
 * Scanning a JSONC document by hand is only safe because of what is skipped here:
 * strings (so a `{` inside a URL does not open an object) and comments (so a `}`
 * inside a comment does not close one). Returns null when the path is absent.
 */
interface Span {
  /** Index of the first character of the value. */
  start: number;
  /** Index just past the last character of the value. */
  end: number;
}

/**
 * Advance past whitespace and comments.
 *
 * Deliberately does NOT skip commas. A comma is a member separator, i.e. structure,
 * and a helper that silently steps over structure is how the first version of this
 * file lost track of where a member ended: `findPath` advances member-to-member by
 * calling this after a value, so swallowing the comma there ran the walk past the
 * closing brace and every subsequent offset was garbage. Callers that genuinely face
 * a trailing comma handle it themselves, where the intent is written down.
 */
function skipTrivia(text: string, i: number): number {
  while (i < text.length) {
    const ch = text[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    break;
  }
  return i;
}

/** Index just past the JSON value starting at `i`. */
function valueEnd(text: string, i: number): number {
  const ch = text[i];
  if (ch === '"') return stringEnd(text, i);
  if (ch === "{" || ch === "[") return containerEnd(text, i);
  let j = i;
  while (j < text.length && !/[,\}\]]/.test(text[j]!)) j++;
  while (j > i && /\s/.test(text[j - 1]!)) j--;
  return j;
}

/**
 * Position of the `:` that terminates the key starting at `i`, skipping comments
 * between the key and the colon. Returns -1 when there is none.
 *
 * This has to skip comments rather than plain whitespace: `{ "a" /* note *\/: 1 }`
 * is legal JSONC, and a splicer that stops at the first non-space character would
 * mistake the comment for the value.
 */
function colonAfterKey(text: string, i: number): number {
  let j = i;
  while (j < text.length) {
    const ch = text[j]!;
    if (/\s/.test(ch)) {
      j++;
      continue;
    }
    if (ch === "/" && text[j + 1] === "/") {
      while (j < text.length && text[j] !== "\n") j++;
      continue;
    }
    if (ch === "/" && text[j + 1] === "*") {
      j += 2;
      while (j < text.length && !(text[j] === "*" && text[j + 1] === "/")) j++;
      j += 2;
      continue;
    }
    return ch === ":" ? j : -1;
  }
  return -1;
}

function stringEnd(text: string, i: number): number {
  let j = i + 1;
  while (j < text.length) {
    if (text[j] === "\\") {
      j += 2;
      continue;
    }
    if (text[j] === '"') return j + 1;
    j++;
  }
  return text.length;
}

function containerEnd(text: string, i: number): number {
  const open = text[i]!;
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let j = i;
  while (j < text.length) {
    const ch = text[j]!;
    if (ch === '"') {
      j = stringEnd(text, j);
      continue;
    }
    if (ch === "/" && text[j + 1] === "/") {
      while (j < text.length && text[j] !== "\n") j++;
      continue;
    }
    if (ch === "/" && text[j + 1] === "*") {
      j += 2;
      while (j < text.length && !(text[j] === "*" && text[j + 1] === "/")) j++;
      j += 2;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return j + 1;
    }
    j++;
  }
  return text.length;
}

/**
 * Walk `path` starting at the object whose `{` is at `openIndex`.
 *
 * Returns the span of the final **member** (from the opening quote of its key to the
 * end of its value) — not the span of the value. The distinction matters for
 * removal: cutting out only a value leaves the key behind as `"ai-memory": ,`.
 * `parent` is the span of the member holding the last path segment's object, so a
 * caller that has to create the final key knows which brace to insert into.
 */
function findMember(text: string, openIndex: number, path: string[]): { member: Span | null; parent: Span | null } {
  let containerStart = openIndex;
  let parent: Span | null = null;
  for (let p = 0; p < path.length; p++) {
    const key = path[p]!;
    const isLast = p === path.length - 1;
    let i = skipTrivia(text, containerStart + 1);
    let found: Span | null = null;
    let valueSpan: Span | null = null;
    while (i < text.length) {
      // A `}` here means the object ended without the key.
      if (text[i] === "}") break;
      // A leading comma is a trailing comma from the previous member: structure, skip
      // it deliberately rather than relying on a whitespace helper to do so.
      if (text[i] === ",") {
        i = skipTrivia(text, i + 1);
        continue;
      }
      if (text[i] !== '"') break;
      const memberStart = i;
      const kEnd = stringEnd(text, i);
      const k = parseJsonc<string>(text.slice(i, kEnd));
      const colon = colonAfterKey(text, kEnd);
      if (colon === -1) break;
      const valueStart = skipTrivia(text, colon + 1);
      const vEnd = valueEnd(text, valueStart);
      if (k === key) {
        found = { start: memberStart, end: vEnd };
        valueSpan = { start: valueStart, end: vEnd };
        break;
      }
      i = skipTrivia(text, vEnd);
    }
    if (!found || !valueSpan) return { member: null, parent };
    if (isLast) return { member: found, parent };
    if (text[valueSpan.start] !== "{") return { member: null, parent };
    parent = found;
    containerStart = valueSpan.start;
  }
  return { member: null, parent };
}

function escapeKey(key: string): string {
  return JSON.stringify(key);
}

/**
 * Set `path` to `value` inside JSONC `text`, preserving every byte around it.
 *
 * `indent` is the string used for a newly created nested object (the caller passes
 * the file's own indentation, which is two spaces for every client we know of).
 */
export function setJsoncPath(text: string, path: string[], value: unknown, indent = "  "): JsoncEdit {
  const original = text;
  const current = parseJsonc<Record<string, unknown>>(original);
  const before = JSON.stringify(value);

  // Fast path: already exactly what we want, byte for byte in JSON terms.
  const existing = readPath(current, path);
  if (existing !== undefined && JSON.stringify(existing) === before) {
    return { text: original, changed: false };
  }

  const rootStart = skipTrivia(original, 0);
  if (original[rootStart] !== "{") {
    throw new Error("refusing to edit: the file is not a JSON object");
  }

  const positioned = findMember(original, rootStart, path);
  if (positioned.member) {
    // Replace the value only, keeping the key (and any comment around it) as it is.
    const valueStart = skipTrivia(original, colonAfterKey(original, stringEnd(original, positioned.member.start)) + 1);
    const next = original.slice(0, valueStart) + JSON.stringify(value, null, 2) + original.slice(positioned.member.end);
    assertEditIsExact(next, path, value);
    return { text: next, changed: true };
  }

  // Missing path: create the chain. Only the deepest level inserts into an object
  // that already exists; the intermediate levels are new, so they are rendered whole.
  // `parent` is a *member* span, so the container its value starts in is the `{` just
  // after its key.
  const missing = path.slice(path.length - (positioned.parent ? 1 : path.length));
  const parentOpen = positioned.parent
    ? skipTrivia(original, colonAfterKey(original, stringEnd(original, positioned.parent.start)) + 1)
    : rootStart;
  const closeIndex = containerEnd(original, parentOpen);
  const bodyStart = parentOpen + 1;
  const existingMembers = original.slice(bodyStart, closeIndex - 1).replace(/\s+$/, "");

  // Rebuild the member list by lines: keep the existing members verbatim (comments
  // included), add a comma to the last one, then append the new member. Doing it
  // this way means the separator decision is made once, from whether the object was
  // empty — the earlier "trim + append" version emitted a second brace and a stray
  // comma whenever the object already had members.
  const indentUnit = indent;
  const closingIndent = lineIndentOf(original, parentOpen) + indentUnit;
  const append =
    (existingMembers.trim() === "" ? "" : ",") + "\n" + closingIndent + indentUnit + buildNested(missing, value, indent, 1) + "\n" + closingIndent;
  const next = original.slice(0, bodyStart) + existingMembers + append + original.slice(closeIndex - 1);
  assertEditIsExact(next, path, value);
  return { text: next, changed: true };
}

/** Whitespace between the start of the line containing `index` and `index`. */
function lineIndentOf(text: string, index: number): string {
  let lineStart = index;
  while (lineStart > 0 && text[lineStart - 1] !== "\n") lineStart--;
  const prefix = text.slice(lineStart, index);
  return /^[ \t]*$/.test(prefix) ? prefix : "";
}

/**
 * Render `path: value` as JSON text lines beginning at relative `depth`, where depth 1
 * means "one indent unit inside the enclosing brace".
 *
 * The body is indented one level deeper than the member's own line, because a member
 * sits inside the line it starts: at depth 1 the line is `    "k": {`, so its contents
 * are at three units. Getting this off by one produced nested objects whose inner
 * lines were flush with their own braces — valid JSON, visibly mangled.
 */
function buildNested(path: string[], value: unknown, indent: string, depth: number): string {
  const bodyPad = indent.repeat(depth + 1);
  const body = JSON.stringify(value, null, 2).replace(/\n/g, "\n" + bodyPad);
  if (path.length === 1) return `${escapeKey(path[0]!)}: ${body}`;
  const inner = buildNested(path.slice(1), value, indent, depth + 1);
  return `${escapeKey(path[0]!)}: {\n${indent.repeat(depth + 1)}${inner}\n${indent.repeat(depth)}}`;
}

function readPath(obj: Record<string, unknown>, path: string[]): unknown {
  let cur: unknown = obj;
  for (const key of path) {
    if (!cur || typeof cur !== "object" || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/**
 * Prove the splice changed only what it was asked to.
 *
 * A hand-rolled text edit is the one place a comma can go missing without a type
 * error, so this is the guard that makes it safe to ship: re-parse, then compare
 * the whole document against the intended one. A mismatch throws instead of writing.
 */
function assertEditIsExact(text: string, path: string[], value: unknown): void {
  const reparsed = parseJsonc<Record<string, unknown>>(text);
  const got = readPath(reparsed, path);
  if (JSON.stringify(got) !== JSON.stringify(value)) {
    throw new Error(`refusing to edit: splice did not produce the intended value at ${path.join(".")}`);
  }
}

/** Remove `path` from JSONC `text`, leaving everything else alone. */
export function removeJsoncPath(text: string, path: string[]): JsoncEdit {
  const rootStart = skipTrivia(text, 0);
  if (text[rootStart] !== "{") return { text, changed: false };
  const positioned = findMember(text, rootStart, path);
  if (!positioned.member) return { text, changed: false };
  const before = parseJsonc<Record<string, unknown>>(text);
  if (readPath(before, path) === undefined) return { text, changed: false };

  // `member` spans key-and-value, so cutting it out never leaves a half-member behind.
  // One separator still has to go, and which one depends on position:
  //   - a member follows -> drop the comma *after* it (plus the break, so the line
  //     does not become blank);
  //   - it is last -> drop the comma *before* it plus the break, so the object does
  //     not end with a dangling `,\n  }`.
  let start = positioned.member.start;
  const end = positioned.member.end;

  // Move off the member's line before deciding: the member starts at its key's quote,
  // and the indentation before it belongs to the line, not to the member.
  let lineStart = start;
  while (lineStart > 0 && /[ \t]/.test(text[lineStart - 1]!)) lineStart--;

  let after = end;
  while (after < text.length && /\s/.test(text[after]!)) after++;
  // Skip an intervening comment line before deciding whether a member follows.
  while (text[after] === "/" && (text[after + 1] === "/" || text[after + 1] === "*")) {
    after = skipTrivia(text, after);
    while (after < text.length && /\s/.test(text[after]!)) after++;
  }

  if (text[after] === ",") {
    let stop = after + 1;
    while (stop < text.length && /[ \t]/.test(text[stop]!)) stop++;
    if (text[stop] === "\n") stop++;
    const from = lineStart > 0 && text[lineStart - 1] === "\n" ? lineStart : start;
    const next = text.slice(0, from) + text.slice(stop);
    assertRemoved(next, path);
    return { text: next, changed: true };
  }

  // Last member.
  let back = lineStart - 1;
  while (back >= 0 && /\s/.test(text[back]!)) back--;
  if (text[back] === ",") {
    let commaLine = back;
    while (commaLine > 0 && /[ \t]/.test(text[commaLine - 1]!)) commaLine--;
    start = commaLine > 0 && text[commaLine - 1] === "\n" ? commaLine - 1 : back;
  } else {
    start = lineStart > 0 && text[lineStart - 1] === "\n" ? lineStart : start;
  }
  const next = text.slice(0, start) + text.slice(end);
  assertRemoved(next, path);
  return { text: next, changed: true };
}

function assertRemoved(text: string, path: string[]): void {
  const after = parseJsonc<Record<string, unknown>>(text);
  if (readPath(after, path) !== undefined) {
    throw new Error(`refusing to edit: could not remove ${path.join(".")}`);
  }
}

/** Detect whether a file is JSONC rather than strict JSON. Cheap, text-level. */
export function looksLikeJsonc(text: string): boolean {
  try {
    JSON.parse(text.replace(/^\uFEFF/, ""));
    return false;
  } catch {
    // Not strict JSON. If stripping comments makes it parse, it is JSONC.
    try {
      parseJsonc(text);
      return true;
    } catch {
      return false;
    }
  }
}
