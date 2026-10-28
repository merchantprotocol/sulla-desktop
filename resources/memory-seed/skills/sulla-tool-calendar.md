---
slug: sulla-tool-calendar
label: Use the Sulla calendar tools
trigger_when: When you need to list, inspect, create, update, cancel, or delete a local calendar event, prepare for meetings, or plan a week around fixed commitments.
trigger_actions: [list calendar, schedule meeting, update event, prepare for meetings, plan week]
trigger_phrases: [what is on my calendar this week, schedule a meeting tomorrow, prep me for this week's meetings, plan my week around fixed commitments, calendar event, upcoming events, cancel appointment]
scope: [tool-calendar]
---

**When:** Use `exec` to dispatch an exact `sulla calendar/<tool>` command. Discover current tools with `sulla meta/browse_tools '{"category":"calendar"}'` before an unfamiliar call.

**Tools:**

<!-- tools:generated:start -->
- `sulla calendar/cancel '{"eventId":1}'`: Cancel a calendar event by ID. Required: eventId. Optional: none.
- `sulla calendar/create '{"title":"<title>","start":"<start>","end":"<end>"}'`: Create a new calendar event or reminder. Required: title, start, end. Optional: description, location, people, calendarId, allDay.
- `sulla calendar/delete '{"eventId":1}'`: Delete a calendar event by ID. Required: eventId. Optional: none.
- `sulla calendar/get '{"eventId":1}'`: Get details of a specific calendar event by ID. Required: eventId. Optional: none.
- `sulla calendar/list '{}'`: List calendar events within a date range. Required: none. Optional: startAfter, endBefore, calendarId.
- `sulla calendar/list_upcoming '{"days":1}'`: List upcoming calendar events for the next specified number of days. Required: days. Optional: none.
- `sulla calendar/update '{"eventId":1}'`: Update an existing calendar event. Required: eventId. Optional: title, start, end, description, location, people, calendarId, allDay.
<!-- tools:generated:end -->
**Do:**
1. `sulla calendar/list_upcoming '{"days":7}'` to see the near-term schedule.
2. `sulla calendar/get '{"eventId":"<eventId>"}'` to inspect one event.
3. `sulla calendar/create '{"title":"<title>","start":"<ISO start, e.g. 2030-01-15T09:00:00Z>","end":"<ISO end>"}'` to add an event.
4. `sulla calendar/update '{"eventId":"<eventId>","title":"<new title>"}'` to change it.
5. For meeting prep, bound the query: `sulla calendar/list '{"startAfter":"<week-start-ISO>","endBefore":"<week-end-ISO>"}'`. Use only event facts plus verified project context. Produce purpose, known attendees, location or link, decisions needed, and preparation tasks; mark a missing agenda instead of inventing one.
6. For a weekly plan, list the fixed week first. Draft focus blocks around events, transition time, preparation, breaks, and buffer. Show conflicts before proposing calendar writes.
7. When creating several personal planning blocks the human asked for, show the exact titles and times, create them, and verify them, with no second approval. If an event will invite or notify another person, prepare the recipients and details and ask once with `ask_user_question` before creating it.

**Check:** List the same bounded range again and match returned event ids, titles, starts, ends, calendar, and timezone to the request. A draft plan is not a calendar update.

**Cleanup:** Remove only scratch planning notes. Cancel superseded events when history matters; deletion waits for the human's tap.

**Don't:**
- Don't invent event IDs; list or get the event first.
- Don't delete when an update or cancel operation is enough. Deletion waits for the human's explicit go-ahead.
- Don't invent attendee roles, agendas, travel time, or free time outside the returned range.
- Don't claim recurrence support: the calendar tool has no recurrence parameter.
