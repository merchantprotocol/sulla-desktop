# Work items — projects, epics, tasks, comments

The desktop Postgres database is the structured work store. Files under
`~/sulla/ledger/` stay the human-readable agenda (LEDGER.md pick-path,
OUTCOMES.md, AUDIT.md). The tables answer: what exists, what stage, what
priority, when it last moved, what's due, what's blocked.

This is **not CRM**. CRM lives in Sulla Cloud. These four tables are
operator work only.

Filesystem PRDs (`~/sulla/projects/<slug>/PROJECT.md`, `create_project`)
are a different thing — product specs. Do not confuse them with work
projects.

## Hierarchy

```
work_projects          one outcome with a metric
  └── work_epics       major chunk of a project
        └── work_tasks parent_task_id NULL = task, set = subtask
              └── work_task_comments  notes (GitHub-issue style)
```

## Status / priority / bucket

| Field | Allowed values |
|---|---|
| `status` | `backlog` · `todo` · `in_progress` · `blocked` · `done` · `cancelled` |
| `priority` | `critical` · `high` · `medium` · `low` |
| `bucket` (projects only) | `WORKING` · `SHOULD` · `WANT` · `MIGHT` · `DONE` |

Rows are **never hard-deleted**. `archive_*` sets `archived=true`.
`last_moved_at` updates on every status/priority/bucket/assignee/due-date
change so staleness is queryable (7-day WORKING rule).

## Tools (bare names — slash paths misroute)

| Tool | Use |
|---|---|
| `sulla list_work_items '{}'` | Board: filter by `kind` / `status` / `priority` / `bucket` / `project_id` / `epic_id` / `parent_task_id`. |
| `sulla get_work_item '{"id":"…"}'` | One row + children + comments. |
| `sulla search_work_items '{"query":"wake"}'` | Title + description search. |
| `sulla upsert_project '{"title":"…","description":"…"}'` | Create / update a project. Pass `id` to update. |
| `sulla upsert_epic '{"project_id":"…","title":"…"}'` | Create / update an epic. |
| `sulla upsert_task '{"epic_id":"…","title":"…"}'` | Create / update a task. Set `parent_task_id` for a subtask. Optional `github_issue`. |
| `sulla add_task_comment '{"task_id":"…","body":"…"}'` | Append a note. |
| `sulla archive_work_item '{"id":"…"}'` | Soft-delete. |

Schema-only migration `0044_create_work_items_tables`. No user data in
the migration. A runtime seeder (`WorkItemsImportSeeder`, registered as
`work-items-import-seeder`) reads THIS install's
`~/sulla/ledger/goals/*.md` on first boot and upserts by stable slug
(`goal-<file>` / `epic-<file>-<n>` / `task-<file>-<n>-<m>`). Safe to re-run.

Optional GitHub mapping on tasks: `github_owner` / `github_repo` /
`github_issue`. Not a live sync in this pass.

## Do not

- Do not invent a parallel markdown task list once the tables exist.
- Do not write these tables with raw `pg_execute` — use the tools.
- Do not put CRM records, contacts, or deals here.
- Do not drop the leftover `crm_*` tables without Jonathon — they are
  a wrong-build remnant, not this schema.
