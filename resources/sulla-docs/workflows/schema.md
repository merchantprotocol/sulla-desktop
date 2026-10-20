# Sulla Workflows — YAML Schema

## Top-Level Structure

```yaml
id: workflow-unique-id                    # Required. No spaces, kebab-case
name: "Workflow Display Name"             # Required. Human-readable
description: "What this workflow does"    # Required
version: 1                                # Always 1
createdAt: "2026-04-23T00:00:00.000Z"    # ISO 8601
updatedAt: "2026-04-23T00:00:00.000Z"    # ISO 8601
enabled: true                             # Whether auto-triggers fire
maxConcurrentRuns: 1                     # Positive integer; active run ceiling
auto_restart: false                       # Optional boolean
preflight: { functionRef: my-check }      # Optional; see "Deterministic preflight admission"
browser: false                            # Optional boolean; see "Scheduled browser opt-in"

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
    sourceHandle: null                   # For routers: route-0, route-1...; conditions; loops
    targetHandle: null                   # For loops: loop-entry, loop-back
    label: ""                            # Optional
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

The status that decides whether a workflow runs lives on the database row, set by `workflow/import_workflow` (`status`) or `workflow/set_workflow_status`. Moving a file between these folders does not change the row. The `~/sulla/workflows/` folder is mirrored into the File Manager at `Sulla/Use Cases/workflows/`.

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
{{loop.currentItem.label}}     — Label of current loop item
{{loop.currentItem.nodeId}}    — Node ID of current loop item
```

Only `.result` and `.threadId` resolve on a node reference. Any other field, such as `{{Merge Node.merged}}`, stays as a literal. Unresolved variables remain as `{{literal}}` — they do NOT throw errors.

---

## Node ID & Label Rules

- `id`: Must be unique within the workflow. Use `node-<number>` (for example `node-001`). The validator warns on any other pattern.
- `label`: Used in `{{template}}` references — keep stable, avoid renaming after connections are built
- `type`: Always `"workflow"` — do not change

---

## Edge Handle Values

| Node type | sourceHandle values | targetHandle values |
|-----------|--------------------|--------------------|
| `router` | `route-0`, `route-1`, `route-N` | — |
| `parallel` | `null` (each outgoing edge is a branch) | — |
| `condition` | `condition-true`, `condition-false` | — |
| `loop` | `loop-start`, `loop-exit` | `loop-entry`, `loop-back` |
| All others | `null` | `null` |

## Concurrent execution limit

Set `maxConcurrentRuns` at the definition root to a positive integer. The
default is `1`. Admission uses a PostgreSQL transaction and per-workflow
advisory lock before publishing the playbook state, so simultaneous manual,
scheduled, partial, restart, resume, child, and transfer starts cannot exceed
the limit. Active suspended executions count toward the limit because timer and
user-input waits are still live work. `force` and internal `allowConcurrent`
inputs do not bypass the configured ceiling.

```yaml
maxConcurrentRuns: 3
auto_restart: false
```

Legacy definitions remain compatible: `concurrencyPolicy: forbid` maps to `1`,
while `concurrencyPolicy: allow` without an explicit limit keeps its old
unbounded behavior. New and edited workflows should use `maxConcurrentRuns`.

A failed one-run workflow is **settled as failed** (so the next run, including the
next scheduled run, is admitted) unless it may have left a worker running: a
worker still pending, or one whose wait ended in a timeout/abort. Only then does
the run stay **suspended**, holding admission, because a failed parent cannot
prove that worker stopped. A suspended run blocks every new start of the
workflow, so Sulla shows a one-time desktop notification ("Routine paused: …").
Verify the worker has terminated, then settle or resume the execution; there is
no automatic timeout takeover. Successful completion releases admission only
after pending workers have finished.

Resuming an interrupted execution (from the UI, `resumeExecutionId`, or boot
recovery) runs under a new execution id and settles the original as `failed`
with `terminal_reason: resumed` in the same admission, so the original can
neither block its own resume nor be recovered a second time.

For each worker node, `data.config.maxAgents: 1` rejects an orchestrator response
containing more than one nonempty `<PROMPT>` task before any agents are launched.
It does not restrict tools available inside that agent; configure the worker's
tool policy separately if recursive delegation must be prohibited.

Workflows limited to one run do not retry worker launches automatically, since a timed-out
launch does not prove that the prior process stopped. Nested workflow calls and
workflow transfers use the same atomic per-workflow admission as top-level
starts. Each child receives its own durable execution and lease, while the
parent retains ownership until the child settles; a transfer settles the
outgoing execution before the target continues. Keep the concurrency definition
stable while a run is active.

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

## Scheduled browser opt-in

Set top-level `browser: true` in a saved routine to grant the graph-owned
`browser_controller` when run by the scheduler, catch-up, or Routines UI.
The executor reads the admitted definition, never instructions in the trigger.
It supplies the slim scheduled tools (browse_tools, exec, read_file, write_file,
browser_controller). Hidden-browser or existing tool-policy restrictions fail
closed. Ordinary workflows remain unchanged. Native tool-call nodes use fresh
workers bound to their owning graph, so browser ownership cannot leak between
concurrent runs. Use `toolName: browser_controller` directly, not a nested CLI
call: CLI calls do not carry the graph capability.

Native tool-call `defaults` preserve JSON objects, arrays, numbers, booleans and
null. Only string leaves interpolate templates such as `{{trigger}}`.

Browser capability is not permission to bypass website controls. Keep platform
rules, explicit transmission authority, human challenge handling, duplicate
prevention and submission receipts in the application routine. A completed
workflow can still report a blocked application; dashboard counts must use
submission receipts rather than workflow completion.
