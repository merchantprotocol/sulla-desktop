# Projects — the one project-state store

Desktop Postgres is the operator agenda. The Projects view is the human UI, and the Sulla CLI catalog `project/*` tools are how agents read and write it. There is no direct/native project-management tool surface and no parallel task system.

Projects is a **plain board**. Nothing in the app claims, launches, recovers, or moves tasks on its own, and there is no automation switch to turn on. Agents drive the work with the `project/*` tools, and the human sees every change on the Projects view.

```
work_projects          one outcome with a metric
  └── work_epics       major chunk of a project
        └── work_tasks parent_id NULL = task, set = subtask
              └── work_task_comments  notes (GitHub-issue style)
```

This is **not CRM**. This is **not** a filesystem PRD (`~/sulla/projects/<slug>/PROJECT.md` / `ProjectRegistry.createProject`). Those are product specs. Do not invent a parallel markdown task list.

## Lanes / status / priority

`work_tasks.status` is the stable lane key. The built-in keys below are seeded as global defaults. Lane display names, presentation, and order live in `work_lane_definitions`. Projects inherit the global set and may add or override definitions without changing another project.

| Field | Allowed values |
|---|---|
| `status` (projects + epics) | `working` (default) · `backlog` · `blocked` · `done` · `cancelled` · `parked` |
| `status` (task) | A lane key. Seeded keys: `todo` (default) · `backlog` · `planning` · `in_progress` · `in_review` · `blocked` · `done` · `cancelled` · `parked`. A custom pipeline may use other keys. Use `list_lanes` / `resolve_lanes` to see the keys for a project. |
| `priority` | `critical` · `high` · `medium` (default) · `low`. `p0`–`p4` are accepted as aliases. |

Defaults: projects and epics are `status=working`, `priority=p2`. Tasks are `priority=p2`, and their status is the project's first execution lane (`todo` in the seeded template).

Closed = `done` / `cancelled` / `parked`. There is **no `bucket` column**. Rows are never hard-deleted. `archive_project_item` sets `archived=true` and cascades down. `last_moved_at` updates on status, priority, assignee, due-date, or parent changes. `last_activity_at` updates on every task edit and comment.

Lanes are presentation and status vocabulary only. Moving a task between lanes never triggers a workflow or an agent. Agents may create and reorder lanes.

Optional GitHub mapping on tasks: `github_issue`. It is not a live sync by itself. The opt-in `reconcile_github_pr_mirror` projection needs explicit repositories and a destination epic. Nothing is configured by default.

## Ownership

Ownership is plain metadata. Assigning never launches anything.

- `work_projects.assigned_agent` — the agent slug that drives the project. Set it with `assignedAgent` on `create_project` or `update_project`. Pass an empty string to clear it.
- `work_tasks.assignee` — who owns the task: a custom agent slug, `heartbeat`, or `human`.
- `spawn_agent` with a `projectTaskId` refuses to launch if another live job already owns that task.

## Tools

Use the full `sulla project/<tool>` form shown below.

Reads:

| Tool | Use |
|---|---|
| `sulla project/list_project_items` | Projects project-state list. Filter by `kind` / `status` / `priority` / `project_id` / `epic_id` / `parent_id` / `assignee`. Default kind=task, open only. |
| `sulla project/get_project_item` | One row + children + comments. |
| `sulla project/search_project_items` | Title + description search. Use before creating. |
| `sulla project/list_task_comments` | Comment thread on a task, oldest first. |
| `sulla project/report` | Standup: completed work plus open, dependency-held, blocked, and planning tasks. Within each priority block, least-recent activity comes first. |
| `sulla project/list_ready_tasks` | Open tasks in a project split into ready vs dependency-held, plus open prerequisites that can be worked first. |
| `sulla project/list_task_dependencies` | A task's prerequisites and dependents. |

Explicit projections:

| Tool | Use |
|---|---|
| `sulla project/reconcile_github_pr_mirror` | Mirror explicitly supplied GitHub repositories into one supplied Projects epic. It defaults to `dry_run:true`. No repository, destination, or schedule ships in product defaults. |

Writes — explicit create / update, **no upsert**:

| Tool | Use |
|---|---|
| `sulla project/create_project` | Always inserts. Optional `assignedAgent`. |
| `sulla project/update_project` | In-place by id. Status/priority/due stamp `last_moved_at`. `assignedAgent` sets or clears the driving agent. |
| `sulla project/create_epic` | Always inserts under a project. |
| `sulla project/update_epic` | In-place by id. |
| `sulla project/create_task` | Always inserts. `project_id` required; `epic_id` and `parent_id` optional. |
| `sulla project/update_task` | In-place by id. Pass `status` to move it between lanes. |
| `sulla project/add_task_comment` | Append a note. |
| `sulla project/create_task_dependency` / `remove_task_dependency` | Link or unlink a prerequisite. Dependencies are readiness metadata only. |
| `sulla project/archive_project_item` | Soft-archive. Cascades to children. |

Lane definitions:

| Tool | Use |
|---|---|
| `sulla project/list_lanes` | List global or project definition rows, including archived/reset audit rows when requested. |
| `sulla project/resolve_lanes` | Resolve one project's ordered effective set with `global`, `project_override`, or `project_only` provenance. |
| `sulla project/create_lane` | Add a global default, project override, or project-only lane. The key becomes immutable. |
| `sulla project/update_lane` | Rename, restyle, reorder, or change non-required behavior without changing the key. |
| `sulla project/archive_lane` | Archive a lane. If tasks occupy it, pass `destination_lane_key` so the move is atomic. |
| `sulla project/restore_lane` | Restore an archived definition. |
| `sulla project/reorder_lanes` | Reorder one scope atomically. Reordering an inherited project lane creates an override. |
| `sulla project/reset_lane_override` | Return a project override to global inheritance while retaining the old row as audit history. |

Pipeline templates and knowledge links are also in the catalog: `list_pipeline_templates`, `create_pipeline_template`, `apply_pipeline_template`, `update_pipeline_template`, `archive_pipeline_template`, `link_knowledge_item`, `unlink_knowledge_item`, `list_linked_knowledge`.

## Cycle contract

1. Read the `<project_report>` standup if you have one. Don't re-query unless you need a filter the report doesn't have.
2. Work the tasks assigned to you, or the ones you were asked to drive. Leave a task to its assignee and a project to its assigned agent.
3. Move the task. Use `update_task` to change status, or `add_task_comment` to add a note.
4. Bookkeep on the same row: comment what shipped, mark it done, or park it with the decision and the next step.

## Do not

- Do not invent a parallel markdown task list (`LEDGER.md`, `ACTIVE_PROJECTS.md`, `OUTCOMES.md`, `PARKED_DECISIONS.md`).
- Do not write these tables with raw `pg/execute` — use the tools.
- Do not put CRM records, contacts, or deals here.
- Do not drop tables. Back up first.
- Do not confuse `project/create_project` with filesystem `ProjectRegistry.createProject()` (writes `PROJECT.md`).

## Reference

- Tool dir: `pkg/rancher-desktop/agent/tools/project/`
- Manifest and vocabulary: `pkg/rancher-desktop/agent/tools/project/manifests.ts`
- Models: `pkg/rancher-desktop/agent/database/models/WorkItemsModel.ts`, `WorkLaneDefinitionModel.ts`
- Seeders: `pkg/rancher-desktop/agent/database/seeders/WorkItemsImportSeeder.ts`, `WorkLaneDefinitionSeeder.ts`
- Migrations: `0044_create_work_items_tables`, `0069_create_work_lane_definitions`
