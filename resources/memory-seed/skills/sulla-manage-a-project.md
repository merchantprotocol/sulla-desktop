---
slug: sulla-manage-a-project
label: Manage a project through Files
trigger_when: When work spans multiple sessions and needs a durable goal, owner, task checklist, decisions, and progress history in Sulla Files.
trigger_actions: [find a project, create a project, update a task, record progress, close a task]
trigger_phrases: [project, PROJECT.md, TASKS.md, project status, task list, multi-session goal]
scope: [sulla-projects]
---

**When:** Use a project only for a durable multi-session goal. Finish a one-off request in the conversation and do not create project clutter.

**Do:**
1. Search first: `sulla files/search '{"path":"/mnt/sulla-files/Projects","query":"<goal or project name>"}'`.
2. Read the selected `/mnt/sulla-files/Projects/<slug>/_folder-metadata.yaml`, `PROJECT.md`, and `TASKS.md`. If the folder has no real description, prepare one before adding more files.
3. Use `PROJECT.md` for the goal, status, owner, links, and durable context. Use only `TASKS.md` as the task list.
4. Keep task lines in this form: `- [ ] task — status · priority · @owner`. Allowed status values are `backlog`, `todo`, `doing`, `review`, `blocked`, `done`, and `cancelled`; priority is `critical`, `high`, `medium`, or `low`.
5. Change only the task you own. Add a short outcome with evidence, links, and an undo path under that task. Preserve the file's version history.
6. Mark a completed task `- [x]` with status `done`; cancel rather than delete a task and record the reason.
7. Keep plans, specs, decisions, and progress notes in the same project folder. Do not leave agent scratch, logs, briefs, test data, or build output there; use `/mnt/worktrees/_scratch/<job>/` or the agent workspace and clean it up.
8. Create a new project only when the goal is durable, multi-session, and no existing project fits. Give its folder a real description immediately and create `PROJECT.md` plus `TASKS.md`.

**Check:** `PROJECT.md` states the current goal and status, `TASKS.md` is the sole current checklist, your task has an outcome and evidence, and no scratch files or duplicate task lists remain. Projects normally publish immediately only when their collection does not require approval; inspect the version state instead of assuming.

**Don't:**
- Don't use retired project database tools or keep a parallel task list in notes, memory, identity, or another service.
- Don't delete tasks; mark them cancelled with a reason.
- Don't change another worker's task status or custody without explicit assignment.
- Don't delete, move, or rename project files without the human's tap.
