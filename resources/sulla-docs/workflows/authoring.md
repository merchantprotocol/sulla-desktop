# Workflow Authoring & Lifecycle

Companion to `schema.md` (structure), `node-types.md` (every node subtype), and `examples.md` (working patterns). This doc is the **how-to**: design, validate, debug, schedule, restart, list.

## Where workflows live

Three locations — distinct purposes:

| Location | Purpose | Who writes there |
|----------|---------|------------------|
| `~/sulla/routines/<slug>/routine.yaml` | **Template** — shipped or shared, cloned into DB when user clicks "Use template" | Agent (preferred for net-new) |
| `~/sulla/workflows/<slug>.yaml` | **Flat-file workflow** — loaded directly by WorkflowRegistry at runtime | Agent (legacy / quick scripts) |
| `workflows` table (Postgres) | **Active workflows** — what the executor actually runs | App / UI write here on template instantiation |

The agent **does not** write to the DB directly when authoring net-new. Save the YAML, then the user (or app) instantiates it.

Statuses on the DB row: `draft` | `production` | `archive`. Only `production` gets picked up by the scheduler.

## Build a workflow — full flow

1. **Gather requirements in conversation.** Don't start writing YAML until the user has agreed on:
   - Trigger (manual? schedule? chat? calendar? heartbeat?)
   - Steps in plain English
   - Routing / conditions / loops
   - Failure mode (abort? continue? retry?)
2. **Read the authoring skill**: `~/sulla/resources/environment/create-workflow.md` is the canonical authoring doc — schema rules, forbidden patterns, edge handles. Always re-read before writing.
3. **Draft the YAML** using the structure from `schema.md` and node-types from `node-types.md`. Common gotchas:
   - Every node needs `type: "workflow"` (the React Flow node type), `position: {x, y}`, and `data: {subtype, category, label, config}`
   - `subtype` and `category` must match the mapping (e.g., `agent` subtype → `agent` category; `router` subtype → `routing` category)
   - Required config fields per subtype — `agent` subtype needs `agentId`, `agentName`, `additionalPrompt`, `orchestratorInstructions`, `successCriteria`, `completionContract`
   - Edges need `id`, `source`, `target`, `sourceHandle`, `targetHandle`, `label`, `animated`
   - At least one trigger node, all downstream nodes reachable
4. **Validate** before saving (see next section)
5. **Save** to `~/sulla/routines/<slug>/routine.yaml` (template) or `~/sulla/workflows/<slug>.yaml` (flat-file)
6. **Test** by activating it: `sulla meta/execute_workflow '{"workflowId":"<slug>"}'` — watch the playbook log

## Validate

```bash
sulla meta/validate_sulla_workflow '{"filePath":"/Users/.../routine.yaml"}'
# or inline:
sulla meta/validate_sulla_workflow '{"yaml":"...full yaml string..."}'
```

**Category note:** workflow tools are registered under `meta`, not under a `workflow/` category — the backend has no `workflow` category. `sulla meta/validate_sulla_workflow`, `sulla meta/execute_workflow`, and `sulla meta/restart_from_checkpoint` are the canonical forms. (The category segment in the URL is ignored by the backend, so `sulla workflow/...` may also resolve, but `sulla workflow --help` returns "Unknown category." Stick with `meta/`.)

What it checks:
- Top-level keys (only: `id`, `name`, `description`, `version`, `enabled`, `createdAt`, `updatedAt`, `nodes`, `edges`, `viewport`)
- Node structure (`type: "workflow"`, `position`, `data.{subtype,category,label,config}`)
- Subtype↔category mapping
- Required config fields per subtype
- Edge structure
- At least one trigger node
- Reachability (no orphaned chains downstream of triggers)

Returns `ValidationIssue[]` with `severity: "error"|"warning"`, `path`, `message`. **Always validate before reporting "done"** — silent schema bugs surface much later as runtime failures.

## Run a workflow

```bash
sulla meta/execute_workflow '{
  "workflowId": "daily-planning",
  "message":    "optional payload to the trigger node",
  "resume":     false,             # true = resume from last checkpoint
  "resumeExecutionId": "wfp-..."   # resume a specific past run
}'
```

Returns immediately:
```json
{
  "executionId":  "wfp-1719283859000-abcdef",
  "workflowSlug": "daily-planning",
  "workflowName": "Daily Planning",
  "status":       "activated",
  "message":      "..."
}
```

Execution proceeds asynchronously through the playbook. Watch the playbook log to see what's happening (next section).

## Debug a failing workflow

The agent has three surfaces to inspect:

### 1. Playbook debug log
**File:** `~/sulla/logs/playbook-debug.log`
**Format:** one JSON object per line, timestamped. Tags include `workflow_started`, `node_completed`, `node_failed`, `orchestrator_abort`, `workflow_failed`.

```bash
grep "<executionId>" ~/sulla/logs/playbook-debug.log
```

### 2. Checkpoint records
**Table:** `workflow_checkpoints` (Postgres). One row per **successful** node. If a node failed, no checkpoint for it.

```typescript
const { WorkflowCheckpointModel } = await import('.../WorkflowCheckpointModel');
const checkpoints = await WorkflowCheckpointModel.findByExecution(executionId);
```

