---
slug: sulla-remind-and-follow-up
label: Set reminders, recurring follow-ups, and plan around calendar commitments
trigger_when: When the human asks for a reminder in a few minutes, a recurring reminder, meeting preparation, or a weekly plan around fixed calendar events.
trigger_actions: [set timer, set recurring reminder, prepare for meetings, plan week, follow up later]
trigger_phrases: [remind me in 10 minutes, remind me every Monday, prep me for this week's meetings, plan my week, fixed commitments, follow up next week, check the deploy later]
scope: [tool-browser, tool-calendar, tool-notify, sulla-workflows]
---

**Choose:** Use an alarm only for a short in-session timer; it does not survive an app restart. Use a calendar event for a durable human reminder. Use a scheduled workflow when recurrence must fetch data, make a draft, branch, or notify conditionally.

**Do:**
1. Resolve the human's timezone, target time, recurrence, reminder text, and whether a notification or actual work is expected. Repeat the absolute time when relative language could be ambiguous.
2. For a short timer, arm it: `sulla browser/schedule_alarm '{"action":"create","name":"<unique-name>","delayInMinutes":10}'`. Confirm it exists with `sulla browser/schedule_alarm '{"action":"get","name":"<unique-name>"}'`.
3. For a durable one-time or repeating human commitment, use the local calendar. Check conflicts with `sulla calendar/list '{"startAfter":"<ISO-start>","endBefore":"<ISO-end>"}'`, then create the event with `sulla calendar/create '{"title":"<reminder>","start":"<ISO-start>","end":"<ISO-end>"}'`. The calendar tool does not expose a recurrence rule; create only the bounded occurrences the human requested, or use a workflow for ongoing recurrence.
4. For ongoing recurrence, follow `sulla-build-workflow` and `sulla-schedule-or-trigger-workflow`. Give the workflow a schedule trigger with an IANA timezone and a finite, idempotent action. Validate and dry-run it, import it as a draft, request publication, enable it only after publication, then run `sulla workflow/refresh_schedules '{}'` and verify the returned next fire.
5. For meeting prep, list the bounded week: `sulla calendar/list '{"startAfter":"<week-start-ISO>","endBefore":"<week-end-ISO>"}'`. For each real meeting, summarize purpose, attendees named in the event, location/link, known context, decisions needed, and preparation tasks. Do not invent attendee roles or agenda.
6. For a weekly plan, preserve fixed events first. Add realistic focus blocks, travel or transition time, preparation, breaks, and a small buffer. Show conflicts and unscheduled work before changing the calendar.
7. Ask for explicit approval before creating or changing multiple calendar events. Use `sulla meta/ask_user_question '{"questions":[{"header":"Update calendar","question":"Create the reviewed calendar blocks and reminders?","options":[{"label":"Approve","description":"Create exactly the reviewed events."},{"label":"Deny","description":"Keep the plan as a draft."}]}]}'`.
8. After an approved notification is due, send only useful, non-sensitive text with `sulla notify/user '{"title":"Reminder","message":"<message>","targets":["desktop"]}'`. Verify failures with `sulla notify/history '{"only_failures":true}'`.

**Check:** Read the alarm, calendar event ids, or workflow next-fire time back from the tool. Report the timezone and whether the reminder survives a restart.

**Cleanup:** Clear an obsolete alarm with `sulla browser/schedule_alarm '{"action":"clear","name":"<unique-name>"}'`. Cancel rather than delete a calendar event when history matters. Deleting any event waits for the human's tap.

**Traps:** Do not use cron. Do not claim an in-process alarm is durable. Do not silently create an endless series. Do not expose private calendar details in notifications.
