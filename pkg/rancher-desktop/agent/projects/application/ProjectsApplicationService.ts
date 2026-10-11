import { KnowledgeGraphModel } from '../../database/models/KnowledgeGraphModel';
import { WorkItemKnowledgeModel } from '../../database/models/WorkItemKnowledgeModel';
import { isHumanCommentAuthor } from '../../database/models/WorkItemsModel';
import { WorkLaneDefinitionModel } from '../../database/models/WorkLaneDefinitionModel';
import { CORE_PROJECT_PIPELINE_TEMPLATE_ID, WorkProjectPipelineTemplateModel } from '../../database/models/WorkProjectPipelineTemplateModel';
import { WorkProjectViewModel } from '../../database/models/WorkProjectViewModel';
import { WorkTaskDependencyModel } from '../../database/models/WorkTaskDependencyModel';
import { ArtifactCustodyPolicy } from '../../services/ArtifactCustodyPolicy';
import { PostgresProjectsRepository } from '../infrastructure/PostgresProjectsRepository';

import type { ProjectsRepository } from './ProjectsRepository';
import type { KnowledgeLinkInput, KnowledgeWorkItemKind } from '../../database/models/WorkItemKnowledgeModel';
import type {
  AddCommentInput, ListActivityOpts, ListEpicsOpts, ListOpts, ListTasksOpts, SearchOpts,
  UpdateEpicInput, UpdateProjectInput, UpdateTaskInput,
  UpsertEpicInput, UpsertProjectInput, UpsertTaskInput, WorkItemKind,
  WorkTaskRecord,
} from '../../database/models/WorkItemsModel';
import type { CreateWorkLaneInput, ListWorkLaneOpts, UpdateWorkLaneInput, WorkLaneScope } from '../../database/models/WorkLaneDefinitionModel';
import type { CreateProjectPipelineTemplateInput, UpdateProjectPipelineTemplateInput } from '../../database/models/WorkProjectPipelineTemplateModel';
import type { SaveProjectViewInput } from '../../database/models/WorkProjectViewModel';
import type { CreateDependencyInput, RemoveDependencyInput, TaskDependencyHold } from '../../database/models/WorkTaskDependencyModel';

export type ProjectsCommandSource = 'tool' | 'ipc' | 'heartbeat' | 'routine' | 'system';

export interface ProjectsCommandContext {
  actor:  string;
  source: ProjectsCommandSource;
}

export interface ReorderProjectItem {
  kind:      'epic' | 'task';
  id:        string;
  position?: number;
  status?:   string;
  epic_id?:  string;
}

export interface ReadyTasksInput {
  projectId: string;
  epicId?:   string;
  limit?:    number;
}

export interface ReadyTasksResult {
  ready:   WorkTaskRecord[];
  runnablePrerequisites: WorkTaskRecord[];
  blocked: { task: WorkTaskRecord; holds: TaskDependencyHold[] }[];
}

const DEFAULT_CONTEXT: ProjectsCommandContext = { actor: 'sulla', source: 'system' };

function itemId(value: unknown, field = 'id'): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) throw new Error(`${ field } is required.`);
  return normalized;
}

/**
 * The sole application boundary for Projects. Tools, IPC and agents submit
 * commands here so validation cannot diverge between adapters. Projects is a
 * plain board: nothing here claims, launches or moves work on its own.
 */
export class ProjectsApplicationService {
  constructor(private readonly repository: ProjectsRepository = new PostgresProjectsRepository()) {}

  ready() { return this.repository.verifySchema() }
  getProject(id: string) { return this.repository.getProject(itemId(id)) }
  getProjectBySlug(slug: string) { return this.repository.getProjectBySlug(slug) }
  listProjects(opts: ListOpts = {}) { return this.repository.listProjects(opts) }
  getEpic(id: string) { return this.repository.getEpic(itemId(id)) }
  listEpics(opts: ListEpicsOpts = {}) { return this.repository.listEpics(opts) }
  getTask(id: string) { return this.repository.getTask(itemId(id)) }
  listTasks(opts: ListTasksOpts = {}) { return this.repository.listTasks(opts) }
  listComments(taskId: string) { return this.repository.listComments(itemId(taskId, 'task_id')) }
  listRecentActivity(opts: ListActivityOpts = {}) { return this.repository.listRecentActivity(opts) }
  search(opts: SearchOpts) { return this.repository.search(opts) }
  listTaskDependencies(projectId: string) {
    return this.repository.listTaskDependencies(itemId(projectId, 'project_id'));
  }

