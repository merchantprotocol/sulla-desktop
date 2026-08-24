/**
 * Work-items IPC — bridge from the renderer to the Postgres Projects:
 * work_projects → work_epics → work_tasks → work_task_comments.
 *
 * Backs the Projects view (ProjectsHome.vue / useProjects.ts). The renderer
 * never touches the DB directly — it invokes these channels and the main
 * process reads/writes through WorkItemsModel.
 *
 * Full CRUD:
 *   read    → work-items:board, work-items:comments, work-items:activity
 *   create  → work-items:{project,epic,task}-create, work-items:comment-add
 *   update  → work-items:{project,epic,task}-update
 *   delete  → work-items:{project,epic,task}-archive  (soft, cascades down)
 *
 * "Create" guarantees a NEW row: the model's upsert* methods key on slug, so
 * we resolve a unique slug here before inserting. Tasks use insertTask (always
 * new) and require an epic_id.
 *
 * The DB layer is pulled in via a dynamic import (same pattern as
 * sullaWorkflowEvents.ts) so the main process doesn't eagerly load the
 * Postgres stack at startup.
 *
 * DUAL-STORE NOTE: reads/writes ONLY Postgres via WorkItemsModel — never Redis.
 */

import type { KnowledgeLinkInput, KnowledgeWorkItemKind } from '@pkg/agent/database/models/WorkItemKnowledgeModel';
import type {
  UpsertProjectInput, UpdateProjectInput,
  UpsertEpicInput, UpdateEpicInput,
  UpsertTaskInput, UpdateTaskInput,
  AddCommentInput,
} from '@pkg/agent/database/models/WorkItemsModel';
import type {
  CreateWorkLaneInput, UpdateWorkLaneInput, WorkLaneScope,
} from '@pkg/agent/database/models/WorkLaneDefinitionModel';
import type {
  ListLaneBindingsInput, ResolveLaneBindingContextInput, SetLaneBindingInput,
} from '@pkg/agent/database/models/WorkLaneWorkflowBindingModel';
import type { SaveProjectViewInput } from '@pkg/agent/database/models/WorkProjectViewModel';
import { getIpcMainProxy } from '@pkg/main/ipcMain';
import Logging from '@pkg/utils/logging';

const console = Logging.background;
const ipcMainProxy = getIpcMainProxy(console);

async function importWorkItemsModel() {
  const mod = await import('@pkg/agent/database/models/WorkItemsModel');

  return mod.WorkItemsModel;
}

async function importWorkLaneDefinitionModel() {
  const mod = await import('@pkg/agent/database/models/WorkLaneDefinitionModel');

  return mod.WorkLaneDefinitionModel;
}

async function importWorkLaneWorkflowBindingModel() {
  const mod = await import('@pkg/agent/database/models/WorkLaneWorkflowBindingModel');
  return mod.WorkLaneWorkflowBindingModel;
}

async function importWorkProjectViewModel() {
  const mod = await import('@pkg/agent/database/models/WorkProjectViewModel');
  return mod.WorkProjectViewModel;
}

async function importKnowledgeModels() {
  const [associations, graph] = await Promise.all([
    import('@pkg/agent/database/models/WorkItemKnowledgeModel'),
    import('@pkg/agent/database/models/KnowledgeGraphModel'),
  ]);
  return { WorkItemKnowledgeModel: associations.WorkItemKnowledgeModel, KnowledgeGraphModel: graph.KnowledgeGraphModel };
}

export async function listKnowledgeForWorkItem(input: {
  itemKind: KnowledgeWorkItemKind; itemId: string; includeInherited?: boolean; includeArchived?: boolean; limit?: number;
}) {
  const { WorkItemKnowledgeModel } = await importKnowledgeModels();
  return WorkItemKnowledgeModel.listForItem(input.itemKind, input.itemId, {
    includeInherited: input.includeInherited ?? true,
    includeArchived:  input.includeArchived ?? false,
    limit:            input.limit,
  });
}

