---
slug: sulla-debug-workflow-run
label: Debug a Sulla workflow run
trigger_when: When a workflow failed, paused, became suspended, has a zombie run, or needs checkpoint recovery.
trigger_actions: [debug workflow, inspect workflow failure, restart workflow, pause workflow]
trigger_phrases: [workflow failed, workflow paused, zombie run, checkpoint]
scope: [sulla-workflows]
---

**Do:**
1. Read the compact health digest: `sulla workflow/routines_digest '{}'`.
2. Drill down only for a flagged routine: `sulla workflow/routine_report '{"slug":"<slug>","last_k":1}'`.
3. List executions with `sulla meta/restart_from_checkpoint '{"workflowId":"<slug>"}'`; list checkpoints with its `executionId`.
4. Restart from a known checkpoint with `sulla meta/restart_from_checkpoint '{"executionId":"<id>","nodeId":"<node-id>"}'`.
5. Stop, pause, or resume using the exact `executionId` and `sulla meta/stop_workflow`, `sulla meta/pause_workflow`, or `sulla meta/resume_workflow`.

**Don't:** retry a suspended run blindly; verify pending workers have terminated first.
