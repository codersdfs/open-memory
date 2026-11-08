/**
 * Facets: the structure this store gets without a schema change.
 *
 * `tags` already exists and is already queryable, so the write path makes it mean
 * something: a closed prefix vocabulary plus a conservative derivation from the text.
 * A superseding row inherits the facets of the row it replaced, which is what makes a
 * version chain readable as one entity rather than N unrelated sentences.
 */

export const FACET_PREFIXES = ["entity:", "topic:", "path:"] as const;
export const MAX_TAGS = 8;

const MAX_FACET_VALUE = 40;
const MAX_PLAIN_TAG = 80;
const MAX_DERIVED = 5;

const VALUE_KEEP = /[^\p{L}\p{N}._/-]/gu;
const PATH_KEEP = /[^\p{L}\p{N}._/\\:-]/gu;

function slug(value: string, keep: RegExp): string {
  return value.trim().toLowerCase().replace(/\s+/g, "-").replace(keep, "").slice(0, MAX_FACET_VALUE);
}

/**
 * Caller tags, normalised. A known prefix gets a lowercased, slugged value; an unknown
 * tag is kept verbatim because it may be the user's own convention and this module has
 * no business rewriting it.
 *
 * Facets sort before plain tags so the cap drops free-form notes first: the facets are
 * the part other memories are joined on.
 */
export function normalizeTags(tags?: string[]): string[] {
  const facets: string[] = [];
  const plain: string[] = [];
  const seen = new Set<string>();
  for (const raw of tags ?? []) {
    const tag = String(raw ?? "").trim();
    if (!tag) continue;
    const lower = tag.toLowerCase();
    const prefix: string | undefined = FACET_PREFIXES.find((p) => lower.startsWith(p));
    const out = prefix ? prefix + slug(tag.slice(prefix.length), VALUE_KEEP) : tag.slice(0, MAX_PLAIN_TAG);
    if (!out || out === prefix) continue;
    const key = out.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    (prefix ? facets : plain).push(out);
  }
  return [...facets, ...plain].slice(0, MAX_TAGS);
}

/** Backticked identifiers are the one entity signal a sentence states explicitly. */
const BACKTICK = /`([^`\n]{1,80})`/g;
const HANDLE = /(?:^|[\s(])@([\p{L}\p{N}_.-]{2,40})/gu;
const WIN_PATH = /[A-Za-z]:[\\/][^\s`"'\u3000]+/g;
const UNIX_PATH = /(?:[\w.-]+\/)+[\w.-]+/g;

/** `《...》` is how Chinese prose marks a title, and the title is the entity being named. */
const CN_TITLE = /《([^》]{1,60})》/g;
/** CamelCase names a class, package or product explicitly: MemoryService, RustDesk. */
const CAMEL_CASE = /\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+\b/g;
/** Acronyms name things too: MCP, CLI, API. */
const ACRONYM = /\b[A-Z]{2,5}\b/g;
/**
 * All-caps English words are words before they are acronyms. A shouting line ("I WANT TO
 * SHIP THIS …") must not mint an entity per word, and `[a-z]` guard below skips it whole.
 */
const ACRONYM_STOP = new Set([
  "OK", "AM", "PM", "NO", "AN", "AS", "AT", "BE", "BY", "DO", "IF", "IN", "IS", "IT", "ME", "MY", "OF", "ON", "OR", "SO", "TO", "UP", "US", "WE",
  "NOT", "AND", "FOR", "THE", "ALL", "ANY", "NEW", "OLD", "ONE", "TWO", "USE", "CAN", "MAY", "WHY", "HOW", "WHO", "WHAT", "WANT", "SHIP", "THIS",
  "THAT", "WITH", "FROM", "HAVE", "WILL", "JUST", "ONLY", "ALSO", "MORE", "SOME", "SUCH", "WHEN", "WHERE", "THERE", "THEY", "THEN", "THAN", "INTO",
  "OVER", "BEEN", "BOTH", "EACH", "MOST", "MUCH", "VERY", "WELL", "BACK", "NEXT", "LAST", "FIRST"
]);

/**
 * topic: says what a memory is about; entity: says what it names. Both must be derived
 * without a dictionary package, so a topic comes from two deterministic signals: a compact
 * list of domain nouns this store's own text uses, and a word the sentence repeats —
 * repetition is the only frequency signal a single sentence has. A word already used as
 * an entity is skipped: one word cannot be both.
 */
