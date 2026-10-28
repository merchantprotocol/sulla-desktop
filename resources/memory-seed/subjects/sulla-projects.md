---
slug: sulla-projects
kind: system
name: Sulla Projects
parent: sulla
aliases: [Projects, PROJECT.md, TASKS.md, project files, project state]
---

## Overview
Projects are plain folders in Sulla Files at `/mnt/sulla-files/Projects/<project-slug>/`. `PROJECT.md` records the goal, status, owner, links, and durable project context. `TASKS.md` is the project's only task list. Plans, specs, decisions, and progress notes belong in the same project folder. Old `~/sulla/projects/<slug>/` content is specification or historical workspace content, not the live agenda.

## Facts
- Task status is one of backlog, todo, doing, review, blocked, done, or cancelled.
- A checklist line uses `- [ ] task — status · priority · @owner`; completed tasks use `- [x]` and keep a short outcome note.
- Project priority is critical, high, medium, or low.

## Rules
- DO: Search existing projects before creating one.
- DO: Create a project only for a durable multi-session goal that fits no existing project.
- DO: Record outcomes, branch or artifact links, verification, and undo paths under the relevant task.
- DON'T: Keep a second task list in notes, identity, memory, or a retired project service.
- DON'T: Delete a task. Mark it cancelled and record the reason.
- DON'T: Change another worker's task status or custody unless the assignment says to.
