# Heartbeat

The heartbeat is an **autonomous background agent** that wakes up on a schedule to check on active goals, surface observations, and take initiative without waiting for the user. Think of it as Sulla's standing self-directed shift.

## Cadence and lifecycle

- **Default cadence:** every 15 minutes (configurable via `SullaSettingsModel.get('heartbeatDelayMinutes', 15)`)
- **Default state:** disabled (`heartbeatEnabled` defaults to `false`)
- **Tick alignment:** scheduler checks every minute on the minute; elapsed time since the last run controls the interval
- **Sleep prevention:** the enabled operator holds `heartbeat-standing` even outside its configured window; each run also holds `heartbeat` until completion. Disabling releases the standing hold and aborts an in-flight run
- **Overlap protection:** if a previous heartbeat is still running when the next tick fires, the new tick is skipped (recorded as `heartbeat_already_running`)
- **Abortable:** in-flight heartbeat can be aborted via `activeAbort.abort()` — subconscious middleware, graph execution, and tool calls all respect the signal

## What happens on each tick

1. Check `heartbeatEnabled`. If false, record `heartbeat_skipped`, return.
2. Check elapsed since last trigger. If less than `heartbeatDelayMinutes`, record `scheduler_check`, return.
3. Acquire abort signal, start caffeinate.
4. Build a timestamp trigger with optional `heartbeatMobileInstructions`.
   HeartbeatNode's SystemPromptBuilder assembles the system prompt.
5. Run `GraphRegistry.getOrCreateOverlordGraph('heartbeat', fullPrompt)`.
6. Execute the graph, tracking completion, errors and aborts.
7. Release the run's caffeinate hold and record the result in the event history
   and run audit. The standing hold remains while enabled.

## Projects and Heartbeat

Projects is a plain board; nothing in the app claims or launches tasks. Each
project's assigned agent (usually its project manager) drives it, can delegate work, and checks progress on its own chat heartbeat. Heartbeat is not a
task dispatcher: it works its own idea lab and tasks assigned to `heartbeat`,
and tells a project's assigned agent when that project looks stuck rather than
doing the work itself.

## Human comments on tickets

When the human comments on a Projects ticket (desktop Projects UI or Sulla Mobile, both stamp author `human`), Heartbeat owes that ticket a look, whatever its lane, parked/blocked/done state or dependencies.

- The comment wakes Heartbeat at the next minute check instead of waiting out `heartbeatDelayMinutes` (the enabled switch and `heartbeatWindow` still apply).
- The Heartbeat project report opens with **💬 Human comments awaiting your reply** (last 14 days, oldest first), and the oldest one becomes the hydrated `<selected_project_item>` ahead of normal lane work.
- Heartbeat reads the comment, then changes the ticket (`update_task`), tells the task's assignee or the project's assigned agent, or answers. It always finishes with `add_task_comment author="heartbeat"`; that reply clears the ticket from the queue.
- Agents cannot post comments as `human` (`add_task_comment` refuses `human`/`user`/`owner`/`me`), so only the real human can trigger this.

## Channel & messaging

The heartbeat owns the `heartbeat` channel. Other agents can message it via inter-agent XML tags:

```
<channel:heartbeat>Are you online?</channel:heartbeat>
```

Fire-and-forget — don't poll. If it responds, the reply lands on your channel.

## Status and history

The HeartbeatService keeps a 200-event circular buffer:

| Event | Meaning |
|-------|---------|
| `scheduler_started` | Service initialized |
| `scheduler_check` | Tick fired, conditions evaluated |
| `heartbeat_triggered` | Run starting |
| `heartbeat_completed` | Run finished cleanly |
| `heartbeat_skipped` | Disabled or interval not elapsed |
| `heartbeat_already_running` | Previous run still in flight |
| `heartbeat_aborted` | Manual abort fired |
| `heartbeat_error` | Run threw |
| `sleep_prevention_started` / `wake_scheduled` | Caffeinate state |

`HeartbeatService.getStatus()` returns:
```typescript
{
  initialized:      boolean,
  isExecuting:      boolean,
  lastTriggerMs:    number,
  schedulerRunning: boolean,
  totalTriggers:    number,
  totalErrors:      number,
  totalSkips:       number,
  uptimeMs:         number
}
```

## Common requests

### "What's the heartbeat doing?"
`getStatus()` and `getHistory()` are in-process service methods, not CLI commands. In application code, read status and the last 10 history entries. Summarize:
- Is it enabled? (check `SullaSettingsModel`)
- When did it last fire?
- What did the last run do? (last DONE wrapper summary)

### "Pause / resume the heartbeat"

Use the settings tools, not raw Redis writes or a shell import of the model:

```bash
sulla settings/settings_set '{"property":"heartbeatEnabled","value":"false","cast":"boolean"}'
sulla settings/settings_set '{"property":"heartbeatEnabled","value":"true","cast":"boolean"}'
```

### "Make the heartbeat check every 10 minutes"

```bash
sulla settings/settings_set '{"property":"heartbeatDelayMinutes","value":"10","cast":"number"}'
```

`heartbeatWindow` optionally restricts days (0–6), start/end hours and timezone.
Read current settings with `settings/settings_get`.

### "Show me heartbeat history"
`HeartbeatService.getHistory(50)` — returns the last 50 events with timestamps, types, durations, errors. If the user asks for older history, tell them: only the last 200 events are kept in this in-memory buffer; run audit persistence is separate.

### "Trigger a heartbeat now"
There's a `forceCheck()` on the service. The agent rarely needs this — usually a regular agent run is more appropriate than forcing the heartbeat to wake.

## When NOT to use the heartbeat

- For one-off scheduled tasks → use `calendar/calendar_create` or a `schedule` trigger node in a workflow
- For user-initiated work → just respond in the active channel, don't queue it for the heartbeat
- For high-frequency monitoring → workflows with `every-minutes` cron are better

The heartbeat is for **proactive ambient work**, not as a generic cron.

## Reference

- Service: `pkg/sulla-desktop/agent/services/HeartbeatService.ts`
- Node: `pkg/sulla-desktop/agent/nodes/HeartbeatNode.ts`
- Notification window: `pkg/sulla-desktop/main/heartbeatNotification.ts`
- Settings model: `pkg/sulla-desktop/agent/database/models/SullaSettingsModel.ts`
