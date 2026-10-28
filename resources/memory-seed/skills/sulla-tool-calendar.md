---
slug: sulla-tool-calendar
label: Use the Sulla calendar tools
trigger_when: When you need to list, inspect, create, update, cancel, or delete a local calendar event.
trigger_actions: [calendar, Sulla calendar tool, tool call]
trigger_phrases: [calendar event, schedule a meeting, upcoming events, cancel appointment, calendar reminder]
scope: [tool-calendar]
---

**When:** Use `exec` to dispatch an exact `sulla calendar/<tool>` command. Discover current tools with `sulla meta/browse_tools '{"category":"calendar"}'` before an unfamiliar call.

**Tools:**

<!-- tools:generated:start -->
- `sulla calendar/calendar_cancel {"eventId":1}`: Cancel a calendar event by ID. Required: eventId. Optional: none.
- `sulla calendar/calendar_create {"title":"<title>","start":"<start>","end":"<end>"}`: Create a new calendar event or reminder. Required: title, start, end. Optional: description, location, people, calendarId, allDay.
- `sulla calendar/calendar_delete {"eventId":1}`: Delete a calendar event by ID. Required: eventId. Optional: none.
- `sulla calendar/calendar_get {"eventId":1}`: Get details of a specific calendar event by ID. Required: eventId. Optional: none.
- `sulla calendar/calendar_list {}`: List calendar events within a date range. Required: none. Optional: startAfter, endBefore, calendarId.
- `sulla calendar/calendar_list_upcoming {"days":1}`: List upcoming calendar events for the next specified number of days. Required: days. Optional: none.
- `sulla calendar/calendar_update {"eventId":1}`: Update an existing calendar event. Required: eventId. Optional: title, start, end, description, location, people, calendarId, allDay.
<!-- tools:generated:end -->
**Do:**
1. `sulla calendar/list_upcoming {"days":7}` to see the near-term schedule.
2. `sulla calendar/get {"eventId":"<eventId>"}` to inspect one event.
3. `sulla calendar/create {"title":"<title>","start":"2026-11-01T09:00:00Z","end":"2026-11-01T10:00:00Z"}` to add an event.
4. `sulla calendar/update {"eventId":"<eventId>","title":"<new title>"}` to change it.

**Don't:**
- Don't invent event IDs; list or get the event first.
- Don't delete when an update or cancel operation is enough.
