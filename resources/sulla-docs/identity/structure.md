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
exec({ command: "sulla meta/add_observational_memory '{\"priority\":\"high\",\"content\":\"ICP is security-conscious small businesses, not solopreneurs\"}'" })

# Remove stale memory
exec({ command: "sulla meta/remove_observational_memory '{\"id\":\"abc123\"}'" })
```

Observations appear in every agent's context automatically. Use for facts that affect ongoing behavior — not for temporary task state.
