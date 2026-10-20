# Archived tickets

Consumed tickets, kept for their decision record — the reasoning in them is the only
place some of these decisions exist (ADR-0001..0006 cover only part of the set).

The live set is `../tickets/`; `../map.md` (what was deliberately left out) and
`../ROADMAP.md` (R1-R4) were **not** archived — they are decision lists, not finished work.

Superseded rather than finished: `013-task-memory-console-ui.md` — its backend shipped,
and its UI half was replaced by `../tickets/014-task-console-visual-system.md` +
`../../docs/adr/0008-console-replaces-inspector.md`, which are the references to follow.
ADR-0007 and ADR-0008 both name "ticket 013" in prose; that file is here.

## Archived 2026-10-13 — the last three live tickets, so `../tickets/` is now empty

What is left in wayfinder is not tickets: `../ROADMAP.md` (R2-R4, the differentiators that
are still open) and `../map.md` (what was deliberately left out).

- `012-task-vault-knowledge-graph.md` — Done 2026-10-06, re-verified 2026-10-13 against a
  nested fixture vault (addendum in the file). **Still unverified:** the browser pass past
  HTTP 200 — this repo has no harness that exercises the `graph.js` canvas.
- `014-task-console-visual-system.md` — Done 2026-10-13. The inspector is deleted, `/` and
  `/app` serve the console, and the package build no longer depends on the UI dev deps.
  **Still unverified:** the manual browser pass (both themes on every view, the `0.72` →
  `0.35` preset on one query, a create → restore round-trip on the real store).
- `015-task-embedding-provider-switch.md` — Done 2026-10-13. **Still unverified:** the manual
  migration path — this machine has no remote key, so only `hash` is configured and the
  dark window (`needsRestart: true` → every row unreadable → restart) was not walked.

Each of the three carries its own `## Done` section with the commands that were run and
their results, so the unverified list above is the whole of what is left.
