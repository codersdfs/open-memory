# ADR-0030: The page tree reads pages, not partitions

- **Status:** Accepted
- **Date:** 2026-10-23
- **Related:** ADR-0023 (knowledge pages), ADR-0029 (partition vector cache), ADR-0027 (coverage)

## Context

`knowledgePages` builds the page tree the UI, the `memory_knowledge` tool and the
`knowledge` CLI route all render from. It did it with one call per partition:

```ts
const listed = await store.list({ namespace, limit: 100_000 });
```

The reasoning in the code comment was that a vault is pages-times-sections rows, so
listing the partition once beats a query per page, and the grouping happens in
memory. Both halves of that are wrong once a partition holds chat history.

Knowledge rows are ordinary memories carrying a `knowledge_id` and a
`knowledge_section` (ADR-0023) — they live in the same table, in the same partition,
interleaved with every conversational memory the agent ever wrote. So "list the
partition" is not "list the vault". Measured on 21,000 rows where 20,000 were
ordinary memories and 1,000 were a 200-page vault:

| | |
| --- | --- |
| rows read | 21,000 |
| rows kept | 1,000 |
| `knowledgePages` p50 | **388 ms** |
| `knowledgeIndex` (calls it) | **349 ms** |

Ninety-five percent of the work was decoding vectors and text that the next line
threw away. And the cost followed the size of the *chat history*, not the size of the
vault — a user with a 20-row vault and a long history paid the same as one with a
20,000-row vault.

Two smaller costs hid behind that one:

- `attachVectors` copied an embedding array for every listed row. The page tree only
  reads ids, section keys and the heading inside the text; on 10^5 rows that is
  roughly 150 MB of pointless copying.
- The per-page grouping ran `edges.filter` three times per page (`links`,
  `backlinks`, `dangling`). With 200 pages and 600 edges that is 360,000 comparisons
  for 600 edges; it is quadratic in pages and would only get worse.

## Decision

**Filter to the rows the page tree is made of, and index the edges once.**

1. **A page-tree query, not a partition listing.** New optional capability
   `KnowledgeCapability.listKnowledge(namespaces)` performs one indexed read:

   ```sql
   SELECT * FROM memories
    WHERE namespace IN (...) AND knowledge_id IS NOT NULL AND is_deleted = 0
      AND status != 'archived' AND status != 'draft'
    ORDER BY knowledge_id, knowledge_section
   ```

   `knowledge_id IS NOT NULL` is served by the partial index on `knowledge_section`,
   so the cost now follows the vault. Optional like every other store addition: a
   third-party store without it falls back to `list` plus a filter, which is correct
   but pays the old cost.
2. **`list` can skip the vector join.** `withVectors?: boolean` (default `true`).
   The page tree asks for text and metadata only, and `syncKnowledge`'s partition read
   does too — its only use of ordinary rows is `legacyTag(r.tags, id)`, which never
   touches an embedding. Default stays `true` so every existing caller is unchanged.
3. **Edges are bucketed once.** `knowledgePages` builds `Map<pageId, KnowledgeEdge[]>`
   for both endpoints in a single pass over the edge list, then looks up. Linear in
   edges instead of quadratic in pages.
4. **The exclusions stay identical to `list`'s.** Deleted, archived and draft rows are
   filtered in SQL with the same predicates `candidateWhere` uses, so the page tree
   cannot disagree with a `memory_list` call about which rows exist. A test pins it.

## Measured result

Same machine, same data (20,000 ordinary + 1,000 knowledge rows, 200 pages × 5
sections, 600 edges, one partition):

| metric | before | after | change |
| --- | --- | --- | --- |
| `knowledgePages` p50 | 388.0 ms | **8.5 ms** | 46x |
| `knowledgePages` spread | 350.8–417.5 ms | 7.6–16.1 ms | — |
| `knowledgeIndex` | 348.6 ms | **7.4 ms** | 47x |

The output is identical: 200 pages, 1,000 sections, 600 resolved edges, 0 dangling.
`npx vitest run` is 46 files / 568 passed, `tsc -p tsconfig.lint.json` clean.

## What this does not fix

- **A partition with a genuinely huge vault is still linear in the vault.** Reading
  20,000 knowledge rows is still 20,000 rows. Pagination is the next step if a vault
  ever gets that large; it is not needed at 200 pages.
- **The fallback path is unchanged.** A store that does not implement `listKnowledge`
  keeps the old cost. That is deliberate — the alternative is breaking the interface.
- **`listByKnowledge`, `listKnowledgeIds` and `replaceLinks` were already fine.** They
  filter by `knowledge_id` in SQL; only the page-tree entry point was listing whole
  partitions. `listKnowledgeIds` gained an unused optional `namespace` parameter, left
  for a future caller.

## Rejected

- **A query per page** (`listByKnowledge` in a loop). Correct and index-backed, but it
  is O(pages) round trips through the async store boundary; at 200 pages that measured
  worse than one filtered read, and it gets worse as the vault grows.
- **A separate `knowledge_pages` table.** A denormalised copy would make this read
  O(pages), but it duplicates data that already has a home, needs its own
  invalidation on every sync, and can disagree with `memories` when a write fails
  halfway. The rows are already there and already indexed.