const KNOWN_TOPICS = new Set([
  "sqlite", "sqlite-vec", "postgres", "redis", "qdrant", "embedding", "embeddings", "vector", "vectors",
  "retrieval", "search", "memory", "database", "db", "api", "cli", "mcp", "http", "json", "yaml", "toml",
  "git", "github", "docker", "kubernetes", "linux", "windows", "wsl", "node", "typescript", "javascript",
  "python", "rust", "react", "vite", "vitest", "npm", "pnpm", "yarn", "fastify", "server", "daemon",
  "extractor", "prompt", "token", "tokens", "cache", "bench", "benchmark", "test", "tests", "migration",
  "schema", "sql", "llm", "model", "models", "config", "env", "ui", "tui", "plugin", "extension", "agent",
  "agents", "subagent", "supersede", "facets", "tags", "decay", "lifecycle"
]);
/** Latin function words carry no topic. A set, not a dependency. */
const TOPIC_STOP = new Set([
  "the", "and", "for", "with", "that", "this", "these", "those", "from", "they", "them", "there", "their",
  "then", "than", "when", "what", "which", "while", "where", "who", "whom", "whose", "why", "how", "all",
  "any", "are", "was", "were", "been", "being", "have", "has", "had", "will", "would", "can", "could",
  "should", "may", "might", "must", "not", "but", "or", "if", "so", "as", "at", "by", "in", "on", "of",
  "to", "up", "out", "off", "over", "into", "onto", "about", "after", "before", "also", "just", "only",
  "more", "most", "much", "very", "well", "back", "next", "last", "first", "some", "such", "each", "both",
  "does", "did", "done", "get", "got", "make", "made", "use", "used", "uses", "using", "like", "need",
  "want", "work", "works", "thing", "things", "new", "old", "same", "other", "another", "here", "now",
  "today", "yesterday", "tomorrow", "into", "onto", "its", "it's", "you", "your", "our", "we", "they're"
]);
const WORD = /[A-Za-z][A-Za-z0-9.+#_-]{2,}/g;
const MAX_TOPICS = 2;

function deriveTopicValues(text: string, entityValues: Set<string>): string[] {
  // Paths and slash pairs are structure, not subjects; leaving segments like "src" and
  // "memory" in the word stream would mint topics from a filename.
  const topical = text.replace(WIN_PATH, " ").replace(UNIX_PATH, " ");
  const words = new Map<string, { count: number; index: number }>();
  for (const m of topical.matchAll(WORD)) {
    const value = slug(m[0], VALUE_KEEP);
    if (!value || value.length < 3 || TOPIC_STOP.has(value)) continue;
    const known = words.get(value);
    if (known) known.count += 1;
    else words.set(value, { count: 1, index: m.index ?? 0 });
  }
  const out: string[] = [];
  const add = (value: string): void => {
    if (out.length >= MAX_TOPICS || entityValues.has(value)) return;
    if (out.includes(`topic:${value}`)) return;
    out.push(`topic:${value}`);
  };
  // Domain nouns first, in the order the sentence names them.
  for (const [value] of [...words].sort((a, b) => a[1].index - b[1].index)) {
    if (KNOWN_TOPICS.has(value)) add(value);
  }
  // Then words the sentence repeats, most repeated first. A single mention outside the
  // domain list is too weak a signal: it is usually a verb ("shipped", "edited").
  const repeated = [...words]
    .filter(([, s]) => s.count >= 2)
    .sort((a, b) => b[1].count - a[1].count || b[0].length - a[0].length || a[1].index - b[1].index);
  for (const [value] of repeated) add(value);
  return out;
}

/**
 * Facets the text states itself. Deliberately narrow on entities: backticks, @handles,
 * Chinese titles, CamelCase and acronyms are explicit naming, not guessing. Guessing at
 * CamelCase produced entities like `The` and `This` before, and a wrong entity joins two
 * unrelated memories. Topics come from domain nouns and repeated words (see
 * deriveTopicValues) and are tried last, so the derivation cap drops a topic before it
 * drops a name.
 */
export function deriveFacets(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const entityValues = new Set<string>();
  const add = (tag: string): void => {
    if (!tag || seen.has(tag) || out.length >= MAX_DERIVED) return;
    seen.add(tag);
    out.push(tag);
    if (tag.startsWith("entity:")) entityValues.add(tag.slice("entity:".length));
  };
  for (const m of text.matchAll(BACKTICK)) {
    const value = slug(m[1], VALUE_KEEP);
    if (value) add(`entity:${value}`);
  }
  for (const m of text.matchAll(HANDLE)) {
    const value = slug(m[1], VALUE_KEEP);
    if (value) add(`entity:${value}`);
  }
  for (const m of text.matchAll(CN_TITLE)) {
    const value = slug(m[1], VALUE_KEEP);
    if (value) add(`entity:${value}`);
  }
  // Lowercase somewhere means prose rather than a shouted line, so acronym mining only
  // runs where it can mean something.
  if (/[a-z]/.test(text)) {
    for (const m of text.matchAll(CAMEL_CASE)) {
      const value = slug(m[0], VALUE_KEEP);
      if (value) add(`entity:${value}`);
    }
    for (const m of text.matchAll(ACRONYM)) {
      if (ACRONYM_STOP.has(m[0])) continue;
      // "CI/CD" and "and/or" are a slash pair, not a name.
      const index = m.index ?? 0;
      if (/[/\\]/.test(text.slice(Math.max(0, index - 2), index + m[0].length + 2))) continue;
      const value = slug(m[0], VALUE_KEEP);
      if (value) add(`entity:${value}`);
    }
  }
  for (const m of text.matchAll(WIN_PATH)) {
    const value = slug(m[0], PATH_KEEP);
    if (value) add(`path:${value}`);
  }
  for (const m of text.matchAll(UNIX_PATH)) {
    const raw = m[0];
    // `[\w.-]+/[\w.-]+` also matches "2026/10/18", "and/or" and "CI/CD". A path
    // needs a hint: a file extension, or an explicit relative/root prefix.
    const looksLikePath = /\.[A-Za-z][A-Za-z0-9]{0,4}$/.test(raw) || /^(\.{1,2}\/|~\/|\/)/.test(raw);
    if (!looksLikePath) continue;
    const value = slug(raw, PATH_KEEP);
    if (value) add(`path:${value}`);
  }
  for (const tag of deriveTopicValues(text, entityValues)) add(tag);
  return out;
}

/** Caller tags first, then what the text states, deduped, capped. */
export function buildTags(text: string, callerTags?: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tag of [...normalizeTags(callerTags), ...deriveFacets(text)]) {
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out.slice(0, MAX_TAGS);
}

/**
 * The tags of a row that are facets — the exact set the `memory_facets` index mirrors
 * (P4, ADR-0046). The store's write paths, the backfill and the invariant test all read
 * their facet set through this one function, so the index and the tags column cannot
 * disagree about what a facet is.
 */
export function facetTagsOf(tags?: string[]): string[] {
  return (tags ?? []).filter(
    (t): t is string => typeof t === "string" && FACET_PREFIXES.some((p) => t.toLowerCase().startsWith(p))
  );
}

/**
 * Tags after a rewrite (`updateEmbedding` — reembed, knowledge sync). The caller's
 * plain tags are the caller's own convention and survive; the facets follow the text,
 * because a facet was derived from the sentence the row used to be and a row whose
 * text moved is about different things now. Same order as `buildTags`/`inheritFacets`:
 * facets first, so the cap drops free-form notes before it drops a join key.
 */
export function rederiveTags(previous: string[] | undefined, text: string): string[] {
  const plain = (previous ?? []).filter(
    (t) => !(typeof t === "string" && FACET_PREFIXES.some((p) => t.toLowerCase().startsWith(p)))
  );
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tag of [...deriveFacets(text), ...plain]) {
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out.slice(0, MAX_TAGS);
}

/**
 * Facets a successor keeps from the row it replaced. `entity:` and `topic:` describe the
 * subject and survive a rewrite; `path:` describes the sentence that happened to mention
 * a file, so it is not inherited.
 */
export function inheritFacets(oldTags: string[] | undefined, newTags: string[]): string[] {
  const isFacet = (t: string): boolean => /^(entity|topic):/i.test(t);
  const out = newTags.filter(isFacet);
  const plain = newTags.filter((t) => !isFacet(t));
  const seen = new Set(out.map((t) => t.toLowerCase()));
  for (const tag of oldTags ?? []) {
    const lower = tag.toLowerCase();
    if (!lower.startsWith("entity:") && !lower.startsWith("topic:")) continue;
    if (seen.has(lower) || out.length >= MAX_TAGS) continue;
    seen.add(lower);
    out.push(tag);
  }
  // Inherited facets outrank the new row's free-form tags: a full tag list must not be
  // what pushes the entity that makes the version chain readable off the end.
  for (const tag of plain) {
    if (out.length >= MAX_TAGS) break;
    out.push(tag);
  }
  return out.slice(0, MAX_TAGS);
}
