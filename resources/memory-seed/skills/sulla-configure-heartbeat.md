---
slug: sulla-configure-heartbeat
label: Configure Sulla heartbeat
trigger_when: When a user wants to enable, disable, tune, or understand autonomous heartbeat runs.
trigger_actions: [enable heartbeat, disable heartbeat, set heartbeat interval, inspect heartbeat]
trigger_phrases: [heartbeat, proactive agent, background agent, heartbeat interval]
scope: [sulla-heartbeat]
---

**Do:**
1. Read settings with `sulla settings/settings_get '{}'`.
2. Set enablement with `sulla settings/settings_set '{"property":"heartbeatEnabled","value":"true","cast":"boolean"}'`.
3. Set cadence with `sulla settings/settings_set '{"property":"heartbeatDelayMinutes","value":"10","cast":"number"}'`.
4. Use `heartbeatWindow` only with verified JSON fields `days`, `startHour`, `endHour`, and `tz`.
5. Describe runtime status from the in-process service status/history, not a guessed CLI command.

**Don't:**
- use heartbeat for ordinary user work or as a generic cron.
- claim a heartbeat task was completed without checking its result.