  resolveEffectiveLanes(projectId: string, includeArchived = false) {
    return WorkLaneDefinitionModel.resolveEffective(itemId(projectId, 'project_id'), includeArchived);
  }

  laneRuntimeCapability(projectId?: string) {
    return WorkLaneDefinitionModel.runtimeCapability(projectId);
  }

  listViews(projectId?: string | null) { return WorkProjectViewModel.list(projectId) }
  resolveView(projectId?: string | null) { return WorkProjectViewModel.resolve(projectId) }
  saveView(input: SaveProjectViewInput, context: ProjectsCommandContext = DEFAULT_CONTEXT) {
    return WorkProjectViewModel.save({ ...input, actor: input.actor ?? context.actor });
  }

  listLanes(opts: ListWorkLaneOpts = {}) { return WorkLaneDefinitionModel.list(opts) }
  createLane(input: CreateWorkLaneInput, context: ProjectsCommandContext = DEFAULT_CONTEXT) {
    return WorkLaneDefinitionModel.create({ ...input, actor: input.actor ?? context.actor });
  }

  updateLane(id: string, changes: UpdateWorkLaneInput, context: ProjectsCommandContext = DEFAULT_CONTEXT) {
    return WorkLaneDefinitionModel.update(id, { ...changes, actor: changes.actor ?? context.actor });
  }

  archiveLane(id: string, destinationLaneKey?: string, context: ProjectsCommandContext = DEFAULT_CONTEXT) {
    const trustedHuman = context.source === 'ipc' && context.actor === 'human';
    if (context.actor === 'human' && !trustedHuman) throw new Error('Only the Projects UI can act as the human.');
    return WorkLaneDefinitionModel.archive(id, destinationLaneKey, context.actor);
  }

  previewArchiveLane(id: string) { return WorkLaneDefinitionModel.previewArchive(id) }
  restoreLane(id: string, context: ProjectsCommandContext = DEFAULT_CONTEXT) {
    return WorkLaneDefinitionModel.restore(id, context.actor);
  }

  reorderLanes(scope: WorkLaneScope, orderedKeys: string[], projectId?: string, context: ProjectsCommandContext = DEFAULT_CONTEXT) {
    return WorkLaneDefinitionModel.reorder(scope, orderedKeys, projectId, context.actor);
  }

  resetLaneOverride(projectId: string, laneKey: string, context: ProjectsCommandContext = DEFAULT_CONTEXT) {
    return WorkLaneDefinitionModel.resetProjectOverride(projectId, laneKey, context.actor);
  }

  countKnowledgeForItems(kind: KnowledgeWorkItemKind, ids: string[]) {
    return WorkItemKnowledgeModel.countForItems(kind, ids);
  }

  listKnowledgeForItem(input: {
    itemKind: KnowledgeWorkItemKind; itemId: string; includeInherited?: boolean; includeArchived?: boolean; relationType?: string; limit?: number;
  }) {
    return WorkItemKnowledgeModel.listForItem(input.itemKind, input.itemId, {
      includeInherited: input.includeInherited ?? true,
      includeArchived:  input.includeArchived ?? false,
      relationType:     input.relationType,
      limit:            input.limit,
    });
  }

  linkKnowledge(input: KnowledgeLinkInput, context: ProjectsCommandContext = DEFAULT_CONTEXT) {
    return WorkItemKnowledgeModel.link({ ...input, source: input.source ?? context.source, actor: input.actor ?? context.actor });
  }

  unlinkKnowledge(input: KnowledgeLinkInput, context: ProjectsCommandContext = DEFAULT_CONTEXT) {
    return WorkItemKnowledgeModel.unlink({ ...input, source: input.source ?? context.source, actor: input.actor ?? context.actor });
  }

  listWorkForKnowledge(knowledgeNodeId: string, opts: { includeArchived?: boolean; limit?: number } = {}) {
    return WorkItemKnowledgeModel.listForNode(knowledgeNodeId, opts);
  }

  searchKnowledgeNodes(input: { query?: string; includeArchived?: boolean; limit?: number } = {}) {
    return KnowledgeGraphModel.searchNodes(input);
  }

  async createProject(input: UpsertProjectInput, context: ProjectsCommandContext = DEFAULT_CONTEXT) {
    const project = await this.repository.createProject(input);
    if (!project.pipeline_template_id) {
      await WorkProjectPipelineTemplateModel.applyToProject(
        project.id, input.pipeline_template_id ?? CORE_PROJECT_PIPELINE_TEMPLATE_ID, context.actor,
      );
      return (await this.repository.getProject(project.id)) ?? project;
    }
    return project;
  }

