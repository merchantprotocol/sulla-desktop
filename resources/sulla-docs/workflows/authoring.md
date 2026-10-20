# Workflow Authoring & Lifecycle

Companion to `schema.md` (structure), `node-types.md` (every node subtype), and `examples.md` (working patterns). This doc is the **how-to**: design, validate, debug, schedule, restart, stop.

## Where workflows live

| Location | Purpose | Who writes there |
|----------|---------|------------------|
| `~/sulla/routines/<slug>/routine.yaml` | **Routine source** — scaffolded by `marketplace/scaffold` and imported with `workflow/import_workflow` | Agent (preferred for net-new) |
| `~/sulla/workflows/{draft,production,archive}/<slug>.yaml` | **Flat-file workflow** — folder per status; mirrored into the File Manager at `Sulla/Use Cases/workflows/` | Agent (legacy / quick scripts) |
| `workflows` table (Postgres) | **Active workflows** — what the executor and scheduler run | Written by `workflow/import_workflow` and the app |

The row's `status` decides what runs: `draft` | `production` | `archive`. Only `production` rows get scheduled. Moving a file between folders does not change the row.

## Build a workflow — full flow

The canonical flow is **gather → draft → validate → save → import → test-run → done**. Validation is non-negotiable before import. See `agent-patterns/validation.md` for the overall policy.

1. **Gather requirements in conversation.** Don't start writing YAML until the user has agreed on:
   - Trigger (manual or schedule — the palette offers only these two)
   - Steps in plain English
   - Routing / conditions / loops
   - Failure mode (abort? continue? retry?)
2. **Read the authoring skill** before writing. The runtime copy is `~/sulla/resources/skills/create-workflow/SKILL.md`, and the docs mirror is [`create-workflow-skill.md`](create-workflow-skill.md).
3. **Draft the YAML** using `schema.md` and `node-types.md`. Common gotchas:
   - Every node needs `type: "workflow"`, `position: {x, y}`, and `data: {subtype, category, label, config}`
   - `subtype` and `category` must match (e.g., `agent` → `agent`, `router` → `routing`, `desktop-notification` → `io`)
   - Required config fields per subtype are listed in `node-types.md`. An `agent` node needs all six: `agentId`, `agentName`, `additionalPrompt`, `orchestratorInstructions`, `successCriteria`, `completionContract`
   - Edges use `id`, `source`, `target`, and optionally `sourceHandle`, `targetHandle`, `label`, `animated`
   - At least one trigger node, and every downstream node reachable from it
4. **Validate** — run BOTH validators (see next section). Fix errors, re-run until clean.
5. **Save** the YAML to `~/sulla/routines/<slug>/routine.yaml`.
6. **Import** it as a draft: `sulla workflow/import_workflow '{"slug":"<slug>","yaml":"<full yaml>","status":"draft"}'`. **Always pass `status: "draft"` while authoring.** The import default is `production`, and a production row is scheduled.
7. **Test-run** the graph: `sulla meta/execute_workflow '{"workflowId":"<slug>"}'`, then check the run. A clean validator pass doesn't prove the nodes do the right thing; only a real run does.

## Validate

Run both passes. Each catches things the other doesn't.

### Pass 1 — graph validator (required)

```bash
sulla meta/validate_sulla_workflow '{"filePath":"/path/to/routine.yaml"}'
# or inline:
sulla meta/validate_sulla_workflow '{"yaml":"...full yaml string..."}'
```

What it checks:
- Top-level keys. Anything outside the allowed set is an error (for example `_status` or `tags`).
- `maxConcurrentRuns` is a positive integer when present
- Node structure (`type: "workflow"`, `position`, `data.{subtype,category,label,config}`)
- Subtype↔category mapping
- Required config fields per subtype
- Edge keys
- `maxAgents`, when set on an agent node, is `1`
- At least one trigger node
- Reachability (no orphaned chains downstream of triggers)

The validator does not check edge handle values. A wrong `sourceHandle` passes validation, so check handles by hand against `schema.md`.

### Pass 2 — kind-schema validator (required for routines)

```bash
sulla marketplace/validate '{"kind":"workflow","slug":"<slug>"}'
```

It checks manifest-level issues the graph validator doesn't look at: slug/id/directory agreement and required metadata.

