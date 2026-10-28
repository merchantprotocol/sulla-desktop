---
slug: sulla-manage-calendar
label: Manage local calendar events
trigger_when: When a user wants to create, list, update, cancel, or delete a local calendar event.
trigger_actions: [create calendar event, list calendar, update event, cancel event]
trigger_phrases: [calendar, meeting, reminder, event]
scope: [sulla]
---

**Do:**
1. Use the calendar category's current catalog entry for create, get, list, list upcoming, update, cancel, or delete.
2. For a one-off event, use the matching calendar tool and verify the returned event id and time.
3. For recurring automation, prefer a workflow schedule when recurrence is supported there; otherwise state the limitation.

**Don't:**
- claim Google Calendar, iCal, conferencing, email, attachments, or recurrence sync without a verified integration.
- delete an event without the human's tap.
