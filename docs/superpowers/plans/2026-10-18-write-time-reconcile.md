# Write-time reconcile — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every write to the memory store pass through one pure decision function that folds exact duplicates, supersedes refined or contradicted facts, and attaches schema-free facets — without changing the database schema.

**Architecture:** Three new pure modules under `src/core/write/` (`text.ts`, `facets.ts`, `reconciler.ts`). `MemoryService.saveDetailed()` keeps orchestration — resolve namespace, embed, fetch the top-5 neighbours it *already* fetches today, ask `reconcile()`, then `insert` / `reinforce` / `supersede`. One optional jev question classifies a near-hit; everything else is rules. `supersede` reuses the existing `supersedes_id` column and soft delete, so the schema, the MCP tool names and the CLI stay untouched.

**Tech Stack:** TypeScript (ESM, Node >= 22.5), `node:sqlite` via the existing store, vitest, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-18-write-time-reconcile-design.md`

## Global Constraints

- No schema change: no new table, no new column, no migration. `src/core/store/sqlite.ts` is untouched except where a task says otherwise.
- No new runtime dependency; `dependencies` in `package.json` does not change.
- ESM + `.js` suffix on every relative import (`from "./text.js"`).
- New and modified source files are fully typed. `src/core/store/sqlite.ts` keeps its `@ts-nocheck`; do not remove it.
- Tests import from `vitest` explicitly (`import { describe, it, expect } from "vitest"`) — `globals: false`.
- Facet prefixes are exactly `entity:`, `topic:`, `path:`. There is no `session:` prefix in this plan.
- Thresholds: lexical gate `0.80`, cosine gate `0.85`, model margin `0.15`, merge cap `600` chars and `2x` new-text length.
- Merge marker is exactly `(previously: `.
- Knobs are env-only, read per call through `runtimeEnv()`: `MEMORY_RECONCILE` (`off` disables), `MEMORY_RECONCILE_LEX`, `MEMORY_RECONCILE_COS`, `MEMORY_RECONCILE_MARGIN`. They do **not** join `SETTING_KEYS`.
- Commit messages never go on the command line: write the message to `.git/commit-msg.tmp`, then `git commit -F .git/commit-msg.tmp`. Subject style follows `git log`: `feat(write): ...`.

## Review Focus

1. **A near-duplicate of a pinned memory.** A user pins a memory to keep it. A new, similar sentence must be stored separately; the pinned row must never be soft-deleted. (pinned in Task 3)
2. **Identical text in a different namespace.** Two agents hold the same sentence privately. Writing it in one partition must not touch the other. (Task 4)
3. **The hash embedder's ~0.9 cosine on unrelated text.** On a default install every pair looks similar. Unrelated text must not be folded together. (Task 3)
4. **An extractor chunk that contains an explicit memory's words.** Auto-sliced text must not be allowed to delete an agent-authored memory. (Task 3)
5. **A contradicting pair where the old text is very long.** Merging must not triple the stored tokens; past the cap the row keeps the new text and the chain keeps the old one. (Task 1)

---

### Task 1: Text primitives — normalise, tokenise, lexical score, merge

**Files:**
- Create: `src/core/write/text.ts`
- Test: `tests/write-text.test.ts`

**Interfaces:**
- Produces:
  - `normalizeText(text: string): string` — trim, collapse whitespace runs to one space, strip trailing `[.!?。！？]+`, lowercase.
  - `tokenize(text: string): string[]` — lowercase; split on `/[^\p{L}\p{N}]+/u`; a token containing `[\u4e00-\u9fff]` contributes its character bigrams (a 1-char token contributes itself); other tokens are kept when `length >= 2`; drop `STOPWORDS`.
  - `lexicalSimilarity(a: string, b: string): number` — `|setA ∩ setB| / |setA ∪ setB|`, `0` when both empty.
  - `covers(oldText: string, newText: string): boolean` — every old token is present in the new text's token set; `false` when the old text has no tokens.
  - `mergeText(oldText: string, newText: string): string` — per spec 4.3.

- [ ] **Step 1: Write the failing test** `tests/write-text.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { normalizeText, tokenize, lexicalSimilarity, covers, mergeText } from "../src/core/write/text.js";

describe("normalizeText", () => {
  it("folds case, whitespace and trailing punctuation", () => {
    expect(normalizeText("  Use   PNPM!  ")).toBe("use pnpm");
    expect(normalizeText("用 pnpm，不用 npm。")).toBe("用 pnpm，不用 npm");
  });
});

describe("tokenize", () => {
  it("keeps latin words and drops stopwords", () => {
    expect(tokenize("Use the pnpm tool")).toEqual(["use", "pnpm", "tool"]);
  });
  it("emits CJK bigrams so a Chinese sentence never scores zero", () => {
    expect(tokenize("包管理器"))
      .toEqual(expect.arrayContaining(["包管", "管理", "理器"]));
  });
});

describe("lexicalSimilarity", () => {
  it("is 1 for identical meaning after normalisation", () => {
    expect(lexicalSimilarity("use pnpm not npm", "USE pnpm, not NPM!")).toBe(1);
  });
  it("is low for unrelated sentences that share a word", () => {
    expect(lexicalSimilarity("deploy the memory service", "deploy the blog with hugo")).toBeLessThan(0.5);
  });
  it("is 0 when both sides have no tokens", () => {
    expect(lexicalSimilarity("!!!", "???")).toBe(0);
  });
});

describe("covers", () => {
  it("is true only when the new text carries every old token", () => {
    expect(covers("use pnpm", "use pnpm for every install in this repo")).toBe(true);
    expect(covers("use pnpm", "use npm")).toBe(false);
  });
});

describe("mergeText", () => {
  it("adds nothing when the new text already covers the old one", () => {
    expect(mergeText("use pnpm", "use pnpm for every install")).toBe("use pnpm for every install");
  });
  it("keeps the earlier claim behind the marker when it adds information", () => {
    expect(mergeText("use pnpm", "switched to npm yesterday"))
      .toBe("switched to npm yesterday (previously: use pnpm)");
  });
  it("abandons the merge past the 600-char cap", () => {
    const oldText = "x".repeat(500);
    expect(mergeText(oldText, "switched to npm")).toBe("switched to npm");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/write-text.test.ts`
Expected: FAIL — `Cannot find module '../src/core/write/text.js'`.

- [ ] **Step 3: Implement `src/core/write/text.ts`**

Signatures as listed in Interfaces. Keep `STOPWORDS` a small literal `Set` (English function words plus `的 了 是 在 用户`); do not pull a stopword list from a dependency. `mergeText` returns `newText` when the merged candidate exceeds `600` chars **or** `2 x newText.length`.

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run tests/write-text.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

Write `feat(write): text primitives for reconcile` to `.git/commit-msg.tmp`, then:

```bash
git add src/core/write/text.ts tests/write-text.test.ts
git commit -F .git/commit-msg.tmp
```

---

### Task 2: Facets — normalise caller tags, derive from text, inherit on supersede

**Files:**
- Create: `src/core/write/facets.ts`
- Test: `tests/write-facets.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  - `FACET_PREFIXES: readonly ["entity:", "topic:", "path:"]`
  - `MAX_TAGS = 8`
  - `normalizeTags(tags?: string[]): string[]` — trim; drop empties; lowercase the *value* of a known prefix and slugify it (spaces to `-`, keep `[\p{L}\p{N}._/-]`, max 40 chars); keep unknown tags verbatim (trimmed, max 80); dedupe case-insensitively; cap at `MAX_TAGS` with facets first.
  - `deriveFacets(text: string): string[]` — max 5, in this order: backticked identifiers → `` `entity:${slug}` ``; `@handles` → `entity:<handle>`; path-like tokens (`[A-Za-z]:[\\/]\S+` or `\w[\w.-]*(/[\w.-]+)+`) → `path:<lowercased-slug>`.
  - `buildTags(text: string, callerTags?: string[]): string[]` — `normalizeTags(callerTags)` then `deriveFacets(text)`, deduped, capped.
  - `inheritFacets(oldTags: string[] | undefined, newTags: string[]): string[]` — append old `entity:`/`topic:` tags the new set does not already have, capped. `path:` tags are **not** inherited (a path describes the sentence that mentioned it).

- [ ] **Step 1: Write the failing test** `tests/write-facets.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { normalizeTags, deriveFacets, buildTags, inheritFacets, MAX_TAGS } from "../src/core/write/facets.js";

describe("normalizeTags", () => {
  it("slugifies facet values and leaves unknown tags alone", () => {
    expect(normalizeTags(["Entity:Foo Bar", "Deploy Notes"]))
      .toEqual(["entity:foo-bar", "Deploy Notes"]);
  });
  it("drops empties, dedupes, and caps", () => {
    const many = Array.from({ length: 20 }, (_, i) => `topic:t${i}`);
    expect(normalizeTags(["  ", ...many, "TOPIC:t0"])).toHaveLength(MAX_TAGS);
  });
  it("returns [] for undefined", () => {
    expect(normalizeTags(undefined)).toEqual([]);
  });
});

describe("deriveFacets", () => {
  it("turns backticked identifiers into entity facets", () => {
    expect(deriveFacets("the `memoryService` writes rows")).toContain("entity:memoryservice");
  });
  it("turns paths into path facets", () => {
    expect(deriveFacets("edited C:\\memory\\src\\core\\types.ts"))
      .toContain("path:c:\\memory\\src\\core\\types.ts");
  });
  it("derives nothing from a plain sentence", () => {
    expect(deriveFacets("use pnpm for every install")).toEqual([]);
  });
});

describe("buildTags / inheritFacets", () => {
  it("merges caller tags with derived facets", () => {
    expect(buildTags("`memoryService`", ["topic:deploy"]))
      .toEqual(["topic:deploy", "entity:memoryservice"]);
  });
  it("inherits entity and topic but not path", () => {
    const old = ["entity:pnpm", "topic:tooling", "path:c:/x/y.ts"];
    expect(inheritFacets(old, ["entity:pnpm"])).toEqual(["entity:pnpm", "topic:tooling"]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/write-facets.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/core/write/facets.ts`**

One regex per derive source, applied in the documented order, first 5 hits. No model, no dictionary, no tag frequency scan.

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run tests/write-facets.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

Message `feat(write): schema-free facet tags` to `.git/commit-msg.tmp`, then `git add src/core/write/facets.ts tests/write-facets.test.ts && git commit -F .git/commit-msg.tmp`.

---

### Task 3: The reconciler — pure decision function

**Files:**
- Create: `src/core/write/reconciler.ts` (declares `Relation`; `types.ts` is left alone — it carries unrelated uncommitted work)
- Test: `tests/reconciler.test.ts`

**Interfaces:**
- Consumes: `normalizeText`, `lexicalSimilarity`, `covers`, `mergeText` (Task 1); `buildTags`, `inheritFacets` (Task 2).
- Produces:

```ts
export type ReconcileAction = "insert" | "reinforce" | "supersede";
export type ReconcileReason =
  | "no-neighbour" | "exact-duplicate" | "model-duplicate"
  | "refinement" | "model-refines" | "model-contradicts" | "model-unrelated"
  | "model-unavailable" | "extractor-no-delete" | "episodic-no-delete" | "pinned-no-delete";
export type RelationJudge = (oldText: string, newText: string) => Promise<Relation | null>;
export interface ReconcileInput {
  text: string;
  type: MemoryType;
  source?: string;
  callerTags?: string[];
  neighbours: { memory: Memory; vectorScore: number }[];
  embedderKind: string;
  relation?: RelationJudge;
  thresholds?: { lexical?: number; cosine?: number };
}
export interface Decision {
  action: ReconcileAction;
  reason: ReconcileReason;
  oldId?: string;
  text: string;
  tags: string[];
  lexical: number;
}
export const DEFAULT_THRESHOLDS = { lexical: 0.8, cosine: 0.85 } as const;
export async function reconcile(input: ReconcileInput): Promise<Decision>;
```

`Relation` is declared in `src/core/write/reconciler.ts` as `export type Relation = "duplicate" | "refines" | "contradicts";`. The judge imports it from there (`import type`), so the dependency runs one way — judgement → write — and there is no cycle.

**Rule order (exact — later tasks depend on it):**

1. Score every neighbour with `lexicalSimilarity(input.text, n.memory.text)` and `covers(n.memory.text, input.text)`. Keep those passing `lexical >= lex` **or** `covers` **or** (`embedderKind !== "hash"` **and** `vectorScore >= cos`). Containment is part of the gate because Jaccard scores a one-clause extension at 0.67 — exactly the case the refinement rule exists for. Pick the highest `lexical`, tie-break on `vectorScore`.
2. None → `insert` / `no-neighbour`.
3. `normalizeText(input.text) === normalizeText(best.memory.text)` → `reinforce` / `exact-duplicate`.
4. `source === "extractor"` → `insert` / `extractor-no-delete`.
5. `type === "episodic"` → `insert` / `episodic-no-delete`.
6. `best.memory.pin === 1` → `insert` / `pinned-no-delete`.
7. `covers(best.memory.text, input.text)` → `supersede` / `refinement`, text = `mergeText(old, new)`, tags = `inheritFacets(old.tags, buildTags(...))`.
8. `relation` present → await it;
   `null` → `insert` / `model-unavailable`; `duplicate` → `reinforce` / `model-duplicate`; `refines` → `supersede` / `model-refines`; `contradicts` → `supersede` / `model-contradicts`; anything else → `insert` / `model-unrelated`. Supersede decisions use `mergeText` and inherit tags.
9. No `relation` function → `insert` / `model-unavailable`.

Any thrown error from `relation` is caught and treated as `null` — a failed model never blocks or deletes a write.

- [ ] **Step 1: Write the failing test** `tests/reconciler.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { reconcile } from "../src/core/write/reconciler.js";
import type { Memory } from "../src/core/types.js";

function mem(over: Partial<Memory> = {}): Memory {
  return {
    id: "old-1", namespace: "pi:u", type: "semantic", text: "use pnpm not npm",
    embedding: [], importance: 0.8, strength: 0.8, lastUsedAt: null,
    source: "mcp:pi", tags: ["entity:pnpm"], supersedesId: null, isDeleted: 0,
    visibility: "private", status: "active", pin: 0, createdAt: 1, updatedAt: 1, ...over
  };
}

const base = { type: "semantic" as const, embedderKind: "hash", source: "mcp:pi" };

it("inserts when there is no neighbour", async () => {
  const d = await reconcile({ ...base, text: "anything", neighbours: [] });
  expect(d.action).toBe("insert");
  expect(d.reason).toBe("no-neighbour");
});

it("reinforces an exact duplicate", async () => {
  const d = await reconcile({ ...base, text: "USE pnpm, not npm!", neighbours: [{ memory: mem(), vectorScore: 0.9 }] });
  expect(d).toMatchObject({ action: "reinforce", reason: "exact-duplicate", oldId: "old-1" });
});

it("never gates on the hash embedder's ~0.9 cosine", async () => {
  const d = await reconcile({ ...base, text: "deploy the blog with hugo", neighbours: [{ memory: mem(), vectorScore: 0.95 }] });
  expect(d.action).toBe("insert");
});

it("gates on cosine when a real embedder is configured", async () => {
  const d = await reconcile({
    ...base, embedderKind: "nim", text: "we moved off npm",
    neighbours: [{ memory: mem(), vectorScore: 0.9 }],
    relation: async () => "contradicts"
  });
  expect(d).toMatchObject({ action: "supersede", reason: "model-contradicts", oldId: "old-1" });
  expect(d.text).toBe("we moved off npm (previously: use pnpm not npm)");
});

it("supersedes a refinement by rule, without a model", async () => {
  const d = await reconcile({ ...base, text: "use pnpm not npm for every install", neighbours: [{ memory: mem(), vectorScore: 0.9 }] });
  expect(d).toMatchObject({ action: "supersede", reason: "refinement" });
  expect(d.tags).toContain("entity:pnpm");
});

it("leaves an unpinned episodic pair alone", async () => {
  const d = await reconcile({ ...base, type: "episodic", text: "use pnpm not npm today", neighbours: [{ memory: mem({ type: "episodic" }), vectorScore: 0.9 }] });
  expect(d).toMatchObject({ action: "insert", reason: "episodic-no-delete" });
});

it("never deletes a pinned memory", async () => {
  const d = await reconcile({ ...base, text: "use pnpm not npm for every install", neighbours: [{ memory: mem({ pin: 1 }), vectorScore: 0.9 }] });
  expect(d).toMatchObject({ action: "insert", reason: "pinned-no-delete" });
});

it("gives an extractor write no delete privilege, even when it covers the old text", async () => {
  const d = await reconcile({ ...base, source: "extractor", text: "use pnpm not npm for every install", neighbours: [{ memory: mem(), vectorScore: 0.9 }] });
  expect(d).toMatchObject({ action: "insert", reason: "extractor-no-delete" });
});

it("treats a throwing or null judge as insert", async () => {
  const d = await reconcile({
    ...base, embedderKind: "nim", text: "unrelated wording",
    neighbours: [{ memory: mem(), vectorScore: 0.9 }],
    relation: async () => { throw new Error("down"); }
  });
  expect(d).toMatchObject({ action: "insert", reason: "model-unavailable" });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/reconciler.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/core/write/reconciler.ts`** and add `Relation` to `src/core/types.ts`

Implement the rule order above literally, one `if` per rule. Thresholds come from `input.thresholds` merged over `DEFAULT_THRESHOLDS`.

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run tests/reconciler.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

Message `feat(write): pure reconcile decision function` to `.git/commit-msg.tmp`, then `git add src/core/write/reconciler.ts src/core/types.ts tests/reconciler.test.ts && git commit -F .git/commit-msg.tmp`.

---

### Task 4: Wire the reconciler into `MemoryService.saveDetailed()`

**Files:**
- Modify: `src/core/memoryService.ts` (`save`, new `saveDetailed`, `extractAndSave`)
- Test: `tests/save-reconcile.test.ts`

**Interfaces:**
- Consumes: `reconcile`, `Decision` (Task 3); `buildTags` (Task 2); existing `store.vectorSearch`, `store.reinforce`, `store.supersede`, `store.getActive`.
- Produces:

```ts
export interface SaveResult { memory: Memory; decision: Decision }
// on MemoryService
async saveDetailed(input: SaveInput): Promise<SaveResult>;
async save(input: SaveInput): Promise<Memory>;   // unchanged contract
```

`SaveInput` is the existing inline parameter type, extracted to a named exported type so both methods share it. `Decision` is re-exported from `memoryService.ts`.

**Behaviour:**

1. Resolve `namespace` exactly as today.
2. When `runtimeEnv().MEMORY_RECONCILE === "off"`: keep today's exact-text dedup loop verbatim, and return a synthesized decision `{ action: existing ? "reinforce" : "insert", reason: "disabled", oldId?: existing.id }`.
3. Otherwise: embed once, call `store.vectorSearch({ namespace, queryEmbedding, type, limit: 5, includeDeleted: false })` (the call that exists today), then `reconcile()` with thresholds read per call from `MEMORY_RECONCILE_LEX` / `MEMORY_RECONCILE_COS` and `embedderKind: this.embedder.name`.
4. `insert` → `store.insert({ ...input, tags: decision.tags }, embedding)`.
5. `reinforce` → `store.reinforce([decision.oldId!])`, return `store.getActive(decision.oldId!)` (fall back to the newly built object if it vanished).
6. `supersede` → re-embed **only when** `decision.text !== input.text`; then `store.supersede(oldId, { namespace, type, text: decision.text, tags: decision.tags, importance: Math.max(old.importance, input.importance ?? 0.5), source: input.source, status: input.status }, embeddingForStoredText)`; return the created memory.
7. `extractAndSave` uses `saveDetailed` and ignores the decision except for a `[reconcile]` debug log line.

- [ ] **Step 1: Write the failing test** `tests/save-reconcile.test.ts`

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MemoryService } from "../src/core/memoryService.js";
import { InMemoryVectorStore } from "../src/core/store/memory.js";
import { HashEmbeddingProvider } from "../src/core/embedding/hash.js";

const saved = { ...process.env };
afterEach(() => { process.env = { ...saved }; });

let svc: MemoryService;
beforeEach(async () => {
  process.env.MEMORY_RECONCILE = "on";
  process.env.MEMORY_JEV = "false";          // rules only: no network in this file
  svc = new MemoryService({ store: new InMemoryVectorStore(), embedder: new HashEmbeddingProvider(), dedupThreshold: 0.92 });
  await svc.init();
});

const NS = "pi:u";
const active = async () => (await svc.list({ namespace: NS })).memories;

it("folds three restatements of one fact into one row", async () => {
  await svc.saveDetailed({ namespace: NS, type: "semantic", text: "use pnpm not npm" });
  const dup = await svc.saveDetailed({ namespace: NS, type: "semantic", text: "USE pnpm, not npm!" });
  const refined = await svc.saveDetailed({ namespace: NS, type: "semantic", text: "use pnpm not npm for every install" });
  expect(dup.decision.action).toBe("reinforce");
  expect(refined.decision.action).toBe("supersede");
  const rows = await active();
  expect(rows).toHaveLength(1);
  expect(rows[0].text).toBe("use pnpm not npm for every install");
});

it("links the chain and keeps the old row recoverable", async () => {
  const first = await svc.save({ namespace: NS, type: "semantic", text: "use pnpm not npm", tags: ["entity:pnpm"] });
  const second = await svc.save({ namespace: NS, type: "semantic", text: "use pnpm not npm for every install" });
  expect(second.supersedesId).toBe(first.id);
  const tombstone = await svc.get(first.id);
  expect(tombstone?.isDeleted).toBe(1);
  expect(tombstone?.text).toBe("use pnpm not npm");
  expect(second.tags).toContain("entity:pnpm");
});

it("leaves identical text in another namespace untouched", async () => {
  const other = await svc.save({ namespace: "claude:u", type: "semantic", text: "use pnpm not npm" });
  await svc.save({ namespace: NS, type: "semantic", text: "use pnpm not npm for every install" });
  expect((await svc.get(other.id))?.isDeleted).toBe(0);
});

it("keeps episodic and extractor writes append-only", async () => {
  await svc.save({ namespace: NS, type: "episodic", text: "use pnpm not npm today" });
  await svc.save({ namespace: NS, type: "episodic", text: "use pnpm not npm today again" });
  await svc.save({ namespace: NS, type: "semantic", text: "use pnpm not npm", source: "extractor" });
  const extractor = await svc.saveDetailed({ namespace: NS, type: "semantic", source: "extractor", text: "use pnpm not npm for every install" });
  expect(extractor.decision.action).toBe("insert");
  expect(await active()).toHaveLength(4);
});

it("MEMORY_RECONCILE=off restores the old path", async () => {
  process.env.MEMORY_RECONCILE = "off";
  const a = await svc.saveDetailed({ namespace: NS, type: "semantic", text: "use pnpm not npm" });
  const b = await svc.saveDetailed({ namespace: NS, type: "semantic", text: "use pnpm not npm for every install" });
  expect(a.decision.reason).toBe("disabled");
  expect(b.decision.reason).toBe("disabled");
  expect((await active()).length).toBe(2);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/save-reconcile.test.ts`
Expected: FAIL — `svc.saveDetailed is not a function`.

- [ ] **Step 3: Implement `saveDetailed` and delegate `save`** in `src/core/memoryService.ts`

Keep `save`'s doc comment; add one sentence saying it delegates to `saveDetailed` and drops the decision. Do not change `get`, `getActive`, `search`, `supersede`, `list`.

- [ ] **Step 4: Run the new test and the existing suite**

Run: `npx vitest run tests/save-reconcile.test.ts tests/mcp.test.ts tests/api.test.ts tests/store.test.ts tests/extraction.test.ts`
Expected: PASS. If `mcp.test.ts` fails on `already known`, that is Task 5's job — leave the failure only if it is exactly that assertion, and say so in the task log.

- [ ] **Step 5: Commit**

Message `feat(write): reconcile every save through a pure decision` to `.git/commit-msg.tmp`, then `git add src/core/memoryService.ts tests/save-reconcile.test.ts && git commit -F .git/commit-msg.tmp`.

---

### Task 5: Say what happened in `memory_remember`

**Files:**
- Modify: `src/mcp/tools.ts` (`memory_remember` case, around line 164)
- Test: `tests/mcp.test.ts`

**Interfaces:**
- Consumes: `service.saveDetailed()` (Task 4).
- Produces: `memory_remember` result text — exactly one of:
  - `stored: <id> → <namespace>`
  - `already known: <id> → <namespace>` (reinforced)
  - `superseded <oldId>: <newId> → <namespace>`
  `structured` gains `decision: { action, reason, oldId? }` alongside the stripped memory.

- [ ] **Step 1: Write the failing test** — append to `tests/mcp.test.ts`

```ts
it("reports a supersede in the remember response", async () => {
  const first = await call({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "memory_remember", arguments: { text: "use pnpm not npm" } } });
  const firstId = String(JSON.parse(JSON.stringify(first)).result.content[0].text).match(/[0-9a-f-]{36}/)![0];
  const second = await call({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "memory_remember", arguments: { text: "use pnpm not npm for every install" } } });
  const text = JSON.parse(JSON.stringify(second)).result.content[0].text as string;
  expect(text).toMatch(new RegExp(`^superseded ${firstId}: `));
});
```

Run it first to see it fail:

```bash
npx vitest run tests/mcp.test.ts -t "reports a supersede"
```
Expected: FAIL — the response starts with `stored:`.

- [ ] **Step 2: Implement the response**

Switch the `memory_remember` case to `saveDetailed`, then build the text from `decision.action` per the Produces list. Keep the empty-text guard and the `source` default exactly as they are.

- [ ] **Step 3: Run the MCP suite**

Run: `npx vitest run tests/mcp.test.ts`
Expected: PASS. The pre-existing `already known` assertion (if any) must still pass — the reinforce wording is unchanged.

- [ ] **Step 4: Run the whole suite**

Run: `npx vitest run`
Expected: PASS. Any failure here is caused by this task or Task 4; fix before committing.

- [ ] **Step 5: Commit**

Message `feat(mcp): report the reconcile decision on remember` to `.git/commit-msg.tmp`, then `git add src/mcp/tools.ts tests/mcp.test.ts && git commit -F .git/commit-msg.tmp`.

---

### Task 6: `jevRelation` — one noul question, three labels

**Files:**
- Modify: `src/core/judgment/judge.ts` (`systemOneBody` → `systemOneCall`, new `jevRelation`)
- Test: `tests/judge.test.ts` (append)

**Interfaces:**
- Consumes: `Relation` from `src/core/write/reconciler.js` (Task 3, type-only import).
- Produces:

```ts
export interface RelationResult {
  relation: Relation | null;   // null = below the confidence margin
  scores: Record<Relation, number>;
  model?: string;
}
export async function jevRelation(
  oldText: string,
  newText: string,
  opts: JudgeOptions & { margin?: number } = {},
): Promise<RelationResult | null>;   // null = disabled, no key, or the call failed
```

Refactor: `systemOneBody(state, questions, model)` takes a `questions` record (`{ [name]: { type: "noul", instructions, criteria? } }`); `systemOneCall` owns the POST, timeout, retry and fail-open loop that `jevKeep` has today; `jevKeep` becomes a thin caller with the existing `keep` question and must keep returning `Verdict | null` byte-identically. `jevRelation` sends `state = \`OLD: ${oldText}\\nNEW: ${newText}\`` and three noul questions:

- `duplicate` — "Do OLD and NEW state the same fact, such that keeping both would be redundant?"
- `refines` — "Does NEW add detail to OLD while agreeing with it?"
- `contradicts` — "Do OLD and NEW disagree, such that OLD is no longer true?"

Pick the argmax only when `top >= 0.5` **and** `top - second >= margin` (default `0.15`); otherwise `relation = null`. Missing answers count as `0`.

- [ ] **Step 1: Write the failing tests** — append to `tests/judge.test.ts`

```ts
const answers = (scores: Record<string, number>): typeof fetch =>
  (async () => new Response(JSON.stringify({
    model: "jev-test",
    answers: Object.fromEntries(Object.entries(scores).map(([k, v]) => [k, { type: "noul", noul: v }]))
  }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

it("picks the confident relation", async () => {
  useTypesafeKey();
  const r = await jevRelation("use pnpm", "we moved to npm", { fetchImpl: answers({ duplicate: 0.05, refines: 0.1, contradicts: 0.85 }) });
  expect(r?.relation).toBe("contradicts");
});

it("returns a null relation when two labels tie", async () => {
  useTypesafeKey();
  const r = await jevRelation("use pnpm", "we moved to npm", { fetchImpl: answers({ duplicate: 0.6, refines: 0.5, contradicts: 0.1 }) });
  expect(r?.relation).toBeNull();
});

it("returns null without a key, never blocking a write", async () => {
  delete process.env.JEV_API_KEY; delete process.env.JEV_API_KEY_FILE; delete process.env.TYPESAFE_API_KEY;
  expect(await jevRelation("a", "b", { fetchImpl: answers({ duplicate: 0.9 }) })).toBeNull();
});
```

Add the import: `jevRelation` in the existing import from `../src/core/judgment/judge.js`.

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run tests/judge.test.ts -t "relation"`
Expected: FAIL — `jevRelation is not a function`.

- [ ] **Step 3: Refactor and implement** in `src/core/judgment/judge.ts`

No behaviour change to `jevKeep`; the existing `judge.test.ts` cases are the regression proof.

- [ ] **Step 4: Run the judge suite**

Run: `npx vitest run tests/judge.test.ts`
Expected: PASS — old and new cases together.

- [ ] **Step 5: Commit**

Message `feat(judge): classify the relation between two memories` to `.git/commit-msg.tmp`, then `git add src/core/judgment/judge.ts tests/judge.test.ts && git commit -F .git/commit-msg.tmp`.

---

### Task 7: Give the reconciler its model

**Files:**
- Modify: `src/core/memoryService.ts` (pass `relation`)
- Modify: `tests/save-reconcile.test.ts` (new describe block with an injected judge)

**Interfaces:**
- Consumes: `jevRelation` (Task 6); `RelationJudge` (Task 3).
- Produces: `MemoryService` constructor accepts an optional `relation?: RelationJudge` (test seam, same pattern as `store` / `embedder`). When absent and `jevEnabled()`, the service uses `(old, new) => jevRelation(old, new, { margin }).then(r => r?.relation ?? null)`.

- [ ] **Step 1: Write the failing test** — append to `tests/save-reconcile.test.ts`

```ts
// A non-hash stub, because the cosine gate only exists for real embedders and this
// pair is deliberately NOT a token-subset (so the rule path cannot decide it).
const stubEmbedder = {
  name: "nim", dim: 4,
  embed: async () => [1, 0, 0, 0],
  embedBatch: async (texts: string[]) => texts.map(() => [1, 0, 0, 0]),
} as unknown as EmbeddingProvider;

it("supersedes a contradiction once the judge says so", async () => {
  const judged = new MemoryService({
    store: new InMemoryVectorStore(), embedder: stubEmbedder,
    relation: async () => "contradicts",
  });
  await judged.init();
  const old = await judged.save({ namespace: NS, type: "semantic", text: "the API listens on 8787" });
  const next = await judged.saveDetailed({ namespace: NS, type: "semantic", text: "the API now listens on 9090" });
  expect(next.decision.action).toBe("supersede");
  expect(next.decision.reason).toBe("model-contradicts");
  expect(next.memory.supersedesId).toBe(old.id);
  expect(next.memory.text).toBe("the API now listens on 9090 (previously: the API listens on 8787)");
  expect((await judged.get(old.id))?.isDeleted).toBe(1);
});

it("never asks the judge about a below-gate neighbour", async () => {
  let asked = 0;
  const judged = new MemoryService({
    store: new InMemoryVectorStore(), embedder: new HashEmbeddingProvider(),
    relation: async () => { asked++; return "contradicts"; },
  });
  await judged.init();
  await judged.save({ namespace: NS, type: "semantic", text: "deploy the memory service" });
  await judged.save({ namespace: NS, type: "semantic", text: "deploy the blog with hugo" });
  expect(asked).toBe(0);
});
```

Add `import type { EmbeddingProvider } from "../src/core/embedding/provider.js";` to the test's imports.

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run tests/save-reconcile.test.ts -t "judge says so"`
Expected: FAIL — `relation` is not a constructor option.

- [ ] **Step 3: Implement the seam** in `src/core/memoryService.ts`

Read `MEMORY_RECONCILE_MARGIN` per call (default `0.15`). Log `[reconcile] <action> <reason>` once per supersede at `console.warn` only when the reason starts with `model-` — a silent model decision is the one thing that must leave a trace.

- [ ] **Step 4: Run the suite**

Run: `npx vitest run tests/save-reconcile.test.ts tests/reconciler.test.ts tests/judge.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

Message `feat(write): let the relation judge fold contradictions` to `.git/commit-msg.tmp`, then `git add src/core/memoryService.ts tests/save-reconcile.test.ts && git commit -F .git/commit-msg.tmp`.

---

### Task 8: Documentation, ADR, release note

**Files:**
- Create: `docs/adr/0011-write-time-reconcile-schema-free-facets.md`
- Modify: `README.md` (new `## Write reconcile` section after `## Retrieval floors`, about 20 lines)
- Modify: `CHANGELOG.md` (new top entry)

**Interfaces:** No code. Content is fixed by the spec.

- [ ] **Step 1: Write ADR-0011** — sections, matching the shape of the existing ADRs: Status / Options (do nothing, schema v2 with an edges table, reconcile over existing fields — chosen) / Rule table pointer to the spec / Why auto-supersede is safe (soft delete + `supersedes_id` chain + `pinned` guard) / Why `episodic` and `source=extractor` are exempt (D6, D10) / Why the gate is lexical under the hash embedder / Deferred (stage B offline consolidate, stage C read-time expansion, LLM entity extraction, ANN/FTS) / Rollback (`MEMORY_RECONCILE=off`).

- [ ] **Step 2: Write the README section** — 20 lines max: what a write now does, the four knobs with defaults, the three response strings from `memory_remember`, and one measured-later note: "no benchmark claim is made for this stage; stage C is where multi-hop is expected to move."

- [ ] **Step 3: Write the CHANGELOG entry** — under a new `## Unreleased` heading: `feat: write-time reconcile — duplicates reinforce, refinements and contradictions supersede, facets in tags (no schema change)`.

- [ ] **Step 4: Verify the docs build nothing**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: exit 0.

- [ ] **Step 5: Commit**

Message `docs: ADR-0011 and README for write-time reconcile` to `.git/commit-msg.tmp`, then `git add docs/adr/0011-write-time-reconcile-schema-free-facets.md README.md CHANGELOG.md && git commit -F .git/commit-msg.tmp`.

---

## Self-Review

**Spec coverage.** D1 → Tasks 3–4. D2 → Task 4 step 3 (the existing `vectorSearch` call is reused, not added). D3 → Task 3 rule 1 + its two gate tests. D4 → Tasks 3, 6, 7. D5 + 4.3 merge → Task 1 `mergeText`, Task 3 supersede paths, Task 7 end-to-end. D6 → Task 3 rule 5 + Task 4 test. D7 → Task 2. D8 → Global Constraints + Task 4 rule 2. D9 → Tasks 4–5. D10 → Task 3 rule 4 + Task 4 test. Acceptance §9.1 → Task 3. §9.2 → Task 4. §9.3 → manual, covered by Task 4's chain test. §9.4 → Task 4. §9.5 → Task 1. §9.6 → Task 1. §9.7 bench → deliberately not in this plan; it needs NIM + omniroute and is a pre-release manual gate.

**Placeholder scan.** No TBD, no "handle edge cases", no untyped function left for later. Every task names its file, its signatures, its test and its command.

**Type consistency.** `Decision` (Task 3) is the only decision type; `SaveResult` wraps it (Task 4) and the MCP layer reads `decision.action` (Task 5). `Relation` is declared once in `reconciler.ts` (Task 3) and consumed by `judge.ts` (Task 6) and `reconciler.ts`. `RelationJudge` returns `Relation | null` everywhere; `jevRelation` returns `RelationResult | null`, and only the service adapts between them (Task 7).
