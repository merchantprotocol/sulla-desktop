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
import type {
  CreateProjectPipelineTemplateInput, UpdateProjectPipelineTemplateInput,
} from '@pkg/agent/database/models/WorkProjectPipelineTemplateModel';
import type { SaveProjectViewInput } from '@pkg/agent/database/models/WorkProjectViewModel';
import { getIpcMainProxy } from '@pkg/main/ipcMain';
import Logging from '@pkg/utils/logging';

const console = Logging.background;
const ipcMainProxy = getIpcMainProxy(console);

async function importProjectsApplicationService() {
  const mod = await import('@pkg/agent/projects/application/ProjectsApplicationService');
  return mod.getProjectsApplicationService();
}

export async function listKnowledgeForWorkItem(input: {
  itemKind: KnowledgeWorkItemKind; itemId: string; includeInherited?: boolean; includeArchived?: boolean; limit?: number;
}) {
  const projects = await importProjectsApplicationService();
  return projects.listKnowledgeForItem(input);
}

export async function linkKnowledgeForWorkItem(input: KnowledgeLinkInput) {
  const projects = await importProjectsApplicationService();
  return projects.linkKnowledge(input, { actor: 'human', source: 'ipc' });
}

export async function unlinkKnowledgeForWorkItem(input: KnowledgeLinkInput) {
  const projects = await importProjectsApplicationService();
  return projects.unlinkKnowledge(input, { actor: 'human', source: 'ipc' });
}

