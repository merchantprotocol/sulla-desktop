# Overlap

Overlap finds candidate meeting windows across IANA time zones and shows every participant's local time. It proposes only; it never edits a calendar.

## Setup
No integration is required for pasted working windows. Optionally connect Calendar read access to avoid existing events. The function currently validates input and returns an explicit warning until a timezone-capable runtime is supplied; do not treat an empty result as availability.

## Use and customize
Provide participants, IANA zones, local windows, duration, and date range. Customize working hours and blocked-window policy. Ask separately before creating or changing an event.

Source: https://github.com/modelcontextprotocol/servers/tree/main/src/time (commit `ef9808f71090d0db3eda99e2af2ba78f1086f4fb`).