export async function linkKnowledgeForWorkItem(input: KnowledgeLinkInput) {
  const { WorkItemKnowledgeModel } = await importKnowledgeModels();
  return WorkItemKnowledgeModel.link({ ...input, source: input.source ?? 'ui', actor: input.actor ?? 'human' });
}

export async function unlinkKnowledgeForWorkItem(input: KnowledgeLinkInput) {
  const { WorkItemKnowledgeModel } = await importKnowledgeModels();
  return WorkItemKnowledgeModel.unlink({ ...input, source: input.source ?? 'ui', actor: input.actor ?? 'human' });
}

export async function listWorkForKnowledge(input: { knowledgeNodeId: string; includeArchived?: boolean; limit?: number }) {
  const { WorkItemKnowledgeModel } = await importKnowledgeModels();
  return WorkItemKnowledgeModel.listForNode(input.knowledgeNodeId, input);
}

/** Local slugify — mirrors the model's private one (kebab, ≤80 chars). */
function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'item';
}

export function initWorkItemsEvents(): void {
  // ── reads ────────────────────────────────────────────────────────────

  // Whole board in one round-trip: projects + epics + tasks (done included so
  // the board can render its Done column). The renderer builds the tree.
  // Do NOT swallow errors — a thrown query surfaces in useProjects.error.
  ipcMainProxy.handle('work-items:board', async() => {
    const WorkItemsModel = await importWorkItemsModel();
    const { WorkItemKnowledgeModel } = await importKnowledgeModels();
    const [projects, epics, tasks] = await Promise.all([
      WorkItemsModel.listProjects({ includeDone: true, limit: 500 }),
      WorkItemsModel.listEpics({ includeDone: true, limit: 1000 }),
      WorkItemsModel.listTasks({ includeDone: true, limit: 3000 }),
    ]);

    const [projectCounts, epicCounts, taskCounts] = await Promise.all([
      WorkItemKnowledgeModel.countForItems('project', projects.map(item => item.id)),
      WorkItemKnowledgeModel.countForItems('epic', epics.map(item => item.id)),
      WorkItemKnowledgeModel.countForItems('task', tasks.map(item => item.id)),
    ]);

    return {
      projects: projects.map(item => ({ ...item, knowledge_count: projectCounts[item.id] ?? 0 })),
      epics:    epics.map(item => ({ ...item, knowledge_count: epicCounts[item.id] ?? 0 })),
      tasks:    tasks.map(item => ({ ...item, knowledge_count: taskCounts[item.id] ?? 0 })),
    };
  });

  ipcMainProxy.handle('work-items:comments', async(_event: unknown, taskId: string) => {
    if (!taskId) return [];
    const WorkItemsModel = await importWorkItemsModel();

    return WorkItemsModel.listComments(taskId);
  });

  ipcMainProxy.handle('work-items:artifact-evidence', async(_event: unknown, commentId: string) => {
    if (!commentId) return null;
    const { ArtifactReceiptModel } = await import('@pkg/agent/database/models/ArtifactReceiptModel');
    return ArtifactReceiptModel.loadEvidenceForComment(commentId);
  });

  ipcMainProxy.handle('work-items:activity', async(_event: unknown, opts: { projectId?: string; author?: string; limit?: number } = {}) => {
    const WorkItemsModel = await importWorkItemsModel();

    return WorkItemsModel.listRecentActivity(opts);
  });

  ipcMainProxy.handle('work-items:automation-status', async() => {
    const [{ WorkTaskDispatchModel }, limitsModule] = await Promise.all([
      import('@pkg/agent/database/models/WorkTaskDispatchModel'),
      import('@pkg/agent/services/ProjectAutomationWipLimits'),
    ]);
    const [limits, counts] = await Promise.all([
      limitsModule.resolveWipLimits(),
      WorkTaskDispatchModel.countByRole(),
    ]);
    return {
      limits,
      counts,
      decision: limitsModule.evaluateClaim('execution', counts, limits),
      at: new Date().toISOString(),
    };
  });

  ipcMainProxy.handle('work-items:views-list', async(_event: unknown, projectId?: string | null) => {
    const Model = await importWorkProjectViewModel();
    return Model.list(projectId);
  });

  ipcMainProxy.handle('work-items:view-resolve', async(_event: unknown, projectId?: string | null) => {
    const Model = await importWorkProjectViewModel();
    return Model.resolve(projectId);
  });

  ipcMainProxy.handle('work-items:view-save', async(_event: unknown, input: SaveProjectViewInput) => {
    const Model = await importWorkProjectViewModel();
    return Model.save({ ...input, actor: input.actor ?? 'human' });
  });

  ipcMainProxy.handle('work-items:dependencies-list', async(_event: unknown, projectId: string) => {
    const WorkItemsModel = await importWorkItemsModel();
    return WorkItemsModel.listTaskDependencies(projectId);
  });

  ipcMainProxy.handle('work-items:dependency-set', async(_event: unknown, taskId: string, dependsOnTaskId: string) => {
    const WorkItemsModel = await importWorkItemsModel();
    return WorkItemsModel.setTaskDependency(taskId, dependsOnTaskId, 'human');
  });

  ipcMainProxy.handle('work-items:dependency-remove', async(_event: unknown, taskId: string, dependsOnTaskId: string) => {
    const WorkItemsModel = await importWorkItemsModel();
    return WorkItemsModel.removeTaskDependency(taskId, dependsOnTaskId);
  });

  // ── lane definitions ─────────────────────────────────────────────────

  ipcMainProxy.handle('work-items:lanes-list', async(_event: unknown, opts: {
    scope?: WorkLaneScope; projectId?: string; includeArchived?: boolean; includeReset?: boolean;
  } = {}) => {
    const Model = await importWorkLaneDefinitionModel();
    return Model.list(opts);
  });

  ipcMainProxy.handle('work-items:lanes-resolve', async(_event: unknown, projectId: string, includeArchived = false) => {
    const Model = await importWorkLaneDefinitionModel();
    return Model.resolveEffective(projectId, includeArchived);
  });

  ipcMainProxy.handle('work-items:lane-create', async(_event: unknown, input: CreateWorkLaneInput) => {
    const Model = await importWorkLaneDefinitionModel();
    return Model.create({ ...input, actor: input.actor ?? 'human' });
  });

  ipcMainProxy.handle('work-items:lane-update', async(_event: unknown, id: string, changes: UpdateWorkLaneInput) => {
    const Model = await importWorkLaneDefinitionModel();
    return Model.update(id, { ...changes, actor: changes.actor ?? 'human' });
  });

  ipcMainProxy.handle('work-items:lane-archive', async(_event: unknown, id: string, destinationLaneKey?: string) => {
    const Model = await importWorkLaneDefinitionModel();
    return Model.archive(id, destinationLaneKey, 'human');
  });

  ipcMainProxy.handle('work-items:lane-archive-preview', async(_event: unknown, id: string) => {
    const Model = await importWorkLaneDefinitionModel();
    return Model.previewArchive(id);
  });

  ipcMainProxy.handle('work-items:lane-restore', async(_event: unknown, id: string) => {
    const Model = await importWorkLaneDefinitionModel();
    return Model.restore(id, 'human');
  });

  ipcMainProxy.handle('work-items:lanes-reorder', async(_event: unknown, scope: WorkLaneScope, orderedKeys: string[], projectId?: string) => {
    const Model = await importWorkLaneDefinitionModel();
    return Model.reorder(scope, orderedKeys, projectId, 'human');
  });

  ipcMainProxy.handle('work-items:lane-reset-override', async(_event: unknown, projectId: string, laneKey: string) => {
    const Model = await importWorkLaneDefinitionModel();
    return Model.resetProjectOverride(projectId, laneKey, 'human');
  });

  // ── lane workflow bindings + entry audit ─────────────────────────────

  ipcMainProxy.handle('work-items:lane-bindings-list', async(_event: unknown, input: ListLaneBindingsInput = {}) => {
    const Model = await importWorkLaneWorkflowBindingModel();
    return Model.list(input);
  });

  ipcMainProxy.handle('work-items:lane-binding-set', async(_event: unknown, input: SetLaneBindingInput) => {
    const Model = await importWorkLaneWorkflowBindingModel();
    return Model.set({ ...input, actor: input.actor ?? 'human' });
  });

  ipcMainProxy.handle('work-items:lane-binding-remove', async(_event: unknown, id: string) => {
    const Model = await importWorkLaneWorkflowBindingModel();
    return Model.remove(id, 'human');
  });

  ipcMainProxy.handle('work-items:lane-workflow-resolve', async(_event: unknown, taskId: string, laneKey: string, profileId = 'default') => {
    const Model = await importWorkLaneWorkflowBindingModel();
    return Model.resolve(taskId, laneKey, profileId);
  });

  ipcMainProxy.handle('work-items:lane-workflow-resolve-context', async(_event: unknown, input: ResolveLaneBindingContextInput) => {
    const Model = await importWorkLaneWorkflowBindingModel();
    return Model.resolveForContext(input);
  });

  ipcMainProxy.handle('work-items:lane-compatible-workflows', async(_event: unknown, projectId: string, laneKey: string) => {
    const Model = await importWorkLaneWorkflowBindingModel();
    return Model.listCompatibleWorkflows(projectId, laneKey);
  });

  ipcMainProxy.handle('work-items:lane-entry-automations', async(_event: unknown, taskId: string) => {
    const Model = await importWorkLaneWorkflowBindingModel();
    return Model.listLaneEntries(taskId);
  });

  ipcMainProxy.handle('work-items:knowledge-list', async(_event: unknown, input: {
    itemKind: KnowledgeWorkItemKind; itemId: string; includeInherited?: boolean; includeArchived?: boolean; limit?: number;
  }) => listKnowledgeForWorkItem(input));

  ipcMainProxy.handle('work-items:knowledge-link', async(_event: unknown, input: KnowledgeLinkInput) => linkKnowledgeForWorkItem(input));

  ipcMainProxy.handle('work-items:knowledge-unlink', async(_event: unknown, input: KnowledgeLinkInput) => unlinkKnowledgeForWorkItem(input));

  ipcMainProxy.handle('knowledge:nodes-search', async(_event: unknown, input: { query?: string; includeArchived?: boolean; limit?: number } = {}) => {
    const { KnowledgeGraphModel } = await importKnowledgeModels();
    return KnowledgeGraphModel.searchNodes(input);
  });

  ipcMainProxy.handle('knowledge:work-list', async(_event: unknown, input: { knowledgeNodeId: string; includeArchived?: boolean; limit?: number }) => listWorkForKnowledge(input));

  // ── projects ─────────────────────────────────────────────────────────

  ipcMainProxy.handle('work-items:project-create', async(_event: unknown, input: UpsertProjectInput) => {
    const WorkItemsModel = await importWorkItemsModel();
    const base = slugify(input.slug || input.title);
    let slug = base;
    let n = 2;
    while (await WorkItemsModel.getProjectBySlug(slug)) slug = `${ base }-${ n++ }`;

    return WorkItemsModel.upsertProject({ ...input, slug });
  });

  ipcMainProxy.handle('work-items:project-update', async(_event: unknown, id: string, changes: UpdateProjectInput) => {
    const WorkItemsModel = await importWorkItemsModel();

    return WorkItemsModel.updateProject(id, changes);
  });

  ipcMainProxy.handle('work-items:project-archive', async(_event: unknown, id: string) => {
    const WorkItemsModel = await importWorkItemsModel();

    return WorkItemsModel.archive('project', id);
  });

  // ── epics ────────────────────────────────────────────────────────────

  ipcMainProxy.handle('work-items:epic-create', async(_event: unknown, input: UpsertEpicInput) => {
    const WorkItemsModel = await importWorkItemsModel();
    const existing = await WorkItemsModel.listEpics({ projectId: input.project_id, includeDone: true, limit: 1000 });
    const taken = new Set(existing.map(e => e.slug).filter(Boolean) as string[]);
    const base = slugify(input.slug || input.title);
    let slug = base;
    let n = 2;
    while (taken.has(slug)) slug = `${ base }-${ n++ }`;

    return WorkItemsModel.upsertEpic({ ...input, slug });
  });

  ipcMainProxy.handle('work-items:epic-update', async(_event: unknown, id: string, changes: UpdateEpicInput) => {
    const WorkItemsModel = await importWorkItemsModel();

    return WorkItemsModel.updateEpic(id, changes);
  });

  ipcMainProxy.handle('work-items:epic-archive', async(_event: unknown, id: string) => {
    const WorkItemsModel = await importWorkItemsModel();

    return WorkItemsModel.archive('epic', id);
  });

  // ── tasks ────────────────────────────────────────────────────────────

  ipcMainProxy.handle('work-items:task-create', async(_event: unknown, input: UpsertTaskInput) => {
    const WorkItemsModel = await importWorkItemsModel();

    // insertTask always creates a new row and requires an epic_id.
    return WorkItemsModel.insertTask({ ...input, actor: input.actor ?? 'human' });
  });

  ipcMainProxy.handle('work-items:task-update', async(_event: unknown, id: string, changes: UpdateTaskInput) => {
    const WorkItemsModel = await importWorkItemsModel();

    return WorkItemsModel.updateTask(id, { ...changes, actor: changes.actor ?? 'human' });
  });

  ipcMainProxy.handle('work-items:task-archive', async(_event: unknown, id: string) => {
    const WorkItemsModel = await importWorkItemsModel();

    return WorkItemsModel.archive('task', id);
  });

  // ── comments ─────────────────────────────────────────────────────────

  ipcMainProxy.handle('work-items:comment-add', async(_event: unknown, input: AddCommentInput) => {
    const WorkItemsModel = await importWorkItemsModel();

    return WorkItemsModel.addComment(input);
  });

  // ── reorder / move (batch position + optional status/epic move) ────────
  // One round-trip for a drag: renderer sends the new positions (and, for a
  // cross-column or cross-epic move, the new status / epic_id) for every row
  // that shifted. Applied in order through the model so last_moved_at + the
  // done→completed_at rules still fire.
  ipcMainProxy.handle('work-items:reorder', async(_event: unknown, updates: ReorderUpdate[]) => {
    const WorkItemsModel = await importWorkItemsModel();
    for (const u of updates) {
      if (u.kind === 'epic') {
        const changes: UpdateEpicInput = {};
        if (u.position !== undefined) changes.position = u.position;
        if (u.status !== undefined) changes.status = u.status;
        await WorkItemsModel.updateEpic(u.id, changes);
      } else {
        const changes: UpdateTaskInput = {};
        if (u.position !== undefined) changes.position = u.position;
        if (u.status !== undefined) changes.status = u.status;
        if (u.epic_id !== undefined) changes.epic_id = u.epic_id;
        await WorkItemsModel.updateTask(u.id, { ...changes, actor: changes.actor ?? 'human' });
      }
    }

    return true;
  });

  // Lane claims are committed outbox rows. Drain them after handler setup so
  // a crash between task commit and dispatch cannot silently strand work.
  import('@pkg/agent/services/LaneEntryAutomationService')
    .then(({ LaneEntryAutomationService }) => LaneEntryAutomationService.drainRecoverable(50, true))
    .catch(error => console.warn('[WorkItems] Lane-entry recovery failed:', error));
}

interface ReorderUpdate {
  kind:      'epic' | 'task';
  id:        string;
  position?: number;
  status?:   string;
  epic_id?:  string;
  actor?:    string;
}
