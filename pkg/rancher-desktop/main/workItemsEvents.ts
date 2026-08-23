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
import { getIpcMainProxy } from '@pkg/main/ipcMain';
import Logging from '@pkg/utils/logging';

const console = Logging.background;
const ipcMainProxy = getIpcMainProxy(console);

async function importWorkItemsModel() {
  const mod = await import('@pkg/agent/database/models/WorkItemsModel');

  return mod.WorkItemsModel;
}

async function importKnowledgeModels() {
  const [associations, graph] = await Promise.all([
    import('@pkg/agent/database/models/WorkItemKnowledgeModel'),
    import('@pkg/agent/database/models/KnowledgeGraphModel'),
  ]);
  return { WorkItemKnowledgeModel: associations.WorkItemKnowledgeModel, KnowledgeGraphModel: graph.KnowledgeGraphModel };
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

  ipcMainProxy.handle('work-items:activity', async(_event: unknown, opts: { projectId?: string; author?: string; limit?: number } = {}) => {
    const WorkItemsModel = await importWorkItemsModel();

    return WorkItemsModel.listRecentActivity(opts);
  });

  ipcMainProxy.handle('work-items:knowledge-list', async(_event: unknown, input: {
    itemKind: KnowledgeWorkItemKind; itemId: string; includeInherited?: boolean; includeArchived?: boolean; limit?: number;
  }) => {
    const { WorkItemKnowledgeModel } = await importKnowledgeModels();
    return WorkItemKnowledgeModel.listForItem(input.itemKind, input.itemId, {
      includeInherited: input.includeInherited ?? true,
      includeArchived:  input.includeArchived ?? false,
      limit:            input.limit,
    });
  });

  ipcMainProxy.handle('work-items:knowledge-link', async(_event: unknown, input: KnowledgeLinkInput) => {
    const { WorkItemKnowledgeModel } = await importKnowledgeModels();
    return WorkItemKnowledgeModel.link({ ...input, source: input.source ?? 'ui', actor: input.actor ?? 'human' });
  });

  ipcMainProxy.handle('work-items:knowledge-unlink', async(_event: unknown, input: KnowledgeLinkInput) => {
    const { WorkItemKnowledgeModel } = await importKnowledgeModels();
    return WorkItemKnowledgeModel.unlink({ ...input, source: input.source ?? 'ui', actor: input.actor ?? 'human' });
  });

  ipcMainProxy.handle('knowledge:nodes-search', async(_event: unknown, input: { query?: string; includeArchived?: boolean; limit?: number } = {}) => {
    const { KnowledgeGraphModel } = await importKnowledgeModels();
    return KnowledgeGraphModel.searchNodes(input);
  });

  ipcMainProxy.handle('knowledge:work-list', async(_event: unknown, input: { knowledgeNodeId: string; includeArchived?: boolean; limit?: number }) => {
    const { WorkItemKnowledgeModel } = await importKnowledgeModels();
    return WorkItemKnowledgeModel.listForNode(input.knowledgeNodeId, input);
  });

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
}

interface ReorderUpdate {
  kind:      'epic' | 'task';
  id:        string;
  position?: number;
  status?:   string;
  epic_id?:  string;
  actor?:    string;
}
