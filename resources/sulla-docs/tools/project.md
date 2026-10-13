# Projects — the one project-state store

Desktop Postgres is the operator agenda. The Projects view is the human UI, and
the Sulla CLI catalog `project/*` tools are how agents read and write it. There
is no direct/native project-management tool surface and no parallel task system.

Projects is a **plain board**. Nothing in the app claims, launches, recovers,
reviews, or moves tasks on its own, and there is no automation switch to turn
on. Agents drive the work:

1. The human picks the agent to work with in a chat (for code, usually the
   **Coding Manager**). Nothing auto-routes a new chat to a manager agent.
2. That agent owns the goal. It plans the work (optionally as tasks on a
   project, with an `assignee` per task and itself as `assignedAgent`),
   launches its own workers (`spawn_agent`), watches every check-in, steers
   them, relays their progress to the human in the chat, reviews and lands
   their work, and keeps a live Playbook dashboard in the sidebar.
3. Each worker records its outcome with `update_task` / `add_task_comment`
   and returns to the agent that launched it.
4. No agent hands a goal off to another manager agent and goes quiet. Work
   must stay visible to the human.

```
work_projects          one outcome with a metric
  └── work_epics       major chunk of a project
        └── work_tasks parent_id NULL = task, set = subtask
              └── work_task_comments  notes (GitHub-issue style)
```

This is **not CRM** (CRM lives in Sulla Cloud). This is **not** a filesystem
PRD (`~/sulla/projects/<slug>/PROJECT.md` / `ProjectRegistry.createProject`) —
those are product specs. Do not invent a parallel markdown task list.

`~/sulla/ledger/` is a historical archive. Do not open `LEDGER.md` to pick
work. Do not write `OUTCOMES.md` / `AUDIT.md` as bookkeeping.

## Lanes / priority

`work_tasks.status` remains the stable lane key. The built-in keys below are
seeded as global defaults, but lane display names, presentation, and order live
in `work_lane_definitions`. Projects inherit the global set and may add or
override definitions without changing another project.

| Field | Allowed values |
|---|---|
| `status` (projects + epics) | `working` (default) · `backlog` · `blocked` · `done` · `cancelled` · `parked` |
| built-in task lane keys | `todo` (default) · `backlog` · `planning` · `in_progress` · `in_review` · `blocked` · `done` · `cancelled` · `parked` |
| `priority` | `p0`/`critical` · `p1`/`high` · `p2`/`medium` (default) · `p3`/`low` · `p4` |

There is **no `bucket` column**. Closed = `done` / `cancelled` / `parked`.
Rows are never hard-deleted — `archive_project_item` sets `archived=true` and
cascades down. `last_moved_at` updates on status / priority / assignee /
due-date / parent changes. `last_activity_at` updates automatically on every
task edit and comment. Agents never set it directly; Heartbeat uses it as the
round-robin cursor inside each priority block.

Defaults from `WorkItemsModel`: projects + epics `status='working'`
`priority='p2'`; tasks `status='todo'` `priority='p2'`.

## Ownership

Ownership is plain metadata; assigning never launches anything.

- `work_projects.assigned_agent` — the agent slug that drives the project
  (usually `project-manager`). Set it with `assignedAgent` on `create_project`
  or `update_project`; pass an empty string to clear it.
- `work_tasks.assignee` — who owns the task: a custom agent slug, `heartbeat`,
  or `human`. A `spawn_agent` job given a `projectTaskId` sets the assignee to
  its agent for the run and refuses to launch if another live job owns the task.

## Tools (bare names — slash paths misroute)

Reads:

| Tool | Use |
|---|---|
| `sulla project/list_project_items` | Projects project-state list. Filter by `kind` / `status` / `priority` / `project_id` / `epic_id` / `parent_id` / `assignee`. Default kind=task, open only. |
| `sulla project/get_project_item` | One row + children + comments. |
| `sulla project/search_project_items` | Title + description search. Use before creating. |
| `sulla project/list_task_comments` | Comment thread on a task, oldest first. |
| `sulla project/project_report` | Standup: completed work plus open, dependency-held, blocked, and planning tasks. Within each priority block, least-recent activity comes first. Injected as `<project_report>` on first chat turn. |
| `sulla project/list_ready_tasks` | Open tasks in a project split into ready vs dependency-held, plus open prerequisites that can be worked first. |
| `sulla project/list_task_dependencies` | A task's prerequisites and dependents. |

