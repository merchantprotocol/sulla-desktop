import { KnowledgeGraphModel } from '../../database/models/KnowledgeGraphModel';
import { LifecycleCapabilityModel } from '../../database/models/LifecycleCapabilityModel';
import { WorkConveyorMetricsModel } from '../../database/models/WorkConveyorMetricsModel';
import { WorkItemKnowledgeModel } from '../../database/models/WorkItemKnowledgeModel';
import { WorkLaneDefinitionModel } from '../../database/models/WorkLaneDefinitionModel';
import { WorkLaneWorkflowBindingModel } from '../../database/models/WorkLaneWorkflowBindingModel';
import { WorkProjectViewModel } from '../../database/models/WorkProjectViewModel';
import { WorkTaskDependencyModel } from '../../database/models/WorkTaskDependencyModel';
import { WorkTaskDispatchModel } from '../../database/models/WorkTaskDispatchModel';
import { WorkTaskWaitModel } from '../../database/models/WorkTaskWaitModel';
import { ArtifactCustodyPolicy } from '../../services/ArtifactCustodyPolicy';
import { evaluateClaim, resolveWipLimits } from '../../services/ProjectAutomationWipLimits';
import { ProjectItemId, LaneKey, TaskLifecyclePolicy } from '../domain/ProjectsDomain';
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
import type { CreateDependencyInput, RemoveDependencyInput } from '../../database/models/WorkTaskDependencyModel';
import type { WorkTaskWaitStatus, RegisterWaitInput } from '../../database/models/WorkTaskWaitModel';
import type { ProjectsCommandContext } from '../domain/ProjectsDomain';

export interface ReorderProjectItem {
  kind:      'epic' | 'task';
  id:        string;
  position?: number;
  status?:   string;
  epic_id?:  string;
}

const DEFAULT_CONTEXT: ProjectsCommandContext = { actor: 'sulla', source: 'system' };

/**
 * The sole application boundary for Projects. Tools, IPC and autonomous
 * routines submit commands here so authorization and lifecycle policy cannot
 * diverge between adapters.
 */
export class ProjectsApplicationService {
  constructor(private readonly repository: ProjectsRepository = new PostgresProjectsRepository()) {}

  ready() { return this.repository.verifySchema() }
  getProject(id: string) { return this.repository.getProject(ProjectItemId.from(id).value) }
  getProjectBySlug(slug: string) { return this.repository.getProjectBySlug(slug) }
  listProjects(opts: ListOpts = {}) { return this.repository.listProjects(opts) }
  getEpic(id: string) { return this.repository.getEpic(ProjectItemId.from(id).value) }
  listEpics(opts: ListEpicsOpts = {}) { return this.repository.listEpics(opts) }
  getTask(id: string) { return this.repository.getTask(ProjectItemId.from(id).value) }
  listTasks(opts: ListOpts = {}) { return this.repository.listTasks(opts) }
  listComments(taskId: string) { return this.repository.listComments(ProjectItemId.from(taskId, 'task_id').value) }
  listRecentActivity(opts: ListActivityOpts = {}) { return this.repository.listRecentActivity(opts) }
  search(opts: SearchOpts) { return this.repository.search(opts) }
  listTaskDependencies(projectId: string) {
    return this.repository.listTaskDependencies(ProjectItemId.from(projectId, 'project_id').value);
  }

  resolveEffectiveLanes(projectId: string, includeArchived = false) {
    return WorkLaneDefinitionModel.resolveEffective(ProjectItemId.from(projectId, 'project_id').value, includeArchived);
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

  createProject(input: UpsertProjectInput, _context: ProjectsCommandContext = DEFAULT_CONTEXT) {
    return this.repository.createProject(input);
  }

  updateProject(id: string, changes: UpdateProjectInput, _context: ProjectsCommandContext = DEFAULT_CONTEXT) {
    return this.repository.updateProject(ProjectItemId.from(id).value, changes);
  }

  createEpic(input: UpsertEpicInput, _context: ProjectsCommandContext = DEFAULT_CONTEXT) {
    return this.repository.createEpic(input);
  }

  updateEpic(id: string, changes: UpdateEpicInput, _context: ProjectsCommandContext = DEFAULT_CONTEXT) {
    return this.repository.updateEpic(ProjectItemId.from(id).value, changes);
  }

  createTask(input: UpsertTaskInput, context: ProjectsCommandContext = DEFAULT_CONTEXT) {
    return this.repository.createTask({ ...input, actor: input.actor ?? context.actor });
  }

  async updateTask(
    id: string,
    changes: UpdateTaskInput,
    context: ProjectsCommandContext = DEFAULT_CONTEXT,
  ): Promise<WorkTaskRecord | null> {
    const taskId = ProjectItemId.from(id).value;
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
      const sourceRole = await WorkLaneDefinitionModel.semanticRoleForStatus(current.project_id, current.status);
      const destinationLane = await WorkLaneDefinitionModel.validateTaskStatus(destinationProjectId, changes.status);
      const role = destinationLane?.semantic_role ?? 'manual';
      if (role === 'review') await ArtifactCustodyPolicy.assertForTransition('in_review', changes.custody);
      if (role === 'terminal') await ArtifactCustodyPolicy.assertForTransition('done', changes.custody);
      TaskLifecyclePolicy.assertTransition({
        actor,
        destinationEpicProven: changes.epic_id !== undefined,
        from:                  {
          taskId:       ProjectItemId.from(current.id),
          projectId:    ProjectItemId.from(current.project_id),
          lane:         LaneKey.from(current.status),
          semanticRole: sourceRole,
          assignee:     current.assignee,
          labels:       current.labels ?? [],
        },
        to: {
          taskId:       ProjectItemId.from(current.id),
          projectId:    ProjectItemId.from(destinationProjectId),
          lane:         LaneKey.from(changes.status),
          semanticRole: role,
          assignee:     changes.assignee === undefined ? current.assignee : changes.assignee,
          labels:       changes.labels ?? current.labels ?? [],
        },
      });
    }
    return this.repository.updateTask(taskId, { ...changes, actor });
  }

  archive(kind: WorkItemKind, id: string, _context: ProjectsCommandContext = DEFAULT_CONTEXT) {
    return this.repository.archive(kind, ProjectItemId.from(id).value);
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
    return WorkTaskDependencyModel.listDependencies(ProjectItemId.from(taskId, 'task_id').value, opts);
  }

  listDependents(taskId: string, opts: { includeArchived?: boolean } = {}) {
    return WorkTaskDependencyModel.listDependents(ProjectItemId.from(taskId, 'task_id').value, opts);
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
