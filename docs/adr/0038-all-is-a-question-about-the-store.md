# 0038 — `all` is a question about the store

Date: 2026-10-26
Status: Accepted
Amends: ADR-0020 (the read fan-out across own + shared + legacy)

## Context

`--all` promised "every partition this user owns". The CLI kept that promise: it calls
`allPartitions(store, user)`, which reads `store.distinctNamespaces()` and filters by the
resolved user segment. Everything that resolved scope through the *pure* function —
`resolveRequestScope({ agent, scope, all })` — did not, because a pure function cannot
enumerate a store. It approximated the answer with a fixed list:

```
[<agent>:<user>, shared:<user>, default:default]
```

Measured against a live store holding `pi:frank`, `coding-agent:frank`, `claude:frank`
and `default:default`, `all=true` on the daemon resolved to
`default:frank, shared:frank, default:default`. Two of the four partitions were missing,
including the only one with rows in it, and a request that named no agent got
`default:frank` — a partition that did not exist — while `pi:frank` was skipped as well.

That is worse than having no sweep at all: `all` **covered less than the plain layered
read**, which already fans out over `<agent>:<user>`, `shared:<user>` and the legacy
partition. The name promised a superset and the implementation delivered a subset, so a
caller asking for the widest possible read got the narrowest one and had no way to tell.

The defect became load-bearing when the pi extension grew a `scope` parameter: `scope:
"all"` maps straight onto `all=true`, so the one new argument whose entire purpose is
"look everywhere" was the argument that looked at the fewest places.

## Decision

**`all` moves to `resolveReadScope(q, store, user?)` — the async resolver for callers
that hold a store — and leaves the pure resolver entirely.**

`resolveRequestScope` no longer accepts an `all` field at all. Its type is
`{ namespace?, agent?, scope? }`, so a caller that wants a sweep cannot quietly get the
old approximation back; it has to pass a store. `resolveReadScope` delegates to the pure
resolver for every other case, which keeps one implementation of the layered read.

Call sites moved:

- `src/api/server.ts` — `searchScope` is now `async` and takes the service; it is the
  single resolution point for `/memories/search`, `/brief`, `/knowledge` and
  `/knowledge/:id`, so all four inherit the real enumeration.
- `src/mcp/tools.ts` — `memory_stats` resolves through `resolveReadScope(..., ctx.service.store)`.
- `src/cli/index.ts` — unchanged in behaviour: it already expanded `--all` with
  `allPartitions` before calling the pure resolver, so the only edit is dropping the
  now-rejected `all` field.

An explicit `namespace` still wins over `all`, and `allPartitions` still filters by the
resolved user segment: a sweep reaches every partition *this user* owns, never another
person's.

## Consequences

- **`all` now returns a superset of the plain layered read**, which is the only
  definition under which the flag is worth having. Verified end to end on a seeded store
  with four partitions: `all=true` returned `claude:frank, coding-agent:frank,
  default:default, pi:frank` (4 hits), while the layered read returned
  `pi:frank, shared:frank, default:default`.
- **`all` costs one extra query.** `distinctNamespaces()` runs once per request that asks
  for a sweep, and only for that request — every other read stays on the pure path with
  no store access at all.
- **The daemon's scope resolution is now async.** This is a real signature change inside
  the request handler; it is contained to `searchScope` and its four callers.
- **`--all` and `all=true` now agree.** They were two implementations of one promise, and
  the CLI's was correct. A test asserts the async resolver's output for a store holding
  another user's partition (`claude:bob`), so the "never another person's rows" property
  is pinned alongside the completeness one.

What this does not fix:

- **`shared` partitions of other users.** `allPartitions` filters strictly on
  `parseNamespaceKey(ns).userId === resolveUser(user)`, so a shared layer written by a
  different OS user stays invisible even under `all`. That is deliberate — a sweep is
  scoped to one human — but it means `all` is not "everything in the database".
- **The pure resolver's remaining approximation.** `resolveScopeKeys` still builds
  `<agent>:<user>` and `shared:<user>` without asking the store, because that is correct
  for a layered read: those are the two layers a caller means, whether or not they hold
  rows yet.
