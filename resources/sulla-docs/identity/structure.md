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
├── environment/
│   ├── identity.md          # Directly observed facts about this Sulla Desktop runtime/host
│   └── goals.md             # Environment/process improvement targets
│
├── projects/
│   ├── identity.md          # Observations about the internal Projects system and work-state behavior
│   └── goals.md             # Project-system improvement targets
│
└── world/
    ├── identity.md          # External market, competitive landscape
    └── goals.md             # Market-level targets

Postgres project tables         # ONE project-state store (operator agenda)
  work_projects → work_epics → work_tasks → work_task_comments
  Tools: sulla *   UI: Projects view (open_tab mode=projects)

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

## Observational Memory

Short-term facts injected into every agent context:

```bash
# Add a memory
exec({ command: "sulla observation/add_observational_memory '{\"priority\":\"high\",\"content\":\"ICP is security-conscious small businesses, not solopreneurs\"}'" })

# Remove stale memory
exec({ command: "sulla observation/remove_observational_memory '{\"id\":\"abc123\"}'" })
```

Observations appear in every agent's context automatically. Use for facts that affect ongoing behavior — not for temporary task state.

## Identity Observations

Longer-lived domain facts live in Postgres `identity_observations`, not only in markdown files. Use these tools for domain-scoped memory:

```bash
sulla observation/search_identity_observations '{"domain":"human","query":"communication preference","limit":10}'
sulla observation/add_identity_observation '{"domain":"human","level":3,"category":"communication_preferences","content":"The human prefers concise updates.","basis":"Directly stated by the human.","confidence":1}'
sulla observation/list_identity_observations '{"domain":"human","limit":20}'
sulla observation/remove_identity_observation '{"id":"abcd"}'
```

Supported domains mirror the identity areas: `human`, `business`, `world`, `agent`, `environment`, and `projects`. Levels are certainty, not priority: L3 = directly stated, L2 = derived from evidence, L1 = reasoned conclusion. Search first and update existing rows by `id` instead of duplicating.

---

## Projects Work-State (the one project-state store)

Project work in motion lives in the Postgres project tables (`work_projects` → `work_epics` → `work_tasks` → `work_task_comments`), not in `identity/agent/goals.md` and not in `projects/ACTIVE_PROJECTS.md` / `PARKED_DECISIONS.md` / `~/sulla/ledger/` (those are transition leftovers and freeze). Every autonomous cycle starts with the injected `<project_report>` (or `sulla list_project_items` / `sulla project_report`), picks the top open task, moves it, and writes back with `sulla update_task` + `sulla add_task_comment`. Measure by task status and `last_moved_at`, not markdown. Do not look for native project-management tools outside the Sulla CLI catalog.
