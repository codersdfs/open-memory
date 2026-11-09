# open-memory beta — tester guide

Local-first memory for AI agents: one SQLite file, hybrid retrieval (BM25 + vectors), a hard
token budget, MCP + HTTP + CLI. Your history never leaves the machine. This page gets you from
`npm install` to useful feedback in about ten minutes.

## Install

```bash
npm i -g @franklinww/open-memory@beta
ai-memory --version        # expect 0.4.0-beta.3
```

Requirements: Node >= 22.5. Works best on a machine where you already run a coding agent daily.

## Wire it into your agent

Two doors, pick either (or both):

- **MCP**: `ai-memory mcp` is a standard MCP server — register it with your client the usual way
  (stdio). Tools: `memory_remember`, `memory_search`, `memory_brief`, `memory_stats`,
  `memory_drops` and friends.
- **Copy-paste prompt**: hand the agent the wiring prompt in the README ("give your agent this
  prompt") — it configures hooks so memories are saved and recalled without you asking.

Then use your agent normally for a day or two. That's the whole setup.

## What we want you to test (three questions, one week)

1. **Install friction.** Where did you get stuck? Every dead end matters more than any feature.
2. **Recall quality.** After a few days, ask the agent things like *"what did we decide about X
   last week?"* Score it yourself: did the right memory come back? `ai-memory search "query"
   --explain` shows the score decomposition for any hit.
3. **Token bill.** The brief/recall path carries a hard budget (`MEMORY_BUDGET_TOKENS`). Does
   context stay small? Compare against whatever you did before.

## When something looks wrong

- **A memory you saved is missing?** `ai-memory drops` lists every write the filter refused —
  class, advice, how many times. A note that "seems useless until it happens again" is a query,
  not a guess.
- **Empty search?** The result names the partitions it did *not* read; widen the scope or check
  `--all`.
- **Anything else**: `ai-memory --help`, `ai-memory doctor`, and the ADRs in `docs/adr/` explain
  almost every decision (including the ones we measured and rejected).

Report via GitHub issues (`codersdfs/open-memory`) or DM — whichever you started from. A useful
bug report is three lines: **what you asked / what came back / what you expected**.

## Known limitations (read before filing)

- One daemon per OS account, one principal key; a second local process cannot read another
  account's partitions by naming them. Processes under the *same* OS account are trusted — this
  is a local-first store, not a sandbox, and the boundary is written down rather than implied.
- Prereleases may still move the HTTP and MCP surfaces between builds; the on-disk format will
  not.
- The default hash embedder works offline but ranks weaker than a real embedding provider
  (`OPENAI_API_KEY` or a keyless local endpoint like Ollama/LM Studio via `OPENAI_BASE_URL`).
- The scheduled maintenance pass (`MEMORY_MAINTAIN_HOURS`, default 24h) only archives — it can
  never hard-delete. Nothing is unrecoverable except an explicit purge.
