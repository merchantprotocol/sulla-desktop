import { KnowledgeGraphModel } from '../../database/models/KnowledgeGraphModel';
import { LifecycleCapabilityModel } from '../../database/models/LifecycleCapabilityModel';
import { WorkConveyorMetricsModel } from '../../database/models/WorkConveyorMetricsModel';
import { WorkItemKnowledgeModel } from '../../database/models/WorkItemKnowledgeModel';
import { WorkLaneDefinitionModel } from '../../database/models/WorkLaneDefinitionModel';
import { WorkLaneWorkflowBindingModel } from '../../database/models/WorkLaneWorkflowBindingModel';
import { WorkProjectViewModel } from '../../database/models/WorkProjectViewModel';
import { CORE_PROJECT_PIPELINE_TEMPLATE_ID, WorkProjectPipelineTemplateModel } from '../../database/models/WorkProjectPipelineTemplateModel';
import { WorkTaskDependencyModel } from '../../database/models/WorkTaskDependencyModel';
import { WorkTaskDispatchModel } from '../../database/models/WorkTaskDispatchModel';
import { WorkTaskWaitModel } from '../../database/models/WorkTaskWaitModel';
import { ArtifactCustodyPolicy } from '../../services/ArtifactCustodyPolicy';
import { evaluateClaim, resolveWipLimits } from '../../services/ProjectAutomationWipLimits';
import { PostgresProjectsRepository } from '../infrastructure/PostgresProjectsRepository';

import type { ProjectsRepository } from './ProjectsRepository';
import type { ConveyorMetricsOptions, SemanticStage } from '../../database/models/WorkConveyorMetricsModel';
import type { KnowledgeLinkInput, KnowledgeWorkItemKind } from '../../database/models/WorkItemKnowledgeModel';
import type {
  AddCommentInput, ListActivityOpts, ListEpicsOpts, ListOpts, SearchOpts,
  UpdateEpicInput, UpdateProjectInput, UpdateTaskInput,
  UpsertEpicInput, UpsertProjectInput, UpsertTaskInput, WorkItemKind,
  WorkTaskRecord,
} from '../../database/models/WorkItemsModel';
import type { CreateWorkLaneInput, ListWorkLaneOpts, UpdateWorkLaneInput, WorkLaneScope } from '../../database/models/WorkLaneDefinitionModel';
import type { ListLaneBindingsInput, ResolveLaneBindingContextInput, SetLaneBindingInput } from '../../database/models/WorkLaneWorkflowBindingModel';
import type { SaveProjectViewInput } from '../../database/models/WorkProjectViewModel';
import type { CreateProjectPipelineTemplateInput } from '../../database/models/WorkProjectPipelineTemplateModel';
import type { CreateDependencyInput, RemoveDependencyInput } from '../../database/models/WorkTaskDependencyModel';
import type { WorkTaskWaitStatus, RegisterWaitInput } from '../../database/models/WorkTaskWaitModel';

export type ProjectsCommandSource = 'tool' | 'ipc' | 'heartbeat' | 'routine' | 'dispatcher' | 'system';

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

export interface TransitionTaskStageInput {
  taskId:              string;
  stageKey:            string;
  expectedGeneration?: number;
  custody?:            UpdateTaskInput['custody'];
}

export interface TransitionTaskRelativeInput {
  taskId:              string;
  direction:           'next' | 'previous';
  expectedGeneration?: number;
  custody?:            UpdateTaskInput['custody'];
}

export interface TaskStageTransitionResult {
  task:               WorkTaskRecord;
  fromStage:          string;
  toStage:            string;
  stagePosition:      number;
  previousGeneration: number | null;
}

const DEFAULT_CONTEXT: ProjectsCommandContext = { actor: 'sulla', source: 'system' };

function itemId(value: unknown, field = 'id'): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) throw new Error(`${ field } is required.`);
  return normalized;
}

