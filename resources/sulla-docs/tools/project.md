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
| `status` (tasks) | `todo` (default) · `backlog` · `planning` · `in_progress` · `in_review` · `blocked` · `done` · `cancelled` · `parked` |
| `priority` | `p0`/`critical` · `p1`/`high` · `p2`/`medium` (default) · `p3`/`low` · `p4` |

There is **no `bucket` column**. Closed = `done` / `cancelled` / `parked`.
Rows are never hard-deleted — `archive_project_item` sets `archived=true` and
cascades down. `last_moved_at` updates on status / priority / assignee /
due-date / parent changes. `last_activity_at` updates automatically on every
task edit and comment. Agents never set it directly; Heartbeat uses it as the
round-robin cursor inside each priority block.

Defaults from `WorkItemsModel`: projects + epics `status='working'`
`priority='p2'`; tasks `status='todo'` `priority='p2'`.

## Task ownership contract

Task authorship and queue ownership are separate. Use `dispatcher` for
autonomous executable work, `heartbeat` for supervisory/review work, and
`human` for explicit human ownership. A null assignee is unowned work that the
dispatcher may claim unless a non-autonomous label excludes it. `sulla` is the
legacy/direct-chat actor identity, not a durable queue owner; ordinary `todo`
tasks written by Sulla, Heartbeat, or the dispatcher with `assignee='sulla'`
are stored as `dispatcher`.

Labels `gated`, `decision`, `human`, `manual`, and `no-auto-dispatch` always
exclude a task from mechanical dispatch. Their ownership is never normalized,
and an explicit `assignee='human'` is never rewritten.

## Tools (bare names — slash paths misroute)

Reads:

| Tool | Use |
|---|---|
| `sulla project/list_project_items` | Projects project-state list. Filter by `kind` / `status` / `priority` / `project_id` / `epic_id` / `parent_id` / `assignee`. Default kind=task, open only. |
| `sulla project/get_project_item` | One row + children + comments. |
| `sulla project/search_project_items` | Title + description search. Use before creating. |
| `sulla project/list_task_comments` | Comment thread on a task, oldest first. |
| `sulla project/list_task_waits` | Durable external waits. Active unchanged waits are monitor-owned. |
| `sulla project/project_report` | Standup: completed work plus separate actionable, blocked-recovery, and planning-in-flight queues. Within each priority block, least-recent activity comes first. Injected as `<project_report>` on first chat turn. |

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
| `sulla project/register_task_wait` | Idempotently register one structured external wait; adds one initial comment. |
| `sulla project/cancel_task_wait` | Cancel one obsolete active wait; terminal task states cancel automatically. |
| `sulla project/archive_project_item` | Soft-archive. Cascades to children. |

Schema-only migrations `0044_create_work_items_tables` and
`0063_create_work_task_waits`. No user data in the migrations. A runtime seeder (`WorkItemsImportSeeder`) may import this
install's leftover `~/sulla/ledger/goals/*.md` on first boot by stable
slug. Safe to re-run. After that, **only** the project tools.

Optional GitHub mapping on tasks: `github_issue`. Not a live sync.

## External waits

`work_task_waits` is the durable owner for pending GitHub checks, human gates,
scheduled times, and external jobs. Register a stable structured target once;
the monitor fingerprints GitHub head SHA plus normalized check state and writes
only material deltas. Active unchanged waits are summarized in `project_report`
and, once `externalWaitCommentSuppressionEnabled` is enabled, omitted from the
actionable queue. `externalWaitMonitorEnabled=false` restores the prior report
behavior. Human comments/task mutations and terminal task states invalidate or
cancel waits through database triggers, so human gates do not poll GitHub.

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
