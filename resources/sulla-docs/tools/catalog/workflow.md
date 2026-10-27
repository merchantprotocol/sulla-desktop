# workflow tools

Workflow management — execute, validate, import, and manage Sulla workflow definitions.

## catch_up_schedules

Detect scheduled workflow fires that were missed (app off or scheduler dormant when the cron time passed) and dispatch them through the real executor. Compares each armed schedule's previous expected fire time against workflow_executions.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `dryRun` | boolean | Optional |
| `lookbackDays` | number | Optional |

**Example**

```bash
sulla workflow/catch_up_schedules '{}'
```

## display_workflow

Surface a Postgres-backed routine as a workflow artifact in the chat sidebar.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `slug` | string | Required |

**Example**

```bash
sulla workflow/display_workflow '{"slug":"<slug>"}'
```

## find_repeated_tasks

Promotion detector for routine stewardship: returns operations that have recurred across >= threshold DISTINCT sessions (deterministic shape-signature over the per-action tool log; zero-LLM) as candidates to codify into a routine (needs judgment) or a zero-token function (deterministic). Call this when deciding what recurring work to push down the cost ladder.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `threshold` | number | Optional |
| `limit` | number | Optional |

**Example**

```bash
sulla workflow/find_repeated_tasks '{}'
```

## import_workflow

Import an inline YAML workflow definition into Sulla Files as a draft. Only a published version can be executed.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `slug` | string | Required |
| `yaml` | string | Required |
| `status` | string | Optional |

**Example**

```bash
sulla workflow/import_workflow '{"slug":"<slug>","yaml":"<yaml>"}'
```

## refresh_schedules

Force WorkflowSchedulerService to re-scan production workflows and re-arm all schedule triggers, then report exactly what is armed (cron, timezone, next fire time). Use after any direct DB change to workflows, or to verify a routine is actually armed — no restart, no log-grepping.

**Parameters**

None.

**Example**

```bash
sulla workflow/refresh_schedules '{}'
```

## routine_report

Drill-down report for a routine flagged by routines_digest: last-run status, timing, error, and the step-by-step tool-call trace (from workflow_checkpoints) explaining why it did what it did. The diagnosis payload — pull it only when the digest flags a failure/zombie, never into standing context.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `slug` | string | Optional |
| `executionId` | string | Optional |
| `last_k` | number | Optional |

**Example**

```bash
sulla workflow/routine_report '{}'
```

## routines_digest

Deterministic delta + exceptions-only digest of routine health (zero-LLM to produce, tiny to consume). All-green with nothing new = one line; otherwise lists only routines whose last run failed, that have a zombie run, or that were newly created in the last 24h.

**Parameters**

None.

**Example**

```bash
sulla workflow/routines_digest '{}'
```

## set_workflow_status

Enable/disable a workflow or change its status (draft | production | archive) by id or exact name, then re-arm the scheduler so the change takes effect immediately without an app restart. Reports the workflow's armed cron state after the change.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `id` | string | Optional |
| `name` | string | Optional |
| `status` | string | Optional |
| `enabled` | boolean | Optional |

**Example**

```bash
sulla workflow/set_workflow_status '{}'
```
