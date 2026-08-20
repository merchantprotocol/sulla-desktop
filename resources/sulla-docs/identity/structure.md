# Identity System — Directory Structure

## Location

```
~/sulla/identity/
├── human/
│   ├── identity.md          # Who Jonathon is, current state, operating model
│   └── goals.md             # 2-year vision, 13-week arc, weekly tasks
│
├── business/
│   ├── identity.md          # Merchant Protocol state, revenue model, product stack
│   ├── goals.md             # Business 2-year vision, 13-week milestones
│   ├── marketing.md         # ICP, positioning, content strategy
│   └── content-strategy.md  # Blog pipeline, organic growth targets
│
├── agent/
│   ├── identity.md          # Sulla's role and behavioral commitments
│   └── goals.md             # Agent 13-week arc, behavioral rules
│
└── world/
    ├── identity.md          # External market, competitive landscape
    └── goals.md             # Market-level targets

Postgres project tables         # ONE project-state store (operator agenda)
  work_projects → work_epics → work_tasks → work_task_comments
  Tools: sulla project/*   UI: Projects view (open_tab mode=projects)

~/sulla/projects/<slug>/     # PRDs + workspaces (specs, not the agenda)
~/sulla/ledger/              # Legacy markdown. Frozen. Do not pick from it.
```

---

## identity.md Format

```yaml
---
id: human-identity
name: Jonathon Byrdziak
type: human
location: Coeur d'Alene, Idaho
timezone: America/Los_Angeles
last_updated: 2026-04-23
version: v31
---

## Summary of Changes (v31 — date)
[What changed since last version]

## Core Identity & Operating Model
[Deep behavior patterns, risk assessment, priorities]

## Goals & Intentions
[Active goals with success criteria]
```

---

## goals.md Format

```yaml
---
id: human-goals
type: goals
domain: human
version: 30.2
date: 2026-04-23
status: 13-WEEK ARC v30.2
---

## 2-YEAR VISION
[Destination + alignment check]

## 13-WEEK ARC: Q2 2026
[Phase-by-phase breakdown]

## Weekly Goals — Week N
[Specific, observable tasks]
```

---

## How Agents Read Identity

```bash
# Read business identity for ICP and product context
exec({ command: "cat ~/sulla/identity/business/identity.md" })

# Read business goals for transformation arc
exec({ command: "cat ~/sulla/identity/business/goals.md" })

# Read marketing for positioning
exec({ command: "cat ~/sulla/identity/business/marketing.md" })
```

The business identity and goals files are the authoritative source for:
- What the product does
- Who the ideal customer is
- What transformation the customer wants
- How to position Sulla Desktop in content

---

## Two memory layers

Identity lives in **two** places now — the editable `~/sulla/identity/` files above, and a **domain-keyed Postgres store** that the subconscious writes and recalls automatically. Prefer the DB store for anything the agent should learn on its own; the files remain a human-editable baseline.

### 1. `identity_observations` — domain-keyed identity (the live store)
Migrations `0050`–`0054`. One row = one focused fact about a domain. The `domain` column is constrained to exactly six values, mirroring `~/sulla/identity/`:

```
human · business · world · agent · environment · projects
```

Each row carries a **certainty level**:
- **L3 — stated fact:** the subject told us directly, or it's a direct instruction.
- **L2 — derived fact:** established from conversation/tool evidence.
- **L1 — conclusion:** reasoned from L2/L3 (personality, style, habits).

Plus `category`, provenance/basis, and confidence. Writes **dedupe** — pass an existing `id`, or a substantially-similar active row in the same domain is updated in place instead of duplicated. Soft-archive only.

```bash
sulla observation/search_identity_observations '{"domain":"human","query":"communication preferences"}'
sulla observation/add_identity_observation '{"domain":"human","level":3,"category":"preference","content":"Prefers concise status updates.","basis":"Stated directly."}'
sulla observation/list_identity_observations '{"domain":"business"}'
sulla observation/remove_identity_observation '{"id":"abcd"}'
```

A subconscious **observer** per domain writes these after each turn, and a per-domain **recall** agent surfaces the relevant rows before each turn — injected as `<user_observations>` (human), `<self_observations>` (agent), `<business_observations>`, `<world_observations>`, `<environment_observations>`, `<projects_observations>`. Don't hardcode a specific person/business into observer logic — the domain describes *what* to study. Full mechanics: [`environment/subconscious.md`](../environment/subconscious.md).

### 2. `observations` — operational memory
Migration `0028`. Short, priority-ranked operational facts (surprising or non-obvious), recalled by keyword each turn into `<observation_context>`.

```bash
sulla observation/add_observational_memory '{"priority":"high","content":"ICP is security-conscious small businesses, not solopreneurs"}'
sulla observation/search_observations '{"query":"ICP"}'
sulla observation/remove_observational_memory '{"id":"abc123"}'
```

Both stores soft-archive (never hard-delete), so history is recoverable. Use them for facts that affect ongoing behavior — not temporary task state (that's Projects, below).

---

## Projects Work-State (the one project-state store)

Project work in motion lives in the Postgres project tables (`work_projects` → `work_epics` → `work_tasks` → `work_task_comments`), not in `identity/agent/goals.md` and not in `projects/ACTIVE_PROJECTS.md` / `PARKED_DECISIONS.md` / `~/sulla/ledger/` (those are transition leftovers and freeze). Every autonomous cycle starts with the injected `<project_report>` (or `sulla project/list_project_items` / `sulla project/project_report`), picks the top open task, moves it, and writes back with `sulla project/update_task` + `sulla project/add_task_comment`. Measure by task status and `last_moved_at`, not markdown. Do not look for native project-management tools outside the Sulla CLI catalog.
