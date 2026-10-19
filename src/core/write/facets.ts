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

/**
 * Facets the text states itself. Deliberately narrow: backticks, @handles, paths. Guessing
 * at CamelCase nouns produced entities like `The` and `This`, and an entity tag that is
 * wrong is worse than a missing one — it joins two unrelated memories.
 */
export function deriveFacets(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (tag: string): void => {
    if (!tag || seen.has(tag) || out.length >= MAX_DERIVED) return;
    seen.add(tag);
    out.push(tag);
  };
  for (const m of text.matchAll(BACKTICK)) {
    const value = slug(m[1], VALUE_KEEP);
    if (value) add(`entity:${value}`);
  }
  for (const m of text.matchAll(HANDLE)) {
    const value = slug(m[1], VALUE_KEEP);
    if (value) add(`entity:${value}`);
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
