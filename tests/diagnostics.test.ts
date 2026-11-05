/**
 * ADR-0037: an empty search has to explain itself.
 *
 * The failure this pins down is not a ranking bug, it is a silence: a caller that
 * gets `{ memories: [] }` cannot tell "this partition holds nothing" from "your
 * wording missed the gate", so it rewrites the question and asks again. Every
 * assertion here is about that distinction, and about the payload discipline that
 * makes it affordable — the happy path must not carry the explanation.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { HybridRetriever } from "../src/core/retrieval/hybrid.js";
import { HashEmbeddingProvider } from "../src/core/embedding/hash.js";
import { InMemoryVectorStore } from "../src/core/store/memory.js";
import { LEGACY_NAMESPACE, resolveUser } from "../src/core/scope.js";
import type { MemoryType } from "../src/core/types.js";

const NS = "diag:1";
const EMPTY_NS = "diag:empty";

let store: InMemoryVectorStore;
let embedder: HashEmbeddingProvider;
let retriever: HybridRetriever;

describe("search diagnostics on an empty result", () => {
  beforeEach(async () => {
    store = new InMemoryVectorStore();
    embedder = new HashEmbeddingProvider();
    retriever = new HybridRetriever(store, embedder);
    await store.init();
  });

  const put = async (text: string, opts: { namespace?: string; type?: MemoryType } = {}) =>
    store.insert(
      { namespace: opts.namespace ?? NS, type: opts.type ?? "semantic", text, importance: 0.6 },
      await embedder.embed(text)
    );

  it("names the searched partitions and their real totals when nothing matches", async () => {
    await put("user lives in Berlin and prefers answers in German");
    await put("the deploy runs on the second Tuesday of every month");
    // A row the search's own filter excludes: `total` must count what was searched,
    // not the whole partition.
    await put("an episodic note about a conference", { type: "episodic" });

    const r = await retriever.search({
      query: "kubernetes ingress controller",
      namespaces: [NS, EMPTY_NS],
      type: "semantic"
    });

    expect(r.memories).toHaveLength(0);
    expect(r.diagnostics).toBeDefined();
    expect(r.diagnostics!.partitions).toEqual([
      { namespace: NS, total: 2 },
      { namespace: EMPTY_NS, total: 0 }
    ]);
    // Nothing was even a candidate: every row scored bm25 0 and the hash embedder
    // cannot admit on cosine, so there is no near miss to report — but the counts
    // still say the rows are there.
    expect(r.diagnostics!.nearMisses).toEqual([]);
    // The default gate, materialized where the gate itself reads it.
    expect(r.diagnostics!.threshold).toBe(0.72);
  });

  it("carries no diagnostics when the search returns rows", async () => {
    await put("user lives in Berlin and prefers answers in German");

    const r = await retriever.search({ query: "Berlin", namespace: NS, threshold: 0.35 });

    expect(r.memories.length).toBeGreaterThan(0);
    // `in`, not `toBeUndefined`: the key must be absent, not present-and-empty. A
    // caller that spreads the result into a response would otherwise pay for it.
    expect("diagnostics" in r).toBe(false);
  });

  it("reports a candidate that scored below the threshold as a near miss", async () => {
    // The row holds one of the query's five words, so it is a candidate — it just is
    // not a match for the question. That is exactly the case the caller must be told
    // apart from "nothing is stored".
    await put("alpha");

    const r = await retriever.search({ query: "alpha beta gamma delta epsilon", namespace: NS, threshold: 0.9 });

    expect(r.memories).toHaveLength(0);
    const nearMisses = r.diagnostics!.nearMisses;
    expect(nearMisses).toHaveLength(1);
    expect(nearMisses[0]!.text).toBe("alpha");
    // The number the gate compared, and it lost: below the threshold is the whole
    // meaning of "near miss".
    expect(nearMisses[0]!.relevance).toBeGreaterThan(0);
    expect(nearMisses[0]!.relevance).toBeLessThan(r.diagnostics!.threshold);
    // Hash embeddings contribute no vector weight, so relevance *is* the bm25 here.
    expect(nearMisses[0]!.bm25).toBe(nearMisses[0]!.relevance);
    expect(nearMisses[0]!.coverage).toBeGreaterThan(0);
    expect(nearMisses[0]!.coverage).toBeLessThan(0.75);
  });

  it("reports total 0 for a partition that never held a row", async () => {
    await put("user lives in Berlin");

    const r = await retriever.search({ query: "Berlin", namespace: EMPTY_NS });

    expect(r.memories).toHaveLength(0);
    expect(r.diagnostics!.partitions).toEqual([{ namespace: EMPTY_NS, total: 0 }]);
    expect(r.diagnostics!.nearMisses).toEqual([]);
  });

  it("keeps the five best near misses and clips their text", async () => {
    // Six candidates that all share the one word, each long enough to be clipped.
    for (let i = 0; i < 6; i++) await put(`alpha note ${i} ${"filler ".repeat(40)}`);

    const r = await retriever.search({ query: "alpha beta gamma delta epsilon", namespace: NS, threshold: 0.9 });

    expect(r.memories).toHaveLength(0);
    const nearMisses = r.diagnostics!.nearMisses;
    expect(nearMisses).toHaveLength(5);
    for (const nm of nearMisses) expect(nm.text.length).toBeLessThanOrEqual(200);
    // Best first: the reported order is the order a caller should read them in.
    const relevances = nearMisses.map((n) => n.relevance);
    expect(relevances).toEqual([...relevances].sort((a, b) => b - a));
  });
});

/**
 * ADR-0039: an empty result must also say whether the answer is filed somewhere this
 * read did not look.
 *
 * The measured failure: `coding-agent:frank` held "The user lives in Tokyo." while a
 * layered read of `pi:frank` reported "nothing was stored for this scope". True, and
 * it points the caller at their own wording when the fact was one agent layer over.
 * The fix is a report, not a wider read: the read range stays exactly what the caller
 * asked for, so the same query still returns the same rows.
 */
