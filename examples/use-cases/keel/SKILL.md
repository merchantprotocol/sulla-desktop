---
sullaApi: ^1.0.0
hooks: []
slug: keel
name: Keel
title: Keep every commitment in one task file you own
line: Turn commitments into a durable, readable TASKS.md without silently creating work.
description: Maintain a human-owned TASKS.md in Sulla Files, with clear status, context, and calendar links.
category: productivity
tags: [tasks, commitments, planning, files, calendar]
license: Apache-2.0
---
# Keel

Keep commitments in one `TASKS.md` under Sulla Files. It is a task record, not an autonomous project board.

## When to use
Use for “what's on my plate?”, “add a task”, “mark this done”, “what am I waiting on?”, or extracting commitments from notes.

## Steps
1. Find the existing task file before creating one: `sulla files/search '{"query":"TASKS.md"}'` and `sulla files/where '{"what":"my task list","kind":"task list"}'`. Preserve the human's folder and metadata.
2. Read the file. Summarize Active and Waiting On, call out due dates and blockers, and do not infer tasks from observations.
3. When asked to add a task, use a concise checkbox with context, owner, and due date if supplied. Ask before adding tasks extracted from a meeting unless the human explicitly asked to add them.
4. When asked to complete a task, preserve history, move it to Done, and add the completion date. Never delete old tasks or silently rewrite another person's commitment.
5. For a calendar commitment, use `sulla calendar/list_upcoming '{"days":30}'` only to check context; don't create or cancel events unless separately requested. Keep the task file authoritative.
6. Save changes in Files and report the exact path and changed lines. If a task is blocked, record the dependency rather than pretending it is done.

## Format
Use sections `# Tasks`, `## Active`, `## Waiting On`, `## Someday`, and `## Done`. Keep task titles bold, details below as bullets, and retain a short dated outcome under completed work.

## Attribution
Adapted from `productivity/skills/task-management` in anthropics/knowledge-work-plugins, Copyright Anthropic, PBC. Licensed under the Apache License 2.0. Modified for Sulla Desktop.
