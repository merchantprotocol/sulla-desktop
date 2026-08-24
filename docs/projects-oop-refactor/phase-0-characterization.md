# Projects OOP Refactor — Phase 0 Characterization

- Task: dHAe — "P0 refactor Projects into an object-oriented domain architecture"
- Project/Epic: zwGj / IZvd
- Base commit: origin/main @ 7a12415 ("feat(projects): expose exact conveyor health metrics (#729)")
- Branch: worker/dHAe-phase0-characterization
- Author: opus-worker (dispatch-5d6ba35a)
- Date: 2026-08-24

## Method

All numbers below are produced by `git grep` / `git ls-files` against the clean
`origin/main` tree at 7a12415 in an isolated worktree. They are reproducible:
each row lists the exact query so a reviewer can re-run it. This document makes
**no code change** to runtime behavior — it is the characterization inventory
required by Phase 0 of the task before the domain kernel is introduced.

Scope root: `pkg/rancher-desktop`.

## 1. Status / lane-key literals are pervasive (Acceptance criterion #3)

Quoted string occurrences of each lifecycle literal across `*.ts` / `*.vue`
(`git grep -F "'<key>'" -- '*.ts' '*.vue' | wc -l`):

| literal        | occurrences | signal |
|----------------|-------------|--------|
| `'todo'`       | 121         | high   |
| `'in_progress'`| 85          | high   |
| `'in_review'`  | 103         | high   |
| `'done'`       | 202         | includes non-status noise |
| `'blocked'`    | 151         | includes non-status noise |
| `'planning'`   | 109         | high   |
| `'backlog'`    | 39          | high   |

Even discounting `'done'`/`'blocked'` noise, hundreds of exact lifecycle
literals are hardcoded across models, services, tools, prompts, composables,
and Vue — despite lanes being customizable. This is the core driver for
criterion #3 ("no exact lane/status literal drives lifecycle behavior outside
compatibility mapping and default-lane seed definitions").

High-signal literal-bearing files (sample) include:
`agent/controllers/PlaybookController.ts`, `agent/database/models/WorkItemsModel.ts`,
`agent/database/models/WorkTaskDispatchModel.ts`, `agent/database/models/WorkLaneDefinitionModel.ts`,
`agent/database/models/WorkTaskPlanningRunModel.ts`, `agent/database/models/WorkTaskWaitModel.ts`,
plus migrations 0065/0069/0074/0079/0080 (seed/default definitions — expected).

## 2. Direct model writes bypass any single boundary (criteria #1, #2)

- `WorkItemsModel` references: **327** (`git grep -F 'WorkItemsModel' -- '*.ts' | wc -l`)
- `WorkTaskDispatchModel` references: **99** (`git grep -F 'WorkTaskDispatchModel' -- '*.ts' | wc -l`)

Non-test files that reference these God models directly include every project
tool (`agent/tools/project/*.ts`) plus the orchestration layer:

- `agent/nodes/HeartbeatNode.ts`
- `agent/services/TaskDispatcherService.ts`
- `agent/services/PlanningCouncilService.ts`
- `agent/services/CanonicalArtifactCustodyService.ts`
- `agent/prompts/projectReport.ts`
- `agent/database/seeders/WorkItemsImportSeeder.ts`

There is **no** application command/facade layer between these callers and the
models. Confirms criterion #1 (single command boundary needed) and #2 (no
adapter should write the models directly).

## 3. No UnitOfWork; transaction boundaries are ad hoc (criteria #2, #4, #8)

`git grep` counts across `*.ts`:

| pattern           | count | note |
|-------------------|-------|------|
| `UnitOfWork`      | 0     | abstraction does not exist |
| `withTransaction` | 0     | no shared helper |
| `runInTransaction`| 0     | — |
| `transaction(`    | 45    | ad hoc transaction call sites |
| `client.query`    | 188   | raw query sites |
| `getClient`       | 20    | manual client acquisition |
| `pool.connect`    | 7     | manual pool acquisition |

Transaction boundaries are scattered across 45 `transaction(` sites and 188 raw
`client.query` calls with manual client/pool acquisition and no caller-owned
UnitOfWork. This is the root of criterion #4 (atomic/idempotent lifecycle
transitions) and #8 (concurrent-claim / rollback / restart tests).