  listProjectPipelineTemplates(includeArchived = false) {
    return WorkProjectPipelineTemplateModel.list(includeArchived);
  }

  getProjectPipelineTemplate(id: string) {
    return WorkProjectPipelineTemplateModel.get(itemId(id, 'template_id'));
  }

  createProjectPipelineTemplate(input: CreateProjectPipelineTemplateInput, context: ProjectsCommandContext = DEFAULT_CONTEXT) {
    return WorkProjectPipelineTemplateModel.create({ ...input, actor: input.actor ?? context.actor });
  }

  applyProjectPipelineTemplate(projectId: string, templateId: string, context: ProjectsCommandContext = DEFAULT_CONTEXT) {
    return WorkProjectPipelineTemplateModel.applyToProject(
      itemId(projectId, 'project_id'), itemId(templateId, 'template_id'), context.actor,
    );
  }

  archiveProjectPipelineTemplate(templateId: string, context: ProjectsCommandContext = DEFAULT_CONTEXT) {
    return WorkProjectPipelineTemplateModel.archive(itemId(templateId, 'template_id'), context.actor);
  }

  updateProjectPipelineTemplate(
    templateId: string,
    input: UpdateProjectPipelineTemplateInput,
    context: ProjectsCommandContext = DEFAULT_CONTEXT,
  ) {
    return WorkProjectPipelineTemplateModel.update(itemId(templateId, 'template_id'), { ...input, actor: input.actor ?? context.actor });
  }

  updateProject(id: string, changes: UpdateProjectInput, _context: ProjectsCommandContext = DEFAULT_CONTEXT) {
    return this.repository.updateProject(itemId(id), changes);
  }

  createEpic(input: UpsertEpicInput, _context: ProjectsCommandContext = DEFAULT_CONTEXT) {
    return this.repository.createEpic(input);
  }

  updateEpic(id: string, changes: UpdateEpicInput, _context: ProjectsCommandContext = DEFAULT_CONTEXT) {
    return this.repository.updateEpic(itemId(id), changes);
  }

  createTask(input: UpsertTaskInput, context: ProjectsCommandContext = DEFAULT_CONTEXT) {
    return this.repository.createTask({ ...input, actor: input.actor ?? context.actor });
  }

  async updateTask(
    id: string,
    changes: UpdateTaskInput,
    context: ProjectsCommandContext = DEFAULT_CONTEXT,
  ): Promise<WorkTaskRecord | null> {
    const taskId = itemId(id);
    const current = await this.repository.getTask(taskId);
    if (!current) return null;
    const trustedHuman = context.source === 'ipc' && context.actor === 'human';
    if (!trustedHuman && (changes.actor === 'human' || context.actor === 'human')) {
      throw new Error('Tool input cannot act as the human; use your own agent id as actor.');
    }
    const actor = trustedHuman ? 'human' : changes.actor ?? context.actor;

    if (changes.status !== undefined && changes.status !== current.status) {
      const destinationProjectId = changes.epic_id
        ? (await this.repository.getEpic(changes.epic_id))?.project_id ?? current.project_id
        : current.project_id;
      const destinationLane = await WorkLaneDefinitionModel.validateTaskStatus(destinationProjectId, changes.status);
      const role = destinationLane?.semantic_role ?? 'manual';
      if (role === 'review') await ArtifactCustodyPolicy.assertForTransition('in_review', changes.custody);
      if (role === 'terminal') await ArtifactCustodyPolicy.assertForTransition('done', changes.custody);
      if (destinationProjectId !== current.project_id && changes.epic_id === undefined) {
        throw new Error('A task cannot change projects without moving through an epic in the destination project.');
      }
    }
    return this.repository.updateTask(taskId, { ...changes, actor });
  }

  archive(kind: WorkItemKind, id: string, _context: ProjectsCommandContext = DEFAULT_CONTEXT) {
    return this.repository.archive(kind, itemId(id));
  }

  async addComment(input: AddCommentInput, _context: ProjectsCommandContext = DEFAULT_CONTEXT) {
    const comment = await this.repository.addComment(input);
    // A human comment is a request for Heartbeat's attention (HumanCommentTriage);
    // don't make the human wait out the full Heartbeat interval.
    if (isHumanCommentAuthor(comment.author)) {
      void import('../../services/HeartbeatService')
        .then(({ getHeartbeatService }) => getHeartbeatService().requestWake(`human commented on task ${ comment.task_id }`))
        .catch(() => { /* Heartbeat not running in this process */ });
    }
    return comment;
  }

