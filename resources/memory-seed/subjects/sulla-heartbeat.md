---
slug: sulla-heartbeat
kind: system
name: Heartbeat
parent: sulla
aliases: [heartbeat, autonomous agent, background agent, proactive work, heartbeatWindow]
---

## Overview
Heartbeat is an optional autonomous agent that wakes on a scheduler cadence to inspect active goals and take initiative. It is disabled by default and runs only when enabled and its interval has elapsed. It is not a generic cron, task dispatcher, or replacement for user-initiated work.

## Facts
- The default heartbeat cadence is 15 minutes and `heartbeatEnabled` defaults to false.
- Scheduler checks happen every minute; if an earlier run is still active, the next run is skipped as `heartbeat_already_running`.
- Disabling heartbeat aborts an in-flight run and releases its standing sleep-prevention hold.
- Heartbeat runs use the `heartbeat` graph and can receive `heartbeatMobileInstructions` in the timestamp trigger.
- Heartbeat status and its last 200 events are in-process service state; they are not a flat CLI history tool.
- `heartbeatWindow` can restrict days, start hour, end hour, and timezone.
- Change settings with `sulla settings/settings_set`, for example `{"property":"heartbeatEnabled","value":"true","cast":"boolean"}` or `{"property":"heartbeatDelayMinutes","value":"10","cast":"number"}`.

## Rules
- DO: Use a workflow schedule for a one-off or high-frequency scheduled task. Why: heartbeat is ambient autonomous work.
- DO: Check enabled state, last trigger, and recent history before describing heartbeat status. Why: status is runtime state.
- DON'T: force a heartbeat for normal user work. Why: respond in the active channel instead.
- DON'T: claim heartbeat completed a project task just because it noticed it. Why: project files remain the assigned agent's responsibility.
