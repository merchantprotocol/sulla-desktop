# Calendar

Local-only calendar backed by Postgres. **No Google Calendar sync exists yet.** No native recurring-event support yet either.

## Tools

| Tool | Purpose |
|------|---------|
| `sulla calendar/calendar_create` | Create event or reminder |
| `sulla calendar/calendar_get` | Fetch one event by id |
| `sulla calendar/calendar_list` | List events in a date range |
| `sulla calendar/calendar_list_upcoming` | Next N days (default 7) |
| `sulla calendar/calendar_update` | Patch an event |
| `sulla calendar/calendar_cancel` | Soft-cancel (`status='cancelled'`, row preserved) |
| `sulla calendar/calendar_delete` | Hard delete |

Times are ISO 8601 strings with timezone (e.g., `2026-04-24T14:00:00-07:00`). The agent must compute the absolute time itself — there's no "tomorrow at 2pm" parser inside the tool.

## Schema

Postgres table `calendar_events`:

| Column | Type | Notes |
|--------|------|-------|
| `id` | serial | PK |
| `title` | varchar(500) | required |
| `start_time` | timestamptz | required, ISO with TZ |
| `end_time` | timestamptz | required |
| `description` | text | optional |
| `location` | varchar(500) | optional |
| `people` | jsonb | array of email strings, default `[]` |
| `calendar_id` | varchar(100) | optional grouping (e.g., "personal", "work") |
| `all_day` | boolean | default false |
| `status` | varchar(20) | `active` \| `cancelled` \| `completed` |

## What happens when an event fires

`SchedulerService` watches `calendar_events`. When `start_time` arrives:

1. Builds a prompt with the event title, time, attendees, location
2. Tries the **frontend channel `sulla-desktop`** first (3s ACK timeout) — user sees it in chat
3. Falls back to the **`calendar_event` channel** (autonomous agent picks it up)

This means scheduled events double as agent triggers. A calendar entry titled "Run weekly report" with `start_time: 2026-04-25T07:00:00` will spawn an autonomous agent run if the user isn't around to take it.

## Common requests

### "What's on my calendar today/this week?"
```bash
sulla calendar/calendar_list_upcoming '{"days":7}'
```

### "Schedule a meeting with X tomorrow at 2pm"
Compute the ISO time first (mind the user's timezone), then:
```bash
sulla calendar/calendar_create '{
  "title": "Sync with Sarah",
  "start": "2026-04-24T14:00:00-07:00",
  "end":   "2026-04-24T15:00:00-07:00",
  "people": ["sarah@example.com"]
}'
```

### "Remind me to do X tomorrow at 9am"
Same tool — reminders aren't a separate type. Use a short event:
```bash
sulla calendar/calendar_create '{
  "title": "Reminder: review the PR",
  "start": "2026-04-24T09:00:00-07:00",
  "end":   "2026-04-24T09:05:00-07:00"
}'
```

When the start time fires, SchedulerService will surface it in the chat (or fire an autonomous agent if the user is away).

### "Reschedule that to Friday"
Get the event id (from `calendar_list` if needed), then:
```bash
sulla calendar/calendar_update '{
  "eventId": 123,
  "start":   "2026-04-26T14:00:00-07:00",
  "end":     "2026-04-26T15:00:00-07:00"
}'
```

### "Cancel that meeting"
Prefer soft cancel (preserves history):
```bash
sulla calendar/calendar_cancel '{"eventId":123}'
```

### "Wake me with a workflow at 7am every day"
Two paths:
- **Workflow scheduler** (better for recurring workflows): write a workflow with a `schedule` trigger node — see `workflows/authoring.md`. The workflow scheduler uses cron and supports `daily`/`weekly`/`monthly`/`every-minutes`.
- **Calendar loop** (only if it must be a calendar entry): create N events in a loop. The calendar table has no recurrence support — each occurrence is its own row.

### "Agent, schedule yourself to check on X tomorrow"
The agent CAN schedule its own future runs by creating a calendar event. When fired, SchedulerService routes it through the channel layer; if the human isn't on the chat, the autonomous channel picks it up and runs whatever the title implies.

## What's NOT supported

- No Google Calendar / iCal sync
- No native recurring events (RRULE)
- No native reminders distinct from events (use a short event)
- No invitee notification — `people` is just metadata, the agent won't email anyone

## Reference

- Tool manifests: `pkg/rancher-desktop/agent/tools/calendar/manifests.ts`
- Model: `pkg/rancher-desktop/agent/database/models/CalendarEvent.ts`
- Scheduler: `pkg/rancher-desktop/agent/services/SchedulerService.ts`
- Client: `pkg/rancher-desktop/agent/services/CalendarClient.ts`
- Migrations: `0008_create_calendar_events_table.ts`, `0009_add_status_to_calendar_events.ts`
