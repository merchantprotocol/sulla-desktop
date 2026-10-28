---
slug: sulla-tool-workflow
label: Use the Sulla workflow tools
trigger_when: When you need to import, validate, inspect, schedule, diagnose, or control a Sulla workflow.
trigger_actions: [workflow, Sulla workflow tool, tool call]
trigger_phrases: [workflow YAML, validate workflow, run a workflow, missed schedule, routine health, workflow checkpoint]
scope: [tool-workflow]
---

**When:** Use `exec` to dispatch an exact `sulla workflow/<tool>` command. Discover current tools with `sulla meta/browse_tools '{"category":"workflow"}'` before an unfamiliar call.

**Tools:**

<!-- tools:generated:start -->
- `sulla workflow/catch_up_schedules '{}'`: Detect scheduled workflow fires that were missed (app off or scheduler dormant when the cron time passed) and dispatch them through the real executor. Compares each armed schedule's previous expected fire time against workflow_executions. Use after a restart or whenever a routine may have missed its window; dryRun reports without firing. Required: none. Optional: dryRun, lookbackDays.
- `sulla workflow/display_workflow '{"slug":"<slug>"}'`: Surface a Postgres-backed routine as a workflow artifact in the chat sidebar. Required: slug. Optional: none.
- `sulla workflow/find_repeated_tasks '{}'`: Promotion detector for routine stewardship: returns operations that have recurred across >= threshold DISTINCT sessions (deterministic shape-signature over the per-action tool log; zero-LLM) as candidates to codify into a routine (needs judgment) or a zero-token function (deterministic). Call this when deciding what recurring work to push down the cost ladder. Args: threshold (optional, default 3 distinct sessions), limit (optional, default 20). Required: none. Optional: threshold, limit.
- `sulla workflow/import_workflow '{"slug":"<slug>","yaml":"<yaml>"}'`: Import an inline YAML workflow definition into Sulla Files as a draft. Only a published version can be executed. Required: slug, yaml. Optional: status.
- `sulla workflow/refresh_schedules '{}'`: Force WorkflowSchedulerService to re-scan production workflows and re-arm all schedule triggers, then report exactly what is armed (cron, timezone, next fire time). Use after any direct DB change to workflows, or to verify a routine is actually armed — no restart, no log-grepping. Required: none. Optional: none.
- `sulla workflow/routine_report '{}'`: Drill-down report for a routine flagged by routines_digest: last-run status, timing, error, and the step-by-step tool-call trace (from workflow_checkpoints) explaining why it did what it did. The diagnosis payload — pull it only when the digest flags a failure/zombie, never into standing context. Required: none. Optional: slug, executionId, last_k.
- `sulla workflow/routines_digest '{}'`: Deterministic delta + exceptions-only digest of routine health (zero-LLM to produce, tiny to consume). All-green with nothing new = one line; otherwise lists only routines whose last run failed, that have a zombie run, or that were newly created in the last 24h. This is the standing routine-stewardship context — read it, do NOT re-query routine state. Required: none. Optional: none.
- `sulla workflow/set_workflow_status '{}'`: Enable/disable a workflow or change its status (draft | production | archive) by id or exact name, then re-arm the scheduler so the change takes effect immediately without an app restart. Reports the workflow's armed cron state after the change. Required: none. Optional: id, name, status, enabled.
<!-- tools:generated:end -->
**Do:**
1. Validate a file with `sulla meta/validate_sulla_workflow '{"filePath":"/mnt/worktrees/<job>/routine.yaml"}'`.
2. Dry-run routing with `sulla meta/dry_run_workflow '{"filePath":"/mnt/worktrees/<job>/routine.yaml"}'`.
3. Import reviewed YAML as a draft with `sulla workflow/import_workflow '{"slug":"<slug>","yaml":"<complete-yaml>","status":"draft"}'`, then request publication using the returned Files ids.
4. Run only an exact registered id: `sulla meta/execute_workflow '{"workflowId":"<slug>","message":"<input>"}'`.
5. Check health with `sulla workflow/routines_digest '{}'`; use `sulla workflow/routine_report '{"slug":"<slug>","last_k":1}'` only for a flagged routine.
6. After downtime, inspect missed fires with `sulla workflow/catch_up_schedules '{"dryRun":true,"lookbackDays":7}'` before dispatching them.
7. For recovery, list runs and checkpoints with `sulla meta/restart_from_checkpoint`, then restart with exact `executionId` and `nodeId`.

**Don't:**
- Don't execute a workflow when validation or dry-run is the goal.
- Don't guess a workflow slug or mutate a live run without checking its state.
- Don't treat a dry run as proof that a live execution succeeded.