describe("search diagnostics outside the read scope", () => {
  const user = resolveUser();
  const PI = `pi:${user}`;
  const CODEX = `coding-agent:${user}`;

  beforeEach(async () => {
    store = new InMemoryVectorStore();
    embedder = new HashEmbeddingProvider();
    retriever = new HybridRetriever(store, embedder);
    await store.init();
  });

  const put = async (text: string, opts: { namespace: string; type?: MemoryType }) =>
    store.insert(
      { namespace: opts.namespace, type: opts.type ?? "semantic", text, importance: 0.6 },
      await embedder.embed(text)
    );

  it("names the partitions holding rows the read did not cover", async () => {
    await put("The user lives in Tokyo.", { namespace: CODEX });
    await put("Frank runs a local-first vector memory service.", { namespace: LEGACY_NAMESPACE });

    const r = await retriever.search({ query: "Tokyo", namespaces: [PI] });

    expect(r.memories).toHaveLength(0);
    // Both are this user's, neither was searched, both hold rows.
    expect(r.diagnostics!.partitions).toEqual([{ namespace: PI, total: 0 }]);
    expect(r.diagnostics!.outside).toEqual([
      { namespace: CODEX, total: 1 },
      { namespace: LEGACY_NAMESPACE, total: 1 }
    ]);
  });

  it("says nothing about an outside partition that holds no rows under this filter", async () => {
    // A partition can hold rows and still contribute nothing to *this* search: an
    // episodic note cannot answer a `type: "semantic"` query, so naming it would
    // promise rows that could never have been returned.
    await put("an episodic note about a conference", { namespace: CODEX, type: "episodic" });

    const r = await retriever.search({ query: "Tokyo", namespaces: [PI], type: "semantic" });

    expect(r.memories).toHaveLength(0);
    expect(r.diagnostics!.outside).toEqual([]);
  });

  it("never names another user's partitions", async () => {
    await put("Bob's private fact", { namespace: "claude:someone-else" });

    const r = await retriever.search({ query: "private fact", namespaces: [PI] });

    expect(r.memories).toHaveLength(0);
    // A diagnostic is not a place to leak the existence of other tenants' data.
    expect(r.diagnostics!.outside).toEqual([]);
  });

  it("reports nothing outside when the read already covered everything", async () => {
    await put("The user lives in Tokyo.", { namespace: CODEX });

    // A query sharing no term with the row, so the result is empty and the diagnostic
    // still has something to say — about a scope that already included CODEX.
    const r = await retriever.search({ query: "kubernetes ingress controller", namespaces: [CODEX, PI] });

    expect(r.memories).toHaveLength(0);
    expect(r.diagnostics!.outside).toEqual([]);
  });

  it("omits the key entirely when the store cannot enumerate partitions", async () => {
    // The key's absence means "unknown", which is a different claim from "nothing is
    // outside" — a store that never told us must not be quoted as saying so.
    const blind = new Proxy(store, {
      get: (target, prop, receiver) =>
        prop === "distinctNamespaces" ? undefined : Reflect.get(target, prop, receiver)
    });

    await put("The user lives in Tokyo.", { namespace: CODEX });
    const blindRetriever = new HybridRetriever(blind, embedder);

    const r = await blindRetriever.search({ query: "Tokyo", namespaces: [PI] });

    expect(r.memories).toHaveLength(0);
    expect(r.diagnostics).toBeDefined();
    expect("outside" in r.diagnostics!).toBe(false);
  });
});
