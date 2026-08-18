# Projects — the one project-state store

Desktop Postgres is the operator agenda. The Projects view is the human UI, and
the Sulla CLI catalog `project/*` tools are how agents read and write it. There
is no direct/native project-management tool surface and no parallel task system.

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

## Status / priority

Free-text columns. Use these consistently:

| Field | Allowed values |
|---|---|
| `status` (projects + epics) | `working` (default) · `backlog` · `blocked` · `done` · `cancelled` · `parked` |
| `status` (tasks) | `todo` (default) · `backlog` · `in_progress` · `blocked` · `done` · `cancelled` · `parked` |
| `priority` | `p0`/`critical` · `p1`/`high` · `p2`/`medium` (default) · `p3`/`low` · `p4` |

There is **no `bucket` column**. Closed = `done` / `cancelled` / `parked`.
Rows are never hard-deleted — `archive_project_item` sets `archived=true` and
cascades down. `last_moved_at` updates on status / priority / assignee /
due-date / parent changes.

Defaults from `WorkItemsModel`: projects + epics `status='working'`
`priority='p2'`; tasks `status='todo'` `priority='p2'`.

## Tools (bare names — slash paths misroute)

Reads:

| Tool | Use |
|---|---|
| `sulla project/list_project_items` | Projects project-state list. Filter by `kind` / `status` / `priority` / `project_id` / `epic_id` / `parent_id` / `assignee`. Default kind=task, open only. |
| `sulla project/get_project_item` | One row + children + comments. |
| `sulla project/search_project_items` | Title + description search. Use before creating. |
| `sulla project/list_task_comments` | Comment thread on a task, oldest first. |
| `sulla project/project_report` | Standup: completed in last N hours + top open next. Injected as `<project_report>` on first chat turn. |

Writes — explicit create / update, **no upsert**:

| Tool | Use |
|---|---|
| `sulla project/create_project` | Always inserts. Unique slug auto-resolved. |
| `sulla project/update_project` | In-place by id. Status/priority/due stamp `last_moved_at`. |
| `sulla project/create_epic` | Always inserts under a project. |
| `sulla project/update_epic` | In-place by id. |
| `sulla project/create_task` | Always inserts. `project_id` required; `epic_id` and `parent_id` optional. |
| `sulla project/update_task` | In-place by id. |
| `sulla project/add_task_comment` | Append a note. Default author `sulla`; desktop UI stamps `human`. |
| `sulla project/archive_project_item` | Soft-archive. Cascades to children. |

Schema-only migration `0044_create_work_items_tables`. No user data in the
migration. A runtime seeder (`WorkItemsImportSeeder`) may import this
install's leftover `~/sulla/ledger/goals/*.md` on first boot by stable
slug. Safe to re-run. After that, **only** the project tools.

Optional GitHub mapping on tasks: `github_issue`. Not a live sync.

## Cycle contract

1. First chat turn already has a `<project_report>` standup. Read it. Do not
   re-query unless you need a filter the report doesn't have.
2. Pick the top open task you can move (`list_project_items` / the report).
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
