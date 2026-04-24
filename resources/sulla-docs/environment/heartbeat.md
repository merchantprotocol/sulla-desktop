# Heartbeat

The heartbeat is an **autonomous background agent** that wakes up on a schedule to check on active goals, surface observations, and take initiative without waiting for the user. Think of it as Sulla's standing self-directed shift.

## Cadence and lifecycle

- **Default cadence:** every 15 minutes (configurable via `SullaSettingsModel.get('heartbeatDelayMinutes', 15)`)
- **Default state:** disabled (`heartbeatEnabled` defaults to `false`)
- **Tick alignment:** scheduler aligns to the minute boundary, then fires every N minutes from there
- **Sleep prevention:** while a heartbeat run is executing, the service calls `startCaffeinate('heartbeat')` to keep the Mac from sleeping mid-run; releases on completion
- **Overlap protection:** if a previous heartbeat is still running when the next tick fires, the new tick is skipped (recorded as `heartbeat_already_running`)
- **Abortable:** in-flight heartbeat can be aborted via `activeAbort.abort()` — subconscious middleware, graph execution, and tool calls all respect the signal

## What happens on each tick

1. Check `heartbeatEnabled`. If false, record `heartbeat_skipped`, return.
2. Check elapsed since last trigger. If less than `heartbeatDelayMinutes`, record `scheduler_check`, return.
3. Acquire abort signal, start caffeinate.
4. Build a system prompt that includes:
   - Current time, timezone
   - Active projects + goals (pulled via `subconscious` middleware: memory recall, observations)
   - Directive to work autonomously
5. Dispatch to the **HeartbeatGraph** via `GraphRegistry.getOrCreateOverlordGraph('heartbeat', fullPrompt)`
6. The HeartbeatNode loops: LLM → tool calls → check completion wrapper → loop or exit
7. On exit, show a desktop notification in the top-right frameless window with the run summary
8. Stop caffeinate, record `heartbeat_completed` (or `_error` / `_aborted`)

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
Read `getStatus()` and last 10 entries from `getHistory()`. Summarize:
- Is it enabled? (check `SullaSettingsModel`)
- When did it last fire?
- What did the last run do? (last DONE wrapper summary)

### "Pause / resume the heartbeat"
Toggle the setting:
```typescript
SullaSettingsModel.set('heartbeatEnabled', false /* or true */)
```
Next tick picks up the new value. There's no dedicated CLI tool for this — agent invokes the model directly or instructs the user to flip the setting in the UI.

### "Make the heartbeat check every 10 minutes"
```typescript
SullaSettingsModel.set('heartbeatDelayMinutes', 10)
```

### "Show me heartbeat history"
`HeartbeatService.getHistory(50)` — returns the last 50 events with timestamps, types, durations, errors. If the user asks for older history, tell them: only the last 200 events are kept in memory.

### "Trigger a heartbeat now"
There's a `forceCheck()` on the service. The agent rarely needs this — usually a regular agent run is more appropriate than forcing the heartbeat to wake.

## When NOT to use the heartbeat

- For one-off scheduled tasks → use `calendar/calendar_create` or a `schedule` trigger node in a workflow
- For user-initiated work → just respond in the active channel, don't queue it for the heartbeat
- For high-frequency monitoring → workflows with `every-minutes` cron are better

The heartbeat is for **proactive ambient work**, not as a generic cron.

## Reference

- Service: `pkg/rancher-desktop/agent/services/HeartbeatService.ts`
- Node: `pkg/rancher-desktop/agent/nodes/HeartbeatNode.ts`
- Notification window: `pkg/rancher-desktop/main/heartbeatNotification.ts`
- Settings model: `pkg/rancher-desktop/agent/database/models/SullaSettingsModel.ts`