## 4. Schema authority is split (criterion #5)

- Runtime `ensureTable` usages outside migrations: **28**
  (`git grep -Fw 'ensureTable' -- '*.ts' | grep -v migrations | wc -l`)
- Runtime `CREATE TABLE` outside migrations: **22**
  (`git grep -iF 'CREATE TABLE' -- '*.ts' | grep -v migrations | wc -l`)
- Projects-related ordered migrations: **29**
  (`git ls-files '.../migrations/*.ts' | grep -iE 'work_|project|lane|task|conveyor|custody|dispatch|planning|wait' | wc -l`)

Schema is owned by BOTH ordered migrations (29) and runtime DDL (28 ensureTable
+ 22 CREATE TABLE). Criterion #5 requires migrations to be the sole authority and
runtime ensureTable to perform capability verification only.

## 5. Consumer inventory

### CLI tools (38 files under `agent/tools/project/`)
add_task_comment, archive_lane, archive_project_item, cancel_task_wait,
conveyor_health, create_epic, create_lane, create_project, create_task,
create_task_dependency, explain_task_claimability, get_project_item,
inspect_lane_entry_automation, link_knowledge_item, list_lane_workflow_bindings,
list_lanes, list_linked_knowledge, list_project_items, list_task_comments,
list_task_dependencies, list_task_waits, manifests, project_report,
register_task_wait, remove_lane_workflow_binding, remove_task_dependency,
reorder_lanes, reset_lane_override, resolve_lane_workflow, resolve_lanes,
restore_lane, set_lane_workflow_binding, unlink_knowledge_item, update_epic,
update_lane, update_project, update_task (+ list continues to 38).
These are the public Sulla tool names that MUST remain stable (criterion #6).

### IPC (criteria #6, #9)
- `ipcMain.handle(...project...)` = **0** — main-side handlers are NOT registered
  through raw `ipcMain.handle`; they go through a wrapper/registry. The exact
  registration path must be located in Phase 3 before routing IPC through the facade.
- `ipcRenderer.invoke(...project...)` = **41** renderer call sites.
- Typed contract: `typings/electron-ipc.d.ts`.
- Board/lane payload (`lanesByProject` / `laneCapability`) referenced in:
  `composables/useProjects.ts`, `pages/ProjectsHome.vue`, `typings/electron-ipc.d.ts`.

### Orchestration (criteria #1, #4)
`HeartbeatNode`, `TaskDispatcherService`, `PlanningCouncilService`,
`CanonicalArtifactCustodyService` all read/write models directly today.

### Renderer/UI (criterion #9)
- Composable: `composables/useProjects.ts` (single).
- Vue project components/pages: 2 (incl. `pages/ProjectsHome.vue`).

## 6. Open items to resolve before Phase 1

1. Locate the exact main-side IPC registration wrapper (0 raw `ipcMain.handle`
   for project channels) — required to route IPC through the facade in Phase 3.
2. Enumerate the 45 `transaction(` call sites and classify each boundary
   (task mutation, lane-entry claim, workflow execution, review settlement,
   custody, repair handoff) — required for the UnitOfWork design (Phase 2).
3. Separate the ~50 runtime DDL sites into (a) true schema creation to migrate
   away vs (b) capability verification to keep (criterion #5).

## 7. Recommended Phase 1 entry points (domain kernel, behind adapters)

- Value objects: `TaskId`, `LaneKey`, `SemanticRole`, `ArtifactGeneration`.
- Entities/aggregates: `Task`, `Epic`, `Project`, `Pipeline/Board`.
- Domain objects: `LifecycleTransition`, `DispatchLease`, `Dependency`,
  `DurableWait`, `CustodyReceipt`, `DomainEvent`.
- Introduce these with zero behavior change behind compatibility adapters over
  the existing `WorkItemsModel` / `WorkTaskDispatchModel`.

## Scope note / gate

This PR delivers **only** the Phase 0 characterization artifact. Phases 1-8
(domain kernel, repositories/UnitOfWork, command facade, orchestration,
semantic lanes, read models, strangler removal, live acceptance) are code
phases that require iterative editing + real test verification and must be
authored on a worker surface with file-editing and test-run capability — they
are intentionally NOT attempted here. The Projects feature freeze (incl.
advance_task_lane) remains in effect until the required domain phase is accepted.
