---
sullaApi: ^1.0.0
hooks: []
slug: overlap
name: Overlap
title: Find a meeting time that works in every time zone
line: Calculate transparent shared availability across time zones without creating an event.
description: Convert working windows and find common meeting slots deterministically; calendar lookup is optional and read-only.
category: productivity
tags: [calendar, time-zones, meetings, scheduling]
license: MIT AND Apache-2.0
---
# Overlap

Find shared time windows across named IANA time zones. The deterministic function converts offsets and returns candidate slots; it never books or invites.

## When to use
Use for “find a time across time zones”, “when can these people meet?”, or scheduling across daylight-saving changes.

## Steps
1. Collect each participant's IANA timezone, local working windows, meeting duration, date range, and optional blocked intervals. Do not guess a timezone from a city or email domain.
2. Run `sulla function/run '{"slug":"overlap","inputs":{"participants":[{"timezone":"America/Los_Angeles","windows":[{"start":"09:00","end":"17:00"}]}],"duration_minutes":30,"from":"2026-01-01","to":"2026-01-07"}}'` and inspect warnings. Use real dates so daylight-saving transitions are handled.
3. Present candidates in each participant's local time and UTC, with the assumptions and excluded blocks. If no overlap exists, offer shorter duration or a clearly labeled compromise; never silently move outside a working window.
4. If checking Sulla Calendar, use `sulla calendar/list_upcoming '{"days":30}'` read-only. Calendar results are context, not permission to change events.
5. Creating, moving, inviting, or cancelling an event waits for explicit approval naming the exact title, attendees, time zones, time, and calendar. This skill only proposes slots.

## Checks
Reject invalid IANA zones, reversed windows, impossible durations, and ambiguous local times. Never claim a slot is free when calendar data was not connected.

## Attribution
Based on the MCP reference `time` server, modelcontextprotocol/servers. MIT / Apache License 2.0. Modified for Sulla Desktop; logic reimplemented rather than copied.
