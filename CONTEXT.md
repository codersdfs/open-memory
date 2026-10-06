# AI Memory

A local-first, namespace-partitioned memory substrate for AI agents that stores, retrieves, and budgets historical context without burning tokens or degrading prompt quality.

## Language

**Memory**: A single stored unit of recall: text plus vector plus metadata.
_Avoid_: context, chunk, document

**Episodic Memory**: What happened — time-bound events and observations from interactions.
_Avoid_: history, log

**Semantic Memory**: Stable facts and preferences about the user or world, e.g. "user lives in Berlin".
_Avoid_: fact, knowledge

**Procedural Memory**: How-to knowledge, skills, and routines the agent can reuse.
_Avoid_: instruction, tool

**Working Memory**: Current task or goal-scoped context, short-lived and replaceable.
_Avoid_: cache, scratchpad

**Namespace**: The isolation key `{agentId, userId}` that partitions all memories.

**Read fan-out**: A read covers the caller's own partition, the `shared` partition, and `default:default` — where memories written before scoping existed live. Leaving the legacy partition out does not narrow a search, it empties it: an agent marker in the environment made a bare `ai-memory search` look only at `pi:<user>` (0 rows) while every row the user had sat in `default:default`. Writes still land in exactly one partition. `--all` widens a read to every partition this user owns — the only way to reach a partition written under a different agent identity — and never crosses into another user's partitions.
_Avoid_: tenant, workspace

**Token Burning**: Cost and latency incurred by injecting too many tokens of memory into a prompt.

**Context Burning**: Quality degradation from injecting irrelevant or low-value memories that dilute the prompt.

**Importance**: A 0..1 score of how critical a memory is to retain; boosts rank and resists decay.

**Supersede**: Linking a new Memory to an old one via `supersedesId` and soft-deleting the old while keeping it for audit.

**Hard Budget**: A maximum token cap for any single search result; overflow is summarized, not stuffed.

**Smart Search**: Two-stage retrieval — Stage 1 hybrid scoring, Stage 2 rerank/MMR plus hard budget enforcement.

**Layer (solo alias)**: Tencent L0-L3 mapped onto flat types without a new column — `L0 raw conversation ~= episodic (source: chat)`, `L1 Atom ~= semantic fact (importance >=0.7)`, `L2 Scenario ~= semantic|procedural with tags scope:scenario:* / scope:repo:*`, `L3 Persona ~= semantic with tags scope:persona`. Layers are simulated via `tags` + `importance`; retrieval stays one flat `HybridRetriever` call.
_Avoid_: L0/L1/L2/L3 as separate types
