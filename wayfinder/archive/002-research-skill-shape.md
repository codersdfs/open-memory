---
title: "Skill shape: what is a solo-dev Skill, given Tencent+Hermes?"
label: wayfinder:research
type: research
HITL: false
blockedBy: []
blocks: [006]
---

## Question

Tencent's Skill is not a prompt snippet — it has versions, resource files, trigger boundaries, execution steps, validation rules, private/team sharing via review, and Hermes Agent heritage. For solo dev, what is the **minimum viable Skill** that still earns "learn it once, whole team can use it" value without the review queue?

**Research via subagent — read:**
- Tencent docs + Hermes Agent skill code (asset structure, trigger, validation)
- Our `src/core/types.ts:1` Procedural Memory (current "Skill" placeholder)
- `MemoryHub` skill asset panel (version/status/visibility)

**Deliver:** 1-page table — Tencent fields vs solo-dev keep/drop/merge (e.g. `versions`→git history, `resource files`→`./skills/<name>/`, `trigger`→frontmatter `when:`). No decision yet — that is ticket 006's grill — just the fact map + recommendation.

---

## Research (2026-08-31)

Sources: `https://github.com/TencentCloud/TencentDB-Agent-Memory` (README: Skill has *versions, resource files, trigger boundaries, execution steps, validation rules*, private→review→team sharing, equipped to Agents; Acknowledgements: Hermes Agent heritage), `https://hermes-agent.nousresearch.com/docs/user-guide/features/skills` + `https://myclaw.ai/blog/hermes-ai-agent-skills` (SKILL.md frontmatter `name`/`description`, progressive disclosure, `~/.hermes/skills/` + project-local, `SKILL.md` defines *when*, inputs, steps, allowed tools, output, safety; scripts/references/assets optional; `agentskills.io` spec), our `src/core/types.ts:1` (`procedural` is flat placeholder — no Skill asset table yet).

### Fact map — Tencent/Hermes → solo

| Tencent / Hermes field | What it does (team) | Solo keep / drop / merge | Solo implementation | Solo cost vs team |
|---|---|---|---|---|
| `name` / slug (`competitor-pricing-brief`) | Asset id | **Keep** | Folder + frontmatter `name: my-skill` → `./skills/<slug>/SKILL.md` | none |
| `description` | Hub listing + retrieval hint | **Keep** | Frontmatter `description: "when to use"` — also used as embed text for `procedural` search | none |
| `trigger / when` (“Use this skill when…”) | Boundary — agent decides to load | **Keep** | First line of `SKILL.md` body: `Use this skill when asked to …` — matched via `memory_search type=procedural` or string `when:` | none |
| `execution steps` | Ordered procedure | **Keep** | `SKILL.md` body `Steps: 1…` — plain markdown, not code | none |
| `allowed tools / rules / forbidden actions` | Guardrail | **Keep slim** | `Rules: - Do not …` in `SKILL.md`; no enforcement engine for solo v1 | drops review |
| `resource files / references / assets / scripts` | Deterministic helpers, templates | **Merge** | `./skills/<slug>/{SKILL.md, scripts/*.ts, references.md, assets/*}` — only add `scripts/` when parsing/formatting must be deterministic (invoices, CSV) per Hermes guidance | drops Hub upload |
| `versions` (v1, v2…) | History + rollback | **Drop → git** | `git log -- ./skills/<slug>/` is version history; optional frontmatter `version: 1` for display only, not DB column | drops version table |
| `validation rules` / `SkillEvaluator` | Review gate | **Drop → lint** | Local check: `SKILL.md` has `name`+`description`+`when`+`steps`; no external evaluator | drops queue |
| `visibility` `private/team/restricted/agent` + ACL | Team sharing | **Drop → private only** | Out of scope per `wayfinder/map.md:37`; all skills `private` to single owner | drops ACL/RLS |
| `review → share` workflow | Publish to team | **Drop** | No review; `git push` is share | drops Hub |
| `Agent binding / equip` (Fixed Binding + ACL, `/v3/tools/list`) | Which agent gets which skill | **Merge → manual equip** | Two modes: (a) **manual** `memory_search type=procedural query="<task>"` injected into prompt, (b) **auto** `autoInject` (`src/api/tool.ts:1`) loads top-K `procedural` — no per-Agent ACL table for solo v1 | drops binding table |
| `ownership / Owner` | Who manages | **Keep implicit** | `git author` + `namespace "default:default"` | none |
| `status` (`draft/active/archived`) + `usage counts` | Lifecycle | **Defer** | Keep in ticket 008 governance-lite — not needed to start | drops column |
| Storage | Team DB `skill` asset tables | **Merge → dual** | Canonical is `./skills/<slug>/SKILL.md` on disk; optional index row `procedural` in `memory.db` (`text = SKILL.md` body, `tags: ["skill:<slug>"]`) for vector search — no new table | keeps `memories` table |

### Recommended solo Skill shape (for grilling in 006)

```
./skills/<slug>/
  SKILL.md          # frontmatter name + description, body: when + steps + rules
  scripts/          # only if deterministic (optional)
  references.md     # examples/checklists (optional)
```

Minimal `SKILL.md` (Hermes-compatible, `agentskills.io` style):

```md
---
name: release-checklist
description: Run release QA — tests, migrations, auth check before tag.
---

Use this skill when asked to release or tag a version.

Steps:
1. Inspect changed files, flag risky modules.
2. Check tests + migrations.
3. Verify "don't refactor auth" constraint (semantic tag scope:scenario:auth).
4. Return findings with file:line refs.

Rules:
- Do not push or tag without approval.
- If auth touched, report impact via CodeGraph.
```

On disk = truth; `memory.db` procedural row is derived index for `HybridRetriever` — not duplicate governance. Progressive disclosure: only `SKILL.md` body enters context when `procedural` search hits.

**Status: Researched — unblocks 006 (grilling). No schema change yet.**