Each row: `execution_id`, `node_id`, `node_subtype`, `sequence`, `playbook_state` (JSONB — full state at that moment), `node_output`, `created_at`.

### 3. Recent executions per workflow
```typescript
const recent = await WorkflowCheckpointModel.recentExecutions(workflowId, 5);
// [{ execution_id, node_label, node_id, sequence, created_at }, ...]
```

**Debug plan:**
1. Get the executionId from the user (or recent runs)
2. Grep the playbook log
3. Pull the checkpoint trail — see what completed
4. Identify the gap — the failed node is the one **after** the last checkpoint
5. Inspect `node_output` of the last checkpoint for upstream context the failed node received
6. Read the workflow definition to see the failed node's config and what it tried to do

## Restart from checkpoint

```bash
# List recent runs:
sulla meta/restart_from_checkpoint '{"workflowId":"daily-planning"}'

# List checkpoints in a run:
sulla meta/restart_from_checkpoint '{"executionId":"wfp-..."}'

# Restart from a specific node (re-runs that node + everything after):
sulla meta/restart_from_checkpoint '{
  "executionId": "wfp-...",
  "nodeId":      "the-node-that-failed"
}'
```

Internally:
1. Finds the checkpoint **before** the named node (`findCheckpointBefore`)
2. Restores the playbook state from that checkpoint's `playbook_state` JSONB
3. Generates a new executionId with `-restart-<timestamp>` suffix
4. Resumes the playbook walker from the target node

## Schedule a workflow

Schedules are **not stored in a separate table** — they live in a `schedule` trigger node inside the workflow definition.

Add a trigger node like:
```yaml
- id: trigger-schedule
  type: workflow
  position: { x: 100, y: 100 }
  data:
    subtype: schedule
    category: trigger
    label: "Daily 9am"
    config:
      frequency: daily              # daily | weekly | monthly | hourly | every-minutes
      hour: 9
      minute: 0
      # weekly: dayOfWeek (0–6, 0=Sun)
      # monthly: dayOfMonth (1–31)
      # every-minutes: intervalMinutes
      timezone: America/Los_Angeles
```

Set the workflow row to `status: "production"` and the **WorkflowSchedulerService** picks it up:
- Builds a 5-field cron from the config (`0 9 * * *` for the example above)
- Registers via `node-schedule`
- Fires `executeRoutine(workflowId, triggerMessage)` when cron matches

To inspect what's scheduled:
```typescript
WorkflowSchedulerService.getInstance().getScheduledJobs();
// [{ workflowId, workflowName, cronExpression, timezone, nextInvocation }, ...]
```

## List, archive, delete

There's **no dedicated list_workflows tool**. Query the model:
```typescript
const { WorkflowModel } = await import('.../WorkflowModel');
const all       = await WorkflowModel.listAll();
const prod      = await WorkflowModel.listByStatus('production');
const drafts    = await WorkflowModel.listByStatus('draft');
const archived  = await WorkflowModel.listByStatus('archive');
```

To archive: set `status: 'archive'` on the row. The scheduler refreshes and deregisters its cron.
To delete: remove the row. Checkpoints and history rows are preserved for audit.

## Stop a running workflow

There's no public stop tool. The PlaybookController watches for an abort instruction in the orchestrating agent's response — if the agent emits `⛔ ABORT` or `Workflow aborted: <reason>`, the controller flips status to `aborted` and stops processing the frontier. Outside that, the workflow runs to completion.

If the user wants a hard kill, the only option today is restarting the Sulla Desktop app — which is a heavy hammer. Tell them so.

## Status model

**Workflow playbook status:** `running` | `completed` | `failed` | `aborted`
**Per-node status (real-time WebSocket events only, not persisted per-node):** `pending` | `running` | `completed` | `failed` | `skipped` | `waiting`

Per-node errors are NOT stored in the DB — they're logged to `playbook-debug.log` and emitted as `node_failed` WebSocket events at runtime.

## Output flow between nodes

Resolved at runtime by `resolveTemplate()` in WorkflowPlaybook.ts:

```
{{trigger}}        — trigger node's input payload
{{Node Label}}     — output of node by its display label
{{node-id}}        — output of node by its id
{{loop.current}}   — current loop iteration value
{{loop.index}}     — current loop iteration index
```

See `node-types.md` for per-subtype output shapes.

## Reference

- Authoring skill (canonical): `~/sulla/resources/environment/create-workflow.md`
- Tool manifests: `pkg/rancher-desktop/agent/tools/workflow/manifests.ts`
- Validator: `pkg/rancher-desktop/agent/tools/workflow/validate_sulla_workflow.ts`
- Execute: `pkg/rancher-desktop/agent/tools/workflow/execute_workflow.ts`
- Restart: `pkg/rancher-desktop/agent/tools/workflow/restart_from_checkpoint.ts`
- Scheduler: `pkg/rancher-desktop/agent/services/WorkflowSchedulerService.ts`
- Playbook engine: `pkg/rancher-desktop/agent/workflow/WorkflowPlaybook.ts`
- Controller: `pkg/rancher-desktop/agent/controllers/PlaybookController.ts`
- Models: `WorkflowModel`, `WorkflowCheckpointModel`, `WorkflowHistoryModel` under `pkg/rancher-desktop/agent/database/models/`