### Reading output

Both return `ValidationIssue[]` with `severity: "error"|"warning"`, `path`, `message`. **Errors mean the workflow won't load or will load broken.** Fix and re-run until clean before reporting done. Warnings are safe to surface; let the user decide.

Common fixable errors:
- `Subtype "x" requires category "y"` — the pair is wrong (see `node-types.md`)
- `Missing required config field "x"` — see `node-types.md`
- `Invalid top-level key` — remove the key (see `schema.md`)
- `no trigger node` — add a `manual` or `schedule` trigger
- `slug/id/directory disagreement` — these three must line up for routines

Never skip validation because "it's a small change."

## Run a workflow

```bash
sulla meta/execute_workflow '{
  "workflowId": "daily-planning",
  "message":    "optional payload to the trigger node",
  "resume":     false,
  "resumeExecutionId": "wfp-..."
}'
```

`resume: true` resumes the latest checkpoint. `resumeExecutionId` targets a specific past run. Only `workflowId`, `message`, and `resume` appear in the published tool manifest.

It returns right away with the run's id and status:
```json
{
  "executionId":  "wfp-1719283859000-abcdef",
  "workflowSlug": "daily-planning",
  "workflowName": "Daily Planning",
  "status":       "activated",
  "message":      "..."
}
```

The run proceeds asynchronously. Check it with `sulla workflow/routine_report '{"executionId":"wfp-..."}'`, which returns status, timing, errors, and the step-by-step trace from `workflow_checkpoints`.

## Where a run executes

The same `WorkflowPlaybook.ts` engine runs in two places:

- **Workflow service** (`services/sulla-workflows`). A `manager` container (`sulla_workflow_manager`, image `sulla-workflows:local`) exposes the HTTP API. Each execution starts its own **runner** container (`SULLA_WORKFLOW_ROLE=runner`, `SULLA_EXECUTION_ID` set, run token mounted as a file). The manager's routes include `/v1/workflows`, `/v1/runs` (start, list, stop, resume, restart), `/v1/schedules/refresh`, `/v1/schedules/catch-up`, and the `/internal/*` tool and agent callbacks.
- **In-app controller** (`PlaybookController.ts`). Runs inside the Electron agent process.

Runner containers don't write `~/sulla/logs/playbook-debug.log`. Use `routine_report` and the checkpoints to inspect a run, not that log file.

## Debug a failing workflow

### 1. Run report (start here)
```bash
sulla workflow/routine_report '{"executionId":"wfp-..."}'
sulla workflow/routine_report '{"slug":"daily-planning"}'
```

### 2. Playbook debug log (in-app runs only)
**File:** `~/sulla/logs/playbook-debug.log`. One JSON object per line. Tags written by `PlaybookController.ts` include `workflow_started`, `node_completed`, `orchestrator_abort`, and `workflow_failed`.

```bash
grep "<executionId>" ~/sulla/logs/playbook-debug.log
```

### 3. Checkpoints
Table `workflow_checkpoints` holds one row per **successful** node. A failed node has no checkpoint. Each row has `execution_id`, `node_id`, `node_subtype`, `sequence`, `playbook_state` (JSONB), `node_output`, and `created_at`.

List them with the restart tool:
```bash
sulla meta/restart_from_checkpoint '{"executionId":"wfp-..."}'
```

**Debug plan:**
1. Get the executionId from the user, or from the list of recent runs
2. Run `routine_report` for the status and trace
3. Find the gap: the failed node is the one **after** the last checkpoint
4. Check the last checkpoint's `node_output` for what the failed node received
5. Read the workflow definition to see the failed node's config

## Restart from checkpoint

```bash
# List recent runs of a workflow:
sulla meta/restart_from_checkpoint '{"workflowId":"daily-planning"}'

# List checkpoints in a run:
sulla meta/restart_from_checkpoint '{"executionId":"wfp-..."}'

# Restart from a specific node (re-runs that node and everything after it):
sulla meta/restart_from_checkpoint '{
  "executionId": "wfp-...",
  "nodeId":      "the-node-that-failed"
}'
```

It finds the checkpoint **before** the named node, restores the playbook state from that checkpoint, creates a new execution id with a `-restart-<timestamp>` suffix, and resumes from the target node.