Explicit projections:

| Tool | Use |
|---|---|
| `sulla project/reconcile_github_pr_mirror` | Mirror explicitly supplied GitHub repositories into one supplied Projects epic. It defaults to `dry_run:true`, validates destination lanes before writing, preserves Projects-owned prose and labels, and records durable repository+PR identity. No repository, destination, enablement, or schedule ships in product defaults. |

Writes — explicit create / update, **no upsert**:

| Tool | Use |
|---|---|
| `sulla project/create_project` | Always inserts. Unique slug auto-resolved. Optional `assignedAgent`. |
| `sulla project/update_project` | In-place by id. Status/priority/due stamp `last_moved_at`. `assignedAgent` sets or clears the driving agent. |
| `sulla project/create_epic` | Always inserts under a project. |
| `sulla project/update_epic` | In-place by id. |
| `sulla project/create_task` | Always inserts. `project_id` required; `epic_id` and `parent_id` optional. |
| `sulla project/update_task` | In-place by id. |
| `sulla project/add_task_comment` | Append a note. Default author `sulla`; desktop UI stamps `human`. |
| `sulla project/create_task_dependency` / `remove_task_dependency` | Link or unlink a prerequisite. Dependencies are readiness metadata only. |
| `sulla project/archive_project_item` | Soft-archive. Cascades to children. |

Lane definitions:

| Tool | Use |
|---|---|
| `sulla project/list_lanes` | List global or project definition rows, including archived/reset audit rows when requested. |
| `sulla project/resolve_lanes` | Resolve one project's ordered effective set with `global`, `project_override`, or `project_only` provenance. |
| `sulla project/create_lane` | Add a global default, project override, or project-only lane. The key becomes immutable. |
| `sulla project/update_lane` | Rename, restyle, reorder, or change non-required behavior without changing the key. |
| `sulla project/archive_lane` | Archive a lane. If tasks occupy it, `destination_lane_key` is required and the move is atomic. |
| `sulla project/restore_lane` | Restore an archived definition. |
| `sulla project/reorder_lanes` | Reorder one scope atomically. Reordering an inherited project lane creates an override. |
| `sulla project/reset_lane_override` | Return a project override to global inheritance while retaining the old row as audit history. |

Lanes are presentation and status vocabulary only. Moving a task between lanes
never triggers a workflow or an agent. Agents may create and reorder lanes.

Schema-only migrations `0044_create_work_items_tables` and
`0069_create_work_lane_definitions` contain no user data.
A runtime seeder (`WorkItemsImportSeeder`) may import this
install's leftover `~/sulla/ledger/goals/*.md` on first boot by stable
slug. `WorkLaneDefinitionSeeder` runs on every boot, reasserts missing built-in
definitions, and adds every unknown task status as a visible manual lane using
the exact existing status value. Neither seeder remaps task status.

Optional GitHub mapping on tasks: `github_issue`. It is not a live sync by itself;
the opt-in `reconcile_github_pr_mirror` projection requires explicit repositories,
destination, and an installation-local schedule.

## Cycle contract

1. First chat turn already has a `<project_report>` standup. Read it. Do not
   re-query unless you need a filter the report doesn't have.
2. Work tasks assigned to you, or the ones you were asked to drive. Leave a
   task to its assignee and a project to its assigned agent.
3. Move it. `update_task` status / comment / complete.
4. Bookkeep on the same row: comment what shipped, mark done, or park
   with the decision + recommendation + staged artifact.

## Do not

- Do not invent a parallel markdown task list (`LEDGER.md`,
  `ACTIVE_PROJECTS.md`, `OUTCOMES.md`, `PARKED_DECISIONS.md`).
- Do not write these tables with raw `pg_execute` — use the tools.
- Do not put CRM records, contacts, or deals here.
- Do not drop leftover `crm_*` tables without Jonathon.
- Do not confuse `project/create_project` with filesystem
  `ProjectRegistry.createProject()` (writes `PROJECT.md`).