export async function listWorkForKnowledge(input: { knowledgeNodeId: string; includeArchived?: boolean; limit?: number }) {
  const projects = await importProjectsApplicationService();
  return projects.listWorkForKnowledge(input.knowledgeNodeId, input);
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
    const app = await importProjectsApplicationService();
    const [projects, epics, tasks] = await Promise.all([
      app.listProjects({ includeDone: true, limit: 500 }),
      app.listEpics({ includeDone: true, limit: 1000 }),
      app.listTasks({ includeDone: true, limit: 3000 }),
    ]);

    const [projectCounts, epicCounts, taskCounts] = await Promise.all([
      app.countKnowledgeForItems('project', projects.map(item => item.id)),
      app.countKnowledgeForItems('epic', epics.map(item => item.id)),
      app.countKnowledgeForItems('task', tasks.map(item => item.id)),
    ]);
    const laneEntries = await Promise.all(projects.map(async project => [
      project.id,
      await app.resolveEffectiveLanes(project.id),
    ] as const));
    const laneCapability = await app.laneRuntimeCapability();

    return {
      projects:       projects.map(item => ({ ...item, knowledge_count: projectCounts[item.id] ?? 0 })),
      epics:          epics.map(item => ({ ...item, knowledge_count: epicCounts[item.id] ?? 0 })),
      tasks:          tasks.map(item => ({ ...item, knowledge_count: taskCounts[item.id] ?? 0 })),
      lanesByProject: Object.fromEntries(laneEntries),
      laneCapability,
    };
  });

  ipcMainProxy.handle('work-items:comments', async(_event: unknown, taskId: string) => {
    if (!taskId) return [];
    const projects = await importProjectsApplicationService();

    return projects.listComments(taskId);
  });

  ipcMainProxy.handle('work-items:artifact-evidence', async(_event: unknown, commentId: string) => {
    if (!commentId) return null;
    const { ArtifactReceiptModel } = await import('@pkg/agent/database/models/ArtifactReceiptModel');
    return ArtifactReceiptModel.loadEvidenceForComment(commentId);
  });

  ipcMainProxy.handle('work-items:activity', async(_event: unknown, opts: { projectId?: string; author?: string; limit?: number } = {}) => {
    const projects = await importProjectsApplicationService();

    return projects.listRecentActivity(opts);
  });

  ipcMainProxy.handle('work-items:automation-status', async() => {
    const projects = await importProjectsApplicationService();
    return projects.automationStatus();
  });

  ipcMainProxy.handle('work-items:conveyor-health', async(_event: unknown, opts: {
    projectId?: string | null; windowHours?: number;
  } = {}) => {
    const projects = await importProjectsApplicationService();
    const automation = await projects.automationStatus();
    return projects.conveyorHealth({
      projectId:   opts.projectId ?? null,
      windowHours: opts.windowHours,
      wipLimit:    automation.limits.execution,
      reviewLimit: automation.limits.review,
    });
  });

  ipcMainProxy.handle('work-items:conveyor-oldest', async(_event: unknown, opts: {
    projectId?: string | null; stage: import('@pkg/agent/database/models/WorkConveyorMetricsModel').SemanticStage;
  }) => {
    const allowed = new Set(['backlog', 'planning', 'execution', 'review', 'blocked', 'terminal', 'manual']);
    if (!allowed.has(opts.stage)) throw new Error(`Invalid semantic stage: ${ opts.stage }`);
    const projects = await importProjectsApplicationService();
    return projects.conveyorOldest(opts);
  });

  ipcMainProxy.handle('work-items:views-list', async(_event: unknown, projectId?: string | null) => {
    const projects = await importProjectsApplicationService();
    return projects.listViews(projectId);
  });

  ipcMainProxy.handle('work-items:view-resolve', async(_event: unknown, projectId?: string | null) => {
    const projects = await importProjectsApplicationService();
    return projects.resolveView(projectId);
  });

  ipcMainProxy.handle('work-items:view-save', async(_event: unknown, input: SaveProjectViewInput) => {
    const projects = await importProjectsApplicationService();
    return projects.saveView(input, { actor: 'human', source: 'ipc' });
  });

  ipcMainProxy.handle('work-items:dependencies-list', async(_event: unknown, projectId: string) => {
    const projects = await importProjectsApplicationService();
    return projects.listTaskDependencies(projectId);
  });

  ipcMainProxy.handle('work-items:dependency-set', async(_event: unknown, taskId: string, dependsOnTaskId: string) => {
    const projects = await importProjectsApplicationService();
    return projects.setTaskDependency(taskId, dependsOnTaskId, { actor: 'human', source: 'ipc' });
  });

  ipcMainProxy.handle('work-items:dependency-remove', async(_event: unknown, taskId: string, dependsOnTaskId: string) => {
    const projects = await importProjectsApplicationService();
    return projects.removeTaskDependency(taskId, dependsOnTaskId, { actor: 'human', source: 'ipc' });
  });

  ipcMainProxy.handle('work-items:ready-tasks', async(_event: unknown, input: { projectId: string; epicId?: string }) => {
    const projects = await importProjectsApplicationService();
    return projects.readyTasks(input);
  });

  ipcMainProxy.handle('work-items:pipeline-templates-list', async(_event: unknown, includeArchived = false) => {
    const projects = await importProjectsApplicationService();
    return projects.listProjectPipelineTemplates(includeArchived);
  });

  ipcMainProxy.handle('work-items:pipeline-template-get', async(_event: unknown, templateId: string) => {
    const projects = await importProjectsApplicationService();
    return projects.getProjectPipelineTemplate(templateId);
  });

  ipcMainProxy.handle('work-items:pipeline-template-create', async(_event: unknown, input: CreateProjectPipelineTemplateInput) => {
    const projects = await importProjectsApplicationService();
    return projects.createProjectPipelineTemplate(input, { actor: 'human', source: 'ipc' });
  });

  ipcMainProxy.handle('work-items:pipeline-template-update', async(
    _event: unknown,
    templateId: string,
    input: UpdateProjectPipelineTemplateInput,
  ) => {
    const projects = await importProjectsApplicationService();
    return projects.updateProjectPipelineTemplate(templateId, input, { actor: 'human', source: 'ipc' });
  });

  ipcMainProxy.handle('work-items:pipeline-template-archive', async(_event: unknown, templateId: string) => {
    const projects = await importProjectsApplicationService();
    return projects.archiveProjectPipelineTemplate(templateId, { actor: 'human', source: 'ipc' });
  });

  ipcMainProxy.handle('work-items:pipeline-template-apply', async(
    _event: unknown,
    projectId: string,
    templateId: string,
  ) => {
    const projects = await importProjectsApplicationService();
    return projects.applyProjectPipelineTemplate(projectId, templateId, { actor: 'human', source: 'ipc' });
  });

  // ── lane definitions ─────────────────────────────────────────────────

  ipcMainProxy.handle('work-items:lanes-list', async(_event: unknown, opts: {
    scope?: WorkLaneScope; projectId?: string; includeArchived?: boolean; includeReset?: boolean;
  } = {}) => {
    const projects = await importProjectsApplicationService();
    return projects.listLanes(opts);
  });

  ipcMainProxy.handle('work-items:lanes-resolve', async(_event: unknown, projectId: string, includeArchived = false) => {
    const projects = await importProjectsApplicationService();
    return projects.resolveEffectiveLanes(projectId, includeArchived);
  });

  ipcMainProxy.handle('work-items:lane-create', async(_event: unknown, input: CreateWorkLaneInput) => {
    const projects = await importProjectsApplicationService();
    return projects.createLane(input, { actor: 'human', source: 'ipc' });
  });

  ipcMainProxy.handle('work-items:lane-update', async(_event: unknown, id: string, changes: UpdateWorkLaneInput) => {
    const projects = await importProjectsApplicationService();
    return projects.updateLane(id, changes, { actor: 'human', source: 'ipc' });
  });

  ipcMainProxy.handle('work-items:lane-archive', async(_event: unknown, id: string, destinationLaneKey?: string) => {
    const projects = await importProjectsApplicationService();
    return projects.archiveLane(id, destinationLaneKey, { actor: 'human', source: 'ipc' });
  });

  ipcMainProxy.handle('work-items:lane-archive-preview', async(_event: unknown, id: string) => {
    const projects = await importProjectsApplicationService();
    return projects.previewArchiveLane(id);
  });

  ipcMainProxy.handle('work-items:lane-restore', async(_event: unknown, id: string) => {
    const projects = await importProjectsApplicationService();
    return projects.restoreLane(id, { actor: 'human', source: 'ipc' });
  });

  ipcMainProxy.handle('work-items:lanes-reorder', async(_event: unknown, scope: WorkLaneScope, orderedKeys: string[], projectId?: string) => {
    const projects = await importProjectsApplicationService();
    return projects.reorderLanes(scope, orderedKeys, projectId, { actor: 'human', source: 'ipc' });
  });

  ipcMainProxy.handle('work-items:lane-reset-override', async(_event: unknown, projectId: string, laneKey: string) => {
    const projects = await importProjectsApplicationService();
    return projects.resetLaneOverride(projectId, laneKey, { actor: 'human', source: 'ipc' });
  });

  // ── lane workflow bindings + entry audit ─────────────────────────────

  ipcMainProxy.handle('work-items:lane-bindings-list', async(_event: unknown, input: ListLaneBindingsInput = {}) => {
    const projects = await importProjectsApplicationService();
    return projects.listLaneBindings(input);
  });

  ipcMainProxy.handle('work-items:lane-binding-set', async(_event: unknown, input: SetLaneBindingInput) => {
    const projects = await importProjectsApplicationService();
    return projects.setLaneBinding(input, { actor: 'human', source: 'ipc' });
  });

  ipcMainProxy.handle('work-items:lane-binding-remove', async(_event: unknown, id: string) => {
    const projects = await importProjectsApplicationService();
    return projects.removeLaneBinding(id, { actor: 'human', source: 'ipc' });
  });

  ipcMainProxy.handle('work-items:lane-workflow-resolve', async(_event: unknown, taskId: string, laneKey: string, profileId = 'default') => {
    const projects = await importProjectsApplicationService();
    return projects.resolveLaneBinding(taskId, laneKey, profileId);
  });

  ipcMainProxy.handle('work-items:lane-workflow-resolve-context', async(_event: unknown, input: ResolveLaneBindingContextInput) => {
    const projects = await importProjectsApplicationService();
    return projects.resolveLaneBindingContext(input);
  });

  ipcMainProxy.handle('work-items:lane-compatible-workflows', async(_event: unknown, projectId: string, laneKey: string) => {
    const projects = await importProjectsApplicationService();
    return projects.listCompatibleLaneWorkflows(projectId, laneKey);
  });

  ipcMainProxy.handle('work-items:lane-entry-automations', async(_event: unknown, taskId: string) => {
    const projects = await importProjectsApplicationService();
    return projects.listLaneEntries(taskId);
  });

  ipcMainProxy.handle('work-items:knowledge-list', async(_event: unknown, input: {
    itemKind: KnowledgeWorkItemKind; itemId: string; includeInherited?: boolean; includeArchived?: boolean; limit?: number;
  }) => listKnowledgeForWorkItem(input));

  ipcMainProxy.handle('work-items:knowledge-link', async(_event: unknown, input: KnowledgeLinkInput) => linkKnowledgeForWorkItem(input));

  ipcMainProxy.handle('work-items:knowledge-unlink', async(_event: unknown, input: KnowledgeLinkInput) => unlinkKnowledgeForWorkItem(input));

  ipcMainProxy.handle('knowledge:nodes-search', async(_event: unknown, input: { query?: string; includeArchived?: boolean; limit?: number } = {}) => {
    const projects = await importProjectsApplicationService();
    return projects.searchKnowledgeNodes(input);
  });

  ipcMainProxy.handle('knowledge:work-list', async(_event: unknown, input: { knowledgeNodeId: string; includeArchived?: boolean; limit?: number }) => listWorkForKnowledge(input));

  // ── projects ─────────────────────────────────────────────────────────

  ipcMainProxy.handle('work-items:project-create', async(_event: unknown, input: UpsertProjectInput) => {
    const projects = await importProjectsApplicationService();
    const base = slugify(input.slug || input.title);
    let slug = base;
    let n = 2;
    while (await projects.getProjectBySlug(slug)) slug = `${ base }-${ n++ }`;

    return projects.createProject({ ...input, slug }, { actor: 'human', source: 'ipc' });
  });

  ipcMainProxy.handle('work-items:project-update', async(_event: unknown, id: string, changes: UpdateProjectInput) => {
    const projects = await importProjectsApplicationService();

    return projects.updateProject(id, changes, { actor: 'human', source: 'ipc' });
  });

  ipcMainProxy.handle('work-items:project-archive', async(_event: unknown, id: string) => {
    const projects = await importProjectsApplicationService();

    return projects.archive('project', id, { actor: 'human', source: 'ipc' });
  });

  // ── epics ────────────────────────────────────────────────────────────

  ipcMainProxy.handle('work-items:epic-create', async(_event: unknown, input: UpsertEpicInput) => {
    const projects = await importProjectsApplicationService();
    const existing = await projects.listEpics({ projectId: input.project_id, includeDone: true, limit: 1000 });
    const taken = new Set(existing.map(e => e.slug).filter(Boolean) as string[]);
    const base = slugify(input.slug || input.title);
    let slug = base;
    let n = 2;
    while (taken.has(slug)) slug = `${ base }-${ n++ }`;

    return projects.createEpic({ ...input, slug }, { actor: 'human', source: 'ipc' });
  });

  ipcMainProxy.handle('work-items:epic-update', async(_event: unknown, id: string, changes: UpdateEpicInput) => {
    const projects = await importProjectsApplicationService();

    return projects.updateEpic(id, changes, { actor: 'human', source: 'ipc' });
  });

  ipcMainProxy.handle('work-items:epic-archive', async(_event: unknown, id: string) => {
    const projects = await importProjectsApplicationService();

    return projects.archive('epic', id, { actor: 'human', source: 'ipc' });
  });

  // ── tasks ────────────────────────────────────────────────────────────

  ipcMainProxy.handle('work-items:task-create', async(_event: unknown, input: UpsertTaskInput) => {
    const projects = await importProjectsApplicationService();

    // insertTask always creates a new row and requires an epic_id.
    return projects.createTask({ ...input, actor: 'human' }, { actor: 'human', source: 'ipc' });
  });

  ipcMainProxy.handle('work-items:task-update', async(_event: unknown, id: string, changes: UpdateTaskInput) => {
    const projects = await importProjectsApplicationService();

    return projects.updateTask(id, { ...changes, actor: 'human' }, { actor: 'human', source: 'ipc' });
  });

  ipcMainProxy.handle('work-items:task-archive', async(_event: unknown, id: string) => {
    const projects = await importProjectsApplicationService();

    return projects.archive('task', id, { actor: 'human', source: 'ipc' });
  });

  // ── comments ─────────────────────────────────────────────────────────

  ipcMainProxy.handle('work-items:comment-add', async(_event: unknown, input: AddCommentInput) => {
    const projects = await importProjectsApplicationService();

    return projects.addComment(input, { actor: input.author ?? 'human', source: 'ipc' });
  });

  // ── reorder / move (batch position + optional status/epic move) ────────
  // One round-trip for a drag: renderer sends the new positions (and, for a
  // cross-column or cross-epic move, the new status / epic_id) for every row
  // that shifted. Applied in order through the model so last_moved_at + the
  // done→completed_at rules still fire.
  ipcMainProxy.handle('work-items:reorder', async(_event: unknown, updates: ReorderUpdate[]) => {
    const projects = await importProjectsApplicationService();
    await projects.reorder(updates, { actor: 'human', source: 'ipc' });
    return true;
  });

  // Domain events are the durable orchestration handoff. Drain them after IPC
  // setup so a crash after task commit cannot strand a lane transition.
  import('@pkg/agent/projects/application/ProjectsOrchestrationEventService')
    .then(({ getProjectsOrchestrationEventService }) => getProjectsOrchestrationEventService().drain(50))
    .catch(error => console.warn('[WorkItems] Projects orchestration recovery failed:', error));

  // The domain-event drain only recovers transitions that never dispatched.
  // A lane workflow that dies MID-RUN leaves its lane entry stuck in
  // 'running' with the outbox already settled — drainRecoverable is the only
  // path that resumes those. Recovery is lease-fenced in the model, so both
  // startup and periodic sweeps leave live executions alone.
  const sweepLaneEntries = () => {
    import('@pkg/agent/services/LaneEntryAutomationService')
      .then(({ LaneEntryAutomationService }) => LaneEntryAutomationService.drainRecoverable(50))
      .catch(error => console.warn('[WorkItems] Lane-entry automation recovery failed:', error));
  };
  sweepLaneEntries();
  setInterval(sweepLaneEntries, 5 * 60_000);
}

interface ReorderUpdate {
  kind:      'epic' | 'task';
  id:        string;
  position?: number;
  status?:   string;
  epic_id?:  string;
  actor?:    string;
}
