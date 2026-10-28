---
slug: sulla-tool-workflow
label: Use the Sulla workflow tools
trigger_when: When you need to inspect or control workflow definitions and runs.
trigger_actions: [workflow, Sulla workflow tool, tool call]
trigger_phrases: [workflow]
scope: [tool-workflow]
---

**When:** Use `exec` to dispatch an exact `sulla workflow/<tool>` command. Discover current tools with `sulla meta/browse_tools '{"category":"workflow"}'` before an unfamiliar call.

**Tools:**
- `sulla workflow/execute_workflow '{"workflowId":"<workflowId>"}'`: Execute a pre-registered workflow by its EXACT slug. Only call this when the slug appears verbatim in the "Available workflows" section of your system prompt — never guess a slug from the user request (e.g. do NOT invent slugs like "browser-tab-open" or "ask-date-time" unless they are explicitly listed). If no workflow matches the user intent, use exec({ command: "sulla <category>/<tool> \'...\'\" }) instead — NOT this tool. This tool CANNOT open browser tabs, run shell commands, or call sulla CLI tools. Required: workflowId.
- `sulla workflow/validate_sulla_workflow '{}'`: Validate a Sulla workflow YAML file for structural correctness before it goes live. Checks top-level schema, node types, subtype/category mapping, required config fields, edge format, trigger presence, and reachability. Use this EVERY time you create or edit a Sulla workflow YAML. Required: none.
- `sulla workflow/import_workflow '{"slug":"<slug>","yaml":"<yaml>"}'`: Import an inline YAML workflow definition into Sulla Files as a draft. Only a published version can be executed. Required: slug, yaml.
- `sulla workflow/refresh_schedules '{"schemaDef":"<schemaDef>"}'`: Force WorkflowSchedulerService to re-scan production workflows and re-arm all schedule triggers, then report exactly what is armed (cron, timezone, next fire time). Use after any direct DB change to workflows, or to verify a routine is actually armed — no restart, no log-grepping. Required: schemaDef.
- `sulla workflow/set_workflow_status '{}'`: Enable/disable a workflow or change its status (draft | production | archive) by id or exact name, then re-arm the scheduler so the change takes effect immediately without an app restart. Reports the workflow\'s armed cron state after the change. Required: none.
- `sulla workflow/routines_digest '{"schemaDef":"<schemaDef>"}'`: Deterministic delta + exceptions-only digest of routine health (zero-LLM to produce, tiny to consume). All-green with nothing new = one line; otherwise lists only routines whose last run failed, that have a zombie run, or that were newly created in the last 24h. This is the standing routine-stewardship context — read it, do NOT re-query routine state. Required: schemaDef.
- `sulla workflow/find_repeated_tasks '{}'`: Promotion detector for routine stewardship: returns operations that have recurred across >= threshold DISTINCT sessions (deterministic shape-signature over the per-action tool log; zero-LLM) as candidates to codify into a routine (needs judgment) or a zero-token function (deterministic). Call this when deciding what recurring work to push down the cost ladder. Args: threshold (optional, default 3 distinct sessions), limit (optional, default 20). Required: none.
- `sulla workflow/display_workflow '{"slug":"<slug>"}'`: Surface a Postgres-backed routine as a workflow artifact in the chat sidebar. Required: slug.
- `sulla workflow/restart_from_checkpoint '{}'`: Restart a workflow execution from a specific node checkpoint. Use workflowId alone to list recent executions, executionId alone to list checkpoints, or executionId + nodeId to restart from that node. Required: none.
- `sulla workflow/stop_workflow '{"executionId":"<executionId>"}'`: Request a running workflow to stop. Cooperative — writes a Redis flag the PlaybookController checks at each frontier tick, so the running orchestrator honors it on its next step. If the orchestrator is blocked on a long-running sub-agent or LLM call, the abort takes effect when that call returns. For immediate hard-kill, restart Sulla Desktop. Required: executionId.
- `sulla workflow/pause_workflow '{"executionId":"<executionId>"}'`: Pause a running workflow without releasing it. Cooperative — PlaybookController checks a Redis flag at each frontier tick and halts frontier advance. In-flight sub-agent work is NOT cancelled. Resume with resume_workflow. Required: executionId.
- `sulla workflow/resume_workflow '{"executionId":"<executionId>"}'`: Resume a workflow paused with pause_workflow by clearing its pause flag. The orchestrator resumes frontier advance on its next tick. Required: executionId.
- `sulla workflow/dry_run_workflow '{}'`: Walk a workflow statically — parse YAML, traverse from triggers, report execution order and any orphans or runtime-ambiguous branches. Does NOT execute any node (no side effects). Use to verify routing before committing to a live run. Required: none.

**Do:**
1. Discover the category when names or parameters may have changed.
2. Run the command through `exec`, passing one JSON object with required parameters.
3. Treat returned IDs, cursors, and SHAs as inputs to the next call; verify destructive or outward-facing results.

**Don't:**
- Don't execute a workflow when validation or dry-run is the goal.
- Don't guess IDs or mutate a live run without checking its state.