  setTaskDependency(taskId: string, dependsOnTaskId: string, context: ProjectsCommandContext = DEFAULT_CONTEXT) {
    return this.repository.setTaskDependency(taskId, dependsOnTaskId, context.actor);
  }

  removeTaskDependency(taskId: string, dependsOnTaskId: string, _context: ProjectsCommandContext = DEFAULT_CONTEXT) {
    return this.repository.removeTaskDependency(taskId, dependsOnTaskId);
  }

  createDependency(input: CreateDependencyInput, context: ProjectsCommandContext = DEFAULT_CONTEXT) {
    return WorkTaskDependencyModel.create({ ...input, actor: input.actor ?? context.actor });
  }

  removeDependency(input: RemoveDependencyInput, _context: ProjectsCommandContext = DEFAULT_CONTEXT) {
    return WorkTaskDependencyModel.remove(input);
  }

  listDependencies(taskId: string, opts: { includeArchived?: boolean } = {}) {
    return WorkTaskDependencyModel.listDependencies(itemId(taskId, 'task_id'), opts);
  }

  listDependents(taskId: string, opts: { includeArchived?: boolean } = {}) {
    return WorkTaskDependencyModel.listDependents(itemId(taskId, 'task_id'), opts);
  }

  /**
   * Bulk readiness query: candidate tasks in a project (optionally scoped to
   * one epic) split into ready (no unresolved dependency holds) and blocked
   * (with the exact holds keeping each one back). Candidates
   * exclude archived and closed (done/cancelled/parked) tasks the same way
   * every other Projects list query does — closed work is never "ready".
   */
  async readyTasks(input: ReadyTasksInput): Promise<ReadyTasksResult> {
    const projectId = itemId(input.projectId, 'project_id');
    const candidates = await this.repository.listTasks({
      projectId, epicId: input.epicId, includeDone: false, limit: input.limit ?? 200,
    });
    const holds = await WorkTaskDependencyModel.listUnresolvedForTasks(candidates.map(task => task.id));
    const holdsByTask = new Map<string, TaskDependencyHold[]>();
    for (const hold of holds) {
      const existing = holdsByTask.get(hold.taskId);
      if (existing) existing.push(hold);
      else holdsByTask.set(hold.taskId, [hold]);
    }
    const ready: WorkTaskRecord[] = [];
    const blocked: { task: WorkTaskRecord; holds: TaskDependencyHold[] }[] = [];
    for (const task of candidates) {
      const taskHolds = holdsByTask.get(task.id);
      if (taskHolds?.length) blocked.push({ task, holds: taskHolds });
      else ready.push(task);
    }
    // Follow unresolved edges outside the initial project/epic/page too, so
    // the caller sees which open prerequisites can be worked first. Read-only:
    // nothing here moves or reassigns a prerequisite.
    const seen = new Set(candidates.map(task => task.id));
    const runnablePrerequisites: WorkTaskRecord[] = [];
    let frontier = [...new Set(holds.filter(hold => hold.policy === 'pending').map(hold => hold.dependsOnTaskId))];
    while (frontier.length) {
      const ids = frontier.filter(id => !seen.has(id));
      if (!ids.length) break;
      ids.forEach(id => seen.add(id));
      const tasks = (await Promise.all(ids.map(id => this.repository.getTask(id))))
        .filter((task): task is WorkTaskRecord => !!task && !task.archived);
      const nextHolds = await WorkTaskDependencyModel.listUnresolvedForTasks(tasks.map(task => task.id));
      const held = new Set(nextHolds.map(hold => hold.taskId));
      for (const task of tasks) {
        if (!held.has(task.id) && !['done', 'cancelled', 'parked'].includes(task.status)) {
          runnablePrerequisites.push(task);
        }
      }
      frontier = [...new Set(nextHolds.filter(hold => hold.policy === 'pending').map(hold => hold.dependsOnTaskId))];
    }
    return { ready, blocked, runnablePrerequisites };
  }

  async reorder(updates: ReorderProjectItem[], context: ProjectsCommandContext): Promise<void> {
    for (const update of updates) {
      if (update.kind === 'epic') {
        await this.updateEpic(update.id, { position: update.position, status: update.status }, context);
      } else {
        await this.updateTask(update.id, {
          position: update.position, status: update.status, epic_id: update.epic_id, actor: context.actor,
        }, context);
      }
    }
  }
}

let service: ProjectsApplicationService | undefined;
export function getProjectsApplicationService(): ProjectsApplicationService {
  service ??= new ProjectsApplicationService();
  return service;
}
