---
slug: sulla-debug-workflow
label: Diagnose a failed workflow
trigger_when: When a workflow failed or the user asks what happened in a past run.
trigger_actions: [debug workflow, inspect workflow run, restart from checkpoint]
trigger_phrases: [workflow failed, why did workflow fail, workflow history]
scope: [sulla-workflows]
---

**Do:**
1. Find recent runs with `sulla workflow/routine_report '{"slug":"<slug>","last_k":10}'`.
2. Inspect one run with `sulla meta/restart_from_checkpoint '{"executionId":"<id>"}'`.
3. Identify the first failed or uncompleted node after the last checkpoint; check logs only for that execution id.
4. Restart from a known safe node only after checking idempotence.

**Don't:**
- rerun a side-effecting workflow blindly.
- call a post-hoc checkpoint trail a live state stream.