/**
 * The sole application boundary for Projects. Tools, IPC and autonomous
 * routines submit commands here so authorization and lifecycle policy cannot
 * diverge between adapters.
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
  listTasks(opts: ListOpts = {}) { return this.repository.listTasks(opts) }
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

  listLaneBindings(input: ListLaneBindingsInput = {}) { return WorkLaneWorkflowBindingModel.list(input) }
  setLaneBinding(input: SetLaneBindingInput, context: ProjectsCommandContext = DEFAULT_CONTEXT) {
    return WorkLaneWorkflowBindingModel.set({ ...input, actor: input.actor ?? context.actor });
  }

  removeLaneBinding(id: string, context: ProjectsCommandContext = DEFAULT_CONTEXT) {
    return WorkLaneWorkflowBindingModel.remove(id, context.actor);
  }

  resolveLaneBinding(taskId: string, laneKey: string, profileId = 'default') {
    return WorkLaneWorkflowBindingModel.resolve(taskId, laneKey, profileId);
  }

  resolveLaneBindingContext(input: ResolveLaneBindingContextInput) {
    return WorkLaneWorkflowBindingModel.resolveForContext(input);
  }

  listCompatibleLaneWorkflows(projectId: string, laneKey: string) {
    return WorkLaneWorkflowBindingModel.listCompatibleWorkflows(projectId, laneKey);
  }

  listLaneEntries(taskId: string) { return WorkLaneWorkflowBindingModel.listLaneEntries(taskId) }
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

  listWaits(opts: { taskId?: string; status?: WorkTaskWaitStatus; limit?: number } = {}) {
    return WorkTaskWaitModel.list(opts);
  }

  cancelWait(id: string, reason: string) { return WorkTaskWaitModel.cancel(id, reason) }
  explainTaskClaimability(taskId: string) { return WorkTaskDependencyModel.explainClaimability(taskId) }
  conveyorHealth(opts: ConveyorMetricsOptions) { return WorkConveyorMetricsModel.snapshot(opts) }
  async automationStatus() {
    const [limits, counts] = await Promise.all([resolveWipLimits(), WorkTaskDispatchModel.countByRole()]);
    return { limits, counts, decision: evaluateClaim('execution', counts, limits), at: new Date().toISOString() };
  }

  conveyorOldest(opts: { projectId?: string | null; stage: SemanticStage }) {
    return WorkConveyorMetricsModel.oldestItems({ projectId: opts.projectId ?? null, drillLimit: 20 }, opts.stage);
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
    const actor = changes.actor ?? context.actor;

    if (changes.status !== undefined || changes.assignee !== undefined) {
      await LifecycleCapabilityModel.assertActorCanManageTask(current.status, current.labels, actor);
      const destinationStatus = changes.status ?? current.status;
      const destinationLabels = changes.labels ?? current.labels;
      await LifecycleCapabilityModel.assertActorCanManageTask(destinationStatus, destinationLabels, actor);
    }

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
      if (role === 'terminal' && (changes.assignee === undefined ? current.assignee : changes.assignee) === 'dispatcher') {
        throw new Error('Terminal tasks cannot remain assigned to dispatcher.');
      }
    }
    return this.repository.updateTask(taskId, { ...changes, actor });
  }

  async transitionTaskStage(
    input: TransitionTaskStageInput,
    context: ProjectsCommandContext = DEFAULT_CONTEXT,
  ): Promise<TaskStageTransitionResult> {
    const taskId = itemId(input.taskId, 'task_id');
    const stageKey = itemId(input.stageKey, 'stage_key');
    const current = await this.repository.getTask(taskId);
    if (!current) throw new Error(`Task not found: ${ taskId }`);
    const previousGeneration = await this.assertCurrentStageGeneration(
      taskId, current.status, input.expectedGeneration,
    );
    const stages = await this.resolveEffectiveLanes(current.project_id);
    const targetIndex = stages.findIndex(stage => stage.lane_key === stageKey && stage.enabled && !stage.archived);
    if (targetIndex < 0) throw new Error(`Stage ${ stageKey } is not active in project ${ current.project_id }.`);
    if (stageKey === current.status) throw new Error(`Task ${ taskId } is already in stage ${ stageKey }.`);
    const updated = await this.updateTask(taskId, {
      status: stageKey, actor: context.actor, custody: input.custody,
    }, context);
    if (!updated) throw new Error(`Task disappeared during stage transition: ${ taskId }`);
    return { task: updated, fromStage: current.status, toStage: stageKey, stagePosition: targetIndex, previousGeneration };
  }

  async transitionTaskRelative(
    input: TransitionTaskRelativeInput,
    context: ProjectsCommandContext = DEFAULT_CONTEXT,
  ): Promise<TaskStageTransitionResult> {
    const taskId = itemId(input.taskId, 'task_id');
    const current = await this.repository.getTask(taskId);
    if (!current) throw new Error(`Task not found: ${ taskId }`);
    const stages = (await this.resolveEffectiveLanes(current.project_id))
      .filter(stage => stage.enabled && !stage.archived);
    const currentIndex = stages.findIndex(stage => stage.lane_key === current.status);
    if (currentIndex < 0) {
      throw new Error(`Current stage ${ current.status } is not active in project ${ current.project_id }.`);
    }
    const targetIndex = currentIndex + (input.direction === 'next' ? 1 : -1);
    const target = stages[targetIndex];
    if (!target) throw new Error(`Task ${ taskId } has no ${ input.direction } configured stage.`);
    return this.transitionTaskStage({
      taskId,
      stageKey:            target.lane_key,
      expectedGeneration: input.expectedGeneration,
      custody:            input.custody,
    }, context);
  }

  private async assertCurrentStageGeneration(
    taskId: string,
    currentStage: string,
    expectedGeneration?: number,
  ): Promise<number | null> {
    const latest = (await WorkLaneWorkflowBindingModel.listLaneEntries(taskId))[0] ?? null;
    if (expectedGeneration === undefined) return latest?.generation ?? null;
    if (!Number.isInteger(expectedGeneration) || expectedGeneration < 1) {
      throw new Error('expected_generation must be a positive integer.');
    }
    if (!latest || latest.generation !== expectedGeneration || latest.lane_key !== currentStage) {
      throw new Error(
        `Stale stage generation for task ${ taskId }: expected ${ expectedGeneration } in ${ currentStage }, ` +
        `current is ${ latest?.generation ?? 'none' } in ${ latest?.lane_key ?? currentStage }.`,
      );
    }
    return latest.generation;
  }

  archive(kind: WorkItemKind, id: string, _context: ProjectsCommandContext = DEFAULT_CONTEXT) {
    return this.repository.archive(kind, itemId(id));
  }

  addComment(input: AddCommentInput, _context: ProjectsCommandContext = DEFAULT_CONTEXT) {
    return this.repository.addComment(input);
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

  async registerWait(input: RegisterWaitInput, context: ProjectsCommandContext = DEFAULT_CONTEXT) {
    const registration = await WorkTaskWaitModel.register(input);
    if (registration.created) {
      await this.addComment({
        task_id: input.taskId,
        author:  context.actor,
        body:    `External wait registered: ${ input.waitKind } (${ input.targetKey }). Unchanged checks are owned by the durable monitor and will not add task comments.`,
      }, context);
    }
    return registration;
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
