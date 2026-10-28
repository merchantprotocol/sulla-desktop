---
sullaApi: ^1.0.0
hooks: []
slug: broadsheet
name: Broadsheet
title: Run a posting calendar from one piece of content
line: Turn one approved source asset into a consistent, owner-approved weekly content calendar.
summary: Turn one approved source asset into a consistent, owner-approved weekly content calendar.
version: 1.0.0
category: marketing
tags: [content, social, calendar, repurposing]
license: Apache-2.0
---
# Broadsheet

Maintain a rolling content calendar and repurpose one approved source into channel-ready drafts. Read the shared voice pack (Tuning Fork) when available; otherwise use the human's supplied examples.

## Use when
The human asks for a posting plan, a batch of posts, repurposing, or a content calendar.

## Procedure
1. Read the existing calendar in Sulla Files after `sulla files/search '{"query":"content calendar"}'` and use `sulla files/where '{"what":"content calendar","kind":"marketing document"}'` before choosing a destination. Do not create a second calendar.
2. Diagnose the source asset, audience, offer, channel, dates, and evidence. If a claim or price is not in the source, mark `[NEED: evidence]`; never invent it.
3. Propose the calendar first: date, channel, source, theme, format, status, and owner decision. Ask the human to approve the plan before drafting a large batch.
4. Repurpose the approved source into channel-native drafts. Keep the message stable while changing length, hook, accessibility text, and call to action. Email remains text-only.
5. Save the calendar and drafts to Files. Use `sulla files/search` first; use `sulla files/where` to select the existing folder.
6. Present a staging table. Posting, scheduling, or sending is never automatic. If the human wants a connected social action, prepare the exact payload and pause for explicit approval.

## Weekly workflow
The included `routine.yaml` runs a weekly drafting pass. It reads the existing calendar, extends the horizon, and leaves all posts as DRAFT.

## Checks and traps
- Keep every scheduled time in the future and preserve the owner's timezone.
- Never generate designs, call a social connector, or publish before plan approval.
- Do not claim a post is published when it is only staged.
- If no social integration is connected, export a CSV or Markdown calendar for manual import.

Adapted from `small-business/skills/social-content-engine` in anthropics/knowledge-work-plugins, Copyright Anthropic, PBC. Licensed under the Apache License 2.0. Modified for Sulla Desktop.
