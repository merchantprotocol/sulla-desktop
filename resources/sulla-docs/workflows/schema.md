# Sulla Workflows — YAML Schema

## Top-Level Structure

```yaml
id: workflow-unique-id                    # Required. No spaces, kebab-case
name: "Workflow Display Name"             # Required. Human-readable
description: "What this workflow does"    # Required
version: 1                                # Always 1
createdAt: "2026-04-23T00:00:00.000Z"    # ISO 8601
updatedAt: "2026-04-23T00:00:00.000Z"    # ISO 8601
tags:                                     # Optional array of strings
  - daily
  - production
_status: production                       # draft | production | archive
enabled: true                             # Whether auto-triggers fire

nodes:                                    # Required. Array of node objects
  - id: node-001
    type: workflow                        # Always "workflow"
    position:
      x: 400                             # Canvas position (cosmetic only)
      y: 0
    data:
      subtype: <subtype>                 # See node-types.md
      category: <category>              # trigger|agent|routing|flow-control|io
      label: "Node Label"               # Human-readable, used in {{templates}}
      config: {}                        # Node-specific config

edges:                                    # Required. Array of edge objects
  - id: edge-001
    source: node-001                     # Source node ID
    target: node-002                     # Target node ID
    sourceHandle: null                   # For routers/parallel: route-0, branch-0, etc.
    targetHandle: null                   # For loops: loop-entry, loop-back
    animated: true                       # Optional visual flag

viewport:                                 # Optional canvas state
  x: 0
  y: 0
  zoom: 1
```

---

## File Locations

| Status | Location |
|--------|---------|
| Active / auto-triggered | `~/sulla/workflows/production/` |
| Work in progress | `~/sulla/workflows/draft/` |
| Disabled | `~/sulla/workflows/archive/` |

Filename convention: `<workflow-id>.yaml` or descriptive name like `daily-social-posts.yaml`.

---

## Template Syntax

Templates are resolved at runtime before each node executes.

```
{{trigger}}                    — Original workflow trigger payload
{{Node Label}}                 — Output from a node (matched by label)
{{node-id}}                    — Output from a node (matched by ID)
{{Node Label.result}}          — Explicit .result field
{{Node Label.threadId}}        — Thread ID from a sub-agent run
{{loop.index}}                 — Current loop iteration (0-based)
{{loop.currentItem}}           — Current item in for-each loop
{{loop.currentItem.result}}    — Result field of current loop item
```

Unresolved variables remain as `{{literal}}` — they do NOT throw errors.

---

## Node ID & Label Rules

- `id`: Must be unique within the workflow. Use kebab-case: `node-sm-twitter`
- `label`: Used in `{{template}}` references — keep stable, avoid renaming after connections are built
- `type`: Always `"workflow"` — do not change

---

## Edge Handle Values

| Node type | sourceHandle values | targetHandle values |
|-----------|--------------------|--------------------|
| `router` | `route-0`, `route-1`, `route-N` | — |
| `parallel` | `branch-0`, `branch-1`, `branch-N` | — |
| `condition` | `condition-true`, `condition-false` | — |
| `loop` | `loop-start`, `loop-exit` | `loop-entry`, `loop-back` |
| All others | `null` | `null` |
