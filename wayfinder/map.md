- **Team/ACL/Roles** (`private`/`team`/`restricted`, System Admin vs Team Admin/Member, `agent` visibility) — team is one. Close any ticket that reintroduces multi-user ACL; reason: solo has no one to share with in this effort.
- **Multi-tenant RLS / tenant_id row isolation** (Tencent's `app.tenant_id` + `agent_id` RLS on `memory.records`) — solo uses single `namespace="default:default"`; true RLS is a later effort if multi-tenant ever needed.
- **Proxy zero-code generic interception** (point baseURL at MemoryProxy) — solo can call explicit `memory_search` tool; Proxy for all frameworks is a separate platform effort.
- **NVFP4 vs BF16 Wiki/CodeGraph hardware profiles** — solo runs on existing laptop; hardware-specific kernels are out of scope for this path.

- **Memory rows on the knowledge graph** — knowledge lives as markdown in `vault/`; `memory.db` rows stay off the graph. Two node sets would mean two edge semantics, and memories are retrieved, not browsed.
- **Obsidian plugin host / in-UI note editing** — the graph is a read-only view over files; the editor stays Obsidian, Notepad, or anything else that writes markdown.

- **Roadmap R1-R4** — differentiators that stay zero-LLM-call: explainable recall -> retrieval reinforcement -> redundancy-aware eviction -> contradiction check · [roadmap](ROADMAP.md)