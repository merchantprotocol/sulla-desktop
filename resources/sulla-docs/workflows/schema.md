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

## Refusing overlapping executions

Set `concurrencyPolicy: forbid` at the definition root to admit at most one active
execution for that workflow ID. Admission uses a PostgreSQL transaction and
advisory lock before publishing the playbook state. Manual starts, scheduler
starts, partial runs, checkpoint resumes, and force starts all use this guard.
A database error refuses activation. An active suspended execution also blocks
new starts; `force` and internal `allowConcurrent` do not override this policy.

```yaml
concurrencyPolicy: forbid
auto_restart: false
```

The policy records `auto_restart: false` even if the definition omits that field.
Automatic lease recovery, stale-row cleanup, and checkpoint supersession leave
these executions alone. Failed singleton workflows remain suspended because a
failed parent cannot prove that an external worker has stopped. Verify all worker
processes have terminated before explicitly settling the suspended execution;
then a new run can start. There is no automatic timeout takeover. Successful
completion releases admission only after pending workers have finished.

For each worker node, `data.config.maxAgents: 1` rejects an orchestrator response
containing more than one nonempty `<PROMPT>` task before any agents are launched.
It does not restrict tools available inside that agent; configure the worker's
tool policy separately if recursive delegation must be prohibited.

Singleton workflows do not retry worker launches automatically, since a timed-out
launch does not prove that the prior process stopped. Nested workflow calls and
workflow transfers involving a singleton source or target are refused; launch
that workflow through its normal activation entry point instead. Keep the
singleton definition stable while a run is active.

## Deterministic preflight admission (zero-AI empty cycles)

Set a top-level `preflight` to gate every activation behind a local Sulla
function. The function runs in-process before any agent graph, memory recall,
or model call exists. Its outputs must include a boolean `shouldRun`; anything
else — missing key, wrong type, function failure, runtime error — fails closed
and no AI starts. When `shouldRun` is false the activation is skipped entirely.

```yaml
preflight:
  functionRef: ripplecore-ready-prs   # slug under ~/sulla/functions/
  inputs:                             # passed to the function verbatim
    owner: dataripple-org
    repositories: [repo-a, repo-b]
```

When `shouldRun` is true, the trigger payload delivered to the workflow becomes
`{"trigger": <original payload>, "preflight": <function outputs>}` so nodes can
read the verified scan through `{{trigger}}` without re-fetching it with AI.

Preflight applies to scheduled fires, catch-up dispatch, manual runs, and direct
activation; `force`/`allowConcurrent` do not bypass it. Checkpoint resume,
restart-from-checkpoint, and partial (`startNodeId`) runs are refused for
preflight workflows because they would replay a stale scan as fresh evidence.
An already-active execution skips before the function even runs.
