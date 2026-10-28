---
slug: sulla-schedule-or-trigger-workflow
label: Schedule or trigger a Sulla workflow
trigger_when: When you need to arm, inspect, catch up, manually run, or change the status of a workflow schedule.
trigger_actions: [schedule workflow, trigger workflow, refresh schedule, catch up workflow]
trigger_phrases: [schedule, trigger workflow, missed run, production workflow]
scope: [sulla-workflows]
---

**Do:**
1. Use `sulla workflow/set_workflow_status '{"id":"<id>","status":"production","enabled":true}'` to change the database status and re-arm schedules.
2. Verify armed schedules with `sulla workflow/refresh_schedules '{}'`.
3. Inspect missed fires first with `sulla workflow/catch_up_schedules '{"dryRun":true}'`; dispatch only when intended with `dryRun:false` and a bounded `lookbackDays`.
4. Run an exact registered workflow with `sulla meta/execute_workflow '{"workflowId":"<exact-slug>"}'`.

**Don't:** assume a file folder changes runtime status or guess a workflow slug.
