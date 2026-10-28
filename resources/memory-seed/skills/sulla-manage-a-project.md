---
slug: sulla-manage-a-project
label: Manage a project through Files
trigger_when: When work spans multiple sessions and needs a durable goal, owner, task checklist, decisions, and progress history.
trigger_actions: [find a project, create a project, update a task, record progress, close a task]
trigger_phrases: [project, PROJECT.md, TASKS.md, project status, task list, multi-session goal]
scope: [sulla-projects]
---

**When:** Track durable multi-session work. Finish one-off requests in the conversation instead.

**Do:**
1. Search first: `sulla files/search '{"path":"/mnt/sulla-files/Projects","query":"<goal or project name>"}'`.
2. Read `/mnt/sulla-files/Projects/<slug>/PROJECT.md`, `TASKS.md`, and `_folder-metadata.yaml`.
3. Use `PROJECT.md` for goal, status, owner, links, and durable context.
4. Use only `TASKS.md` for tasks: `- [ ] task — status · priority · @owner`.
5. Change only the assigned task. Add a dated outcome with evidence, links, and an undo path.
6. Mark completion with `- [x]` and status `done`; preserve its history.
7. Create a new project only when the goal is durable, multi-session, and fits no existing project.

**Don't:**
- Don't use retired project database tools or keep a parallel task list.
- Don't delete tasks; cancel them with a reason.
- Don't take another worker's task or change its status without explicit custody.