## Schedule a workflow

Schedules are **not stored in a separate table.** They come from a `schedule` trigger node inside the definition:

```yaml
- id: node-001
  type: workflow
  position: { x: 100, y: 100 }
  data:
    subtype: schedule
    category: trigger
    label: "Daily 9am"
    config:
      triggerType: schedule
      triggerDescription: "Daily at 9am Pacific"
      frequency: daily              # daily | weekly | monthly | hourly | every-minutes
      hour: 9
      minute: 0
      # weekly: dayOfWeek (0–6, 0=Sun)
      # monthly: dayOfMonth (1–31)
      # every-minutes: intervalMinutes
      timezone: America/Los_Angeles
```

Set the row to `production` when it's ready:
```bash
sulla workflow/set_workflow_status '{"name":"Daily 9am Planning","status":"production"}'
```

`set_workflow_status` re-arms the scheduler right away. Use `sulla workflow/refresh_schedules '{}'` to re-scan production workflows and see the armed cron and next fire time. After a restart, `sulla workflow/catch_up_schedules '{"dryRun":true}'` lists fires that were missed. Drop `dryRun` to dispatch them.

## Status, archive, delete

- **Change status:** `sulla workflow/set_workflow_status '{"id":"...","status":"draft|production|archive"}'` (or `name` instead of `id`). Setting `archive` deregisters the schedule.
- **Enable or disable:** same tool, with `enabled`.
- **Delete:** no delete tool is published. Ask the user before removing a row or folder.

## Stop, pause, resume

```bash
sulla meta/stop_workflow '{"executionId":"wfp-...","reason":"..."}'
sulla meta/pause_workflow '{"executionId":"wfp-...","reason":"..."}'
sulla meta/resume_workflow '{"executionId":"wfp-..."}'
```

These are cooperative. They set a Redis flag that the controller checks on each step. If the orchestrator is inside a long sub-agent or LLM call, the stop takes effect when that call returns. An agent can also end a run itself by putting `<ABORT_WORKFLOW>reason</ABORT_WORKFLOW>` in its response.

For an immediate hard kill, restart Sulla Desktop. Tell the user that's the only hard stop.

## Status model

**Playbook status:** `running` | `completed` | `failed` | `aborted`

**Per-node status** (sent as WebSocket events): `pending` | `running` | `completed` | `failed` | `skipped` | `waiting`

## Output flow between nodes

Resolved at runtime by `resolveTemplate()` in `WorkflowPlaybook.ts`:

```
{{trigger}}                    — trigger node's input payload
{{Node Label}}                 — output of node by its display label
{{node-id}}                    — output of node by its id
{{Node Label.result}}          — the node's result
{{Node Label.threadId}}        — thread id from a sub-agent run
{{loop.index}}                 — current loop iteration index (0-based)
{{loop.currentItem.result}}    — current item's result, in for-each loops
```

Any other field stays as a literal. See `schema.md` for the full list and `node-types.md` for per-subtype output shapes.

## Reference

- Authoring skill mirror: [`create-workflow-skill.md`](create-workflow-skill.md)
- Tool manifests: `pkg/rancher-desktop/agent/tools/workflow/manifests.ts`
- Validator: `pkg/rancher-desktop/agent/tools/workflow/validate_sulla_workflow.ts`
- Execute: `pkg/rancher-desktop/agent/tools/workflow/execute_workflow.ts`
- Restart: `pkg/rancher-desktop/agent/tools/workflow/restart_from_checkpoint.ts`
- Import and status: `pkg/rancher-desktop/agent/tools/workflow/import_workflow.ts`, `set_workflow_status.ts`
- Scheduler: `pkg/rancher-desktop/agent/services/WorkflowSchedulerService.ts`
- Playbook engine: `pkg/rancher-desktop/agent/workflow/WorkflowPlaybook.ts`
- In-app controller: `pkg/rancher-desktop/agent/controllers/PlaybookController.ts`
- Workflow service (manager and runner): `services/sulla-workflows/src/manager.ts`, `runner.ts`, `launcher.ts`
- Models: `WorkflowModel`, `WorkflowCheckpointModel`, `WorkflowHistoryModel` under `pkg/rancher-desktop/agent/database/models/`
