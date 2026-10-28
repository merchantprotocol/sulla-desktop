---
slug: sulla-debug-workflow-run
label: Inspect, debug, and restart a Sulla workflow run
trigger_when: When a workflow failed, paused, is waiting for input, became suspended, has a zombie run, or must resume from a checkpoint.
trigger_actions: [debug workflow, inspect workflow failure, restart workflow, pause workflow, resume workflow]
trigger_phrases: [workflow failed, workflow paused, waiting workflow, zombie run, checkpoint, restart workflow]
scope: [sulla-workflows]
---

**Do:**
1. Read the compact exceptions-only view: `sulla workflow/routines_digest '{}'`. Do not re-query healthy routines.
2. For a flagged workflow, read its latest trace: `sulla workflow/routine_report '{"slug":"<slug>","last_k":1}'`.
3. If needed, list recent executions: `sulla meta/restart_from_checkpoint '{"workflowId":"<slug>"}'`.
4. List one execution's checkpoints: `sulla meta/restart_from_checkpoint '{"executionId":"<execution-id>"}'`.
5. Fix the definition or function first. Validate and dry-run changed workflow YAML before retrying.
6. Restart at the first node that must be re-executed: `sulla meta/restart_from_checkpoint '{"executionId":"<execution-id>","nodeId":"<node-id>"}'`. Upstream checkpoint outputs seed the resumed run when available.
7. Pause cooperatively with `sulla meta/pause_workflow '{"executionId":"<execution-id>","reason":"<reason>"}'`; resume with `sulla meta/resume_workflow '{"executionId":"<execution-id>"}'`.
8. Stop cooperatively with `sulla meta/stop_workflow '{"executionId":"<execution-id>","reason":"<reason>"}'`.
9. Read the new `routine_report` once and confirm the failed node and downstream output recovered.

**Know:** Pause and stop are checked between frontier steps. They do not cancel an in-flight agent or long-running model call.

**Don't:** Restart blindly, restart before fixing a deterministic failure, or assume a suspended worker has terminated.
