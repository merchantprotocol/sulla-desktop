---
slug: sulla-tool-calendar
label: Use the Sulla calendar tools
trigger_when: When you need to read or change local calendar events.
trigger_actions: [calendar, Sulla calendar tool, tool call]
trigger_phrases: [calendar]
scope: [tool-calendar]
---

**When:** Use `exec` to dispatch an exact `sulla calendar/<tool>` command. Discover current tools with `sulla meta/browse_tools '{"category":"calendar"}'` before an unfamiliar call.

**Tools:**
- `sulla calendar/cancel '{"eventId":"1"}'`: Cancel a calendar event by ID. Required: eventId.
- `sulla calendar/create '{"title":"<title>","start":"<start>","end":"<end>"}'`: Create a new calendar event or reminder. Required: title, start, end.
- `sulla calendar/delete '{"eventId":"1"}'`: Delete a calendar event by ID. Required: eventId.
- `sulla calendar/get '{"eventId":"1"}'`: Get details of a specific calendar event by ID. Required: eventId.
- `sulla calendar/list '{}'`: List calendar events within a date range. Required: none.
- `sulla calendar/list_upcoming '{"days":"1"}'`: List upcoming calendar events for the next specified number of days. Required: days.
- `sulla calendar/update '{"eventId":"1"}'`: Update an existing calendar event. Required: eventId.

**Do:**
1. Discover the category when names or parameters may have changed.
2. Run the command through `exec`, passing one JSON object with required parameters.
3. Treat returned IDs, cursors, and SHAs as inputs to the next call; verify destructive or outward-facing results.

**Don't:**
- Don't cancel or delete an event when updating would suffice.
- Don't invent event IDs; list or get first.
