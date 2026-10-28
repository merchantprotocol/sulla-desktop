---
slug: sulla-schedule-or-trigger-workflow
label: Schedule, trigger, and catch up a recurring workflow
trigger_when: When work should run on a schedule, a recurring job needs automation, a schedule may have been missed, or a registered workflow should run now.
trigger_actions: [schedule workflow, trigger workflow, refresh schedule, catch up workflow, automate recurring job]
trigger_phrases: [schedule, recurring job, trigger workflow, missed run, production workflow, reminder]
scope: [sulla-workflows]
---

**Choose:** Use a workflow when the event should perform work, branch, call tools, wait for approval, or produce an artifact. Use a reminder only when the desired result is to notify the human.

**Do:**
1. Build a `schedule` trigger with config fields `triggerType`, `triggerDescription`, `frequency`, `intervalMinutes`, `hour`, `minute`, `dayOfWeek`, `dayOfMonth`, and `timezone`. Use an IANA timezone when wall-clock time matters.
2. Validate, dry-run, import, and publish the workflow before arming it.
3. Set runtime state with an exact id: `sulla workflow/set_workflow_status '{"id":"<slug>","status":"production","enabled":true}'`.
4. Re-scan and verify the cron, timezone, and next fire: `sulla workflow/refresh_schedules '{}'`.
5. After downtime, inspect missed fires without dispatching: `sulla workflow/catch_up_schedules '{"dryRun":true,"lookbackDays":7}'`.
6. Dispatch the bounded catch-up only when intended: `sulla workflow/catch_up_schedules '{"dryRun":false,"lookbackDays":7}'`.
7. Run immediately with `sulla meta/execute_workflow '{"workflowId":"<exact-slug>","message":"<input>"}'`.
8. Confirm outcomes with `sulla workflow/routines_digest '{}'`.

**Don't:** Use cron, assume a Files folder arms a schedule, guess an id, or use a recurring workflow merely to display a reminder.
