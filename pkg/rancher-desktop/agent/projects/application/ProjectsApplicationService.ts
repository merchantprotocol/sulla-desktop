import { getProjectsApiClient } from './ProjectsApiClient';

import type { ProjectsRepository } from './ProjectsRepository';
import type { ArtifactReceiptModel, ArtifactReceiptRow, InsertArtifactReceiptInput } from '../../database/models/ArtifactReceiptModel';
import type { ClaimGitHubPullRequestMirrorInput, GitHubPullRequestMirrorModel } from '../../database/models/GitHubPullRequestMirrorModel';
import type { KnowledgeGraphModel, KnowledgeNodeRecord, KnowledgeSearchOptions } from '../../database/models/KnowledgeGraphModel';
import type {
  KnowledgeLinkInput, KnowledgeWorkItemKind, ListLinkedKnowledgeOptions, ListLinkedWorkOptions, WorkItemKnowledgeModel,
} from '../../database/models/WorkItemKnowledgeModel';
import type {
  AddCommentInput, ListActivityOpts, ListEpicsOpts, ListOpts, ListTasksOpts, SearchOpts,
  UpdateEpicInput, UpdateProjectInput, UpdateTaskInput, UpsertEpicInput, UpsertProjectInput, UpsertTaskInput,
  WorkActivityRecord, WorkCommentRecord, WorkEpicRecord, WorkItemKind, WorkItemsModel, WorkProjectRecord, WorkTaskRecord,
} from '../../database/models/WorkItemsModel';
import type { CreateWorkLaneInput, ListWorkLaneOpts, UpdateWorkLaneInput, WorkLaneDefinitionModel, WorkLaneScope } from '../../database/models/WorkLaneDefinitionModel';
import type { CreateProjectPipelineTemplateInput, ProjectPipelineTemplate, ProjectPipelineTemplateRecord, UpdateProjectPipelineTemplateInput, WorkProjectPipelineTemplateModel } from '../../database/models/WorkProjectPipelineTemplateModel';
import type { SaveProjectViewInput, WorkProjectViewModel } from '../../database/models/WorkProjectViewModel';
import type { CreateDependencyInput, DependencyRecord, RemoveDependencyInput, TaskDependencyHold, WorkTaskDependencyModel } from '../../database/models/WorkTaskDependencyModel';

export type ProjectsCommandSource = 'tool' | 'ipc' | 'heartbeat' | 'routine' | 'system';
export interface ProjectsCommandContext { actor: string; source: ProjectsCommandSource }
export interface ReorderProjectItem { kind: 'epic' | 'task'; id: string; position?: number; status?: string; epic_id?: string }
export interface ReadyTasksInput { projectId: string; epicId?: string; limit?: number }
export interface ReadyTasksResult { ready: WorkTaskRecord[]; runnablePrerequisites: WorkTaskRecord[]; blocked: { task: WorkTaskRecord; holds: TaskDependencyHold[] }[] }
export interface ListKnowledgeForItemInput extends ListLinkedKnowledgeOptions { itemKind: KnowledgeWorkItemKind; itemId: string }
export interface ActiveTaskAgent { task_id: string; agent_id: string; owner_subject: string; external_ref: string; expires_at: string }
export interface ArtifactEvidenceReference { receipt: ArtifactReceiptRow; evidence: null; evidenceReference: { kind: unknown; ref: unknown; url: unknown } }
export interface ProjectsDomainEvent { id: string; task_id: string | null; event_type: string; payload: Record<string, unknown>; occurred_at: string; attempts: number; leased_until: string }

type MethodResult<Method> = Method extends (...args: never[]) => infer Result ? Result : never;

/** Typed Desktop contract. Every method is fulfilled by ProjectsApiClient. */
export class ProjectsApplicationService {
  constructor(_obsoleteRepository?: unknown) { return getProjectsApiClient() as unknown as ProjectsApplicationService }
  declare ready:                           () => Promise<void>;
  declare getProject:                      (id: string) => Promise<WorkProjectRecord | null>;
  declare getProjectBySlug:                (slug: string) => Promise<WorkProjectRecord | null>;
  declare listProjects:                    (opts?: ListOpts) => Promise<WorkProjectRecord[]>;
  declare getEpic:                         (id: string) => Promise<WorkEpicRecord | null>;
  declare listEpics:                       (opts?: ListEpicsOpts) => Promise<WorkEpicRecord[]>;
  declare getTask:                         (id: string) => Promise<WorkTaskRecord | null>;
  declare listTasks:                       (opts?: ListTasksOpts) => Promise<WorkTaskRecord[]>;
  declare listComments:                    (taskId: string) => Promise<WorkCommentRecord[]>;
  declare listRecentActivity:              (opts?: ListActivityOpts) => Promise<WorkActivityRecord[]>;
  declare search:                          (opts: SearchOpts) => MethodResult<ProjectsRepository['search']>;
  declare listTaskDependencies:            (projectId: string) => MethodResult<ProjectsRepository['listTaskDependencies']>;
  declare resolveEffectiveLanes:           (projectId: string, includeArchived?: boolean) => MethodResult<typeof WorkLaneDefinitionModel.resolveEffective>;
  declare laneRuntimeCapability:           (projectId?: string) => MethodResult<typeof WorkLaneDefinitionModel.runtimeCapability>;
  declare listViews:                       (projectId?: string | null) => MethodResult<typeof WorkProjectViewModel.list>;
  declare resolveView:                     (projectId?: string | null) => MethodResult<typeof WorkProjectViewModel.resolve>;
  declare saveView:                        (input: SaveProjectViewInput, context?: ProjectsCommandContext) => MethodResult<typeof WorkProjectViewModel.save>;
  declare listLanes:                       (opts?: ListWorkLaneOpts) => MethodResult<typeof WorkLaneDefinitionModel.list>;
  declare createLane:                      (input: CreateWorkLaneInput, context?: ProjectsCommandContext) => MethodResult<typeof WorkLaneDefinitionModel.create>;
  declare updateLane:                      (id: string, changes: UpdateWorkLaneInput, context?: ProjectsCommandContext) => MethodResult<typeof WorkLaneDefinitionModel.update>;
  declare archiveLane:                     (id: string, destination?: string, context?: ProjectsCommandContext) => MethodResult<typeof WorkLaneDefinitionModel.archive>;
  declare previewArchiveLane:              (id: string) => MethodResult<typeof WorkLaneDefinitionModel.previewArchive>;
  declare restoreLane:                     (id: string, context?: ProjectsCommandContext) => MethodResult<typeof WorkLaneDefinitionModel.restore>;
  declare reorderLanes:                    (scope: WorkLaneScope, keys: string[], projectId?: string, context?: ProjectsCommandContext) => MethodResult<typeof WorkLaneDefinitionModel.reorder>;
  declare resetLaneOverride:               (projectId: string, laneKey: string, context?: ProjectsCommandContext) => MethodResult<typeof WorkLaneDefinitionModel.resetProjectOverride>;
  declare countKnowledgeForItems:          (kind: KnowledgeWorkItemKind, ids: string[]) => MethodResult<typeof WorkItemKnowledgeModel.countForItems>;
  declare listKnowledgeForItem:            (input: ListKnowledgeForItemInput) => MethodResult<typeof WorkItemKnowledgeModel.listForItem>;
  declare linkKnowledge:                   (input: KnowledgeLinkInput, context?: ProjectsCommandContext) => MethodResult<typeof WorkItemKnowledgeModel.link>;
  declare unlinkKnowledge:                 (input: KnowledgeLinkInput, context?: ProjectsCommandContext) => MethodResult<typeof WorkItemKnowledgeModel.unlink>;
  declare listWorkForKnowledge:            (id: string, opts?: ListLinkedWorkOptions) => MethodResult<typeof WorkItemKnowledgeModel.listForNode>;
  declare searchKnowledgeNodes:            (input?: KnowledgeSearchOptions) => MethodResult<typeof KnowledgeGraphModel.searchNodes>;
  declare bootstrapTenant:                 (context?: ProjectsCommandContext) => MethodResult<typeof WorkLaneDefinitionModel.seedDefaultsAndLegacyStatuses>;
  declare createProject:                   (input: UpsertProjectInput, context?: ProjectsCommandContext) => Promise<WorkProjectRecord>;
  declare listProjectPipelineTemplates:    (includeArchived?: boolean) => Promise<ProjectPipelineTemplateRecord[]>;
  declare getProjectPipelineTemplate:      (id: string) => Promise<ProjectPipelineTemplate | null>;
  declare createProjectPipelineTemplate:   (input: CreateProjectPipelineTemplateInput, context?: ProjectsCommandContext) => Promise<ProjectPipelineTemplate>;
  declare applyProjectPipelineTemplate:    (projectId: string, templateId: string, context?: ProjectsCommandContext) => MethodResult<typeof WorkProjectPipelineTemplateModel.applyToProject>;
  declare archiveProjectPipelineTemplate:  (id: string, context?: ProjectsCommandContext) => Promise<ProjectPipelineTemplateRecord | null>;
  declare updateProjectPipelineTemplate:   (id: string, input: UpdateProjectPipelineTemplateInput, context?: ProjectsCommandContext) => Promise<ProjectPipelineTemplate>;
  declare updateProject:                   (id: string, input: UpdateProjectInput, context?: ProjectsCommandContext) => Promise<WorkProjectRecord | null>;
  declare createEpic:                      (input: UpsertEpicInput, context?: ProjectsCommandContext) => Promise<WorkEpicRecord>;
  declare updateEpic:                      (id: string, input: UpdateEpicInput, context?: ProjectsCommandContext) => Promise<WorkEpicRecord | null>;
  declare createTask:                      (input: UpsertTaskInput, context?: ProjectsCommandContext) => Promise<WorkTaskRecord>;
  declare updateTask:                      (id: string, input: UpdateTaskInput, context?: ProjectsCommandContext) => Promise<WorkTaskRecord | null>;
  declare archive:                         (kind: WorkItemKind, id: string, context?: ProjectsCommandContext) => Promise<boolean>;
  declare addComment:                      (input: AddCommentInput, context?: ProjectsCommandContext) => Promise<WorkCommentRecord>;
  declare setTaskDependency:               (taskId: string, dependsOn: string, context?: ProjectsCommandContext) => MethodResult<ProjectsRepository['setTaskDependency']>;
  declare removeTaskDependency:            (taskId: string, dependsOn: string, context?: ProjectsCommandContext) => Promise<boolean>;
  declare createDependency:                (input: CreateDependencyInput, context?: ProjectsCommandContext) => Promise<DependencyRecord>;
  declare removeDependency:                (input: RemoveDependencyInput, context?: ProjectsCommandContext) => Promise<boolean>;
  declare listDependencies:                (taskId: string, opts?: { includeArchived?: boolean }) => MethodResult<typeof WorkTaskDependencyModel.listDependencies>;
  declare listDependents:                  (taskId: string, opts?: { includeArchived?: boolean }) => MethodResult<typeof WorkTaskDependencyModel.listDependents>;
  declare readyTasks:                      (input: ReadyTasksInput) => Promise<ReadyTasksResult>;
  declare reorder:                         (updates: ReorderProjectItem[], context?: ProjectsCommandContext) => Promise<void>;
  declare listTasksAwaitingHumanReply:     (opts: { responder: string; sinceDays?: number; limit?: number }) => MethodResult<typeof WorkItemsModel.listTasksAwaitingHumanReply>;
  declare archiveCompletedTasks:           (hours: number) => MethodResult<typeof WorkItemsModel.archiveCompletedTasks>;
  declare latestCommentAtByTask:           (taskIds: string[]) => Promise<Record<string, string>>;
  declare listActiveTaskAgents:            (taskIds?: string[]) => Promise<ActiveTaskAgent[]>;
  declare claimDomainEvents:               (input: { consumerId: string; eventTypes?: string[]; limit?: number; leaseSeconds?: number }) => Promise<ProjectsDomainEvent[]>;
  declare completeDomainEvents:            (ids: string[], consumerId: string) => Promise<number>;
  declare failDomainEvents:                (ids: string[], consumerId: string, message: string) => Promise<number>;
  declare insertArtifactReceipt:           (input: InsertArtifactReceiptInput, context?: ProjectsCommandContext) => MethodResult<typeof ArtifactReceiptModel.insertIfAbsent>;
  declare listArtifactReceiptsByTask:      (taskId: string) => MethodResult<typeof ArtifactReceiptModel.listByTask>;
  declare findArtifactReceiptsByHash:      (hash: string) => MethodResult<typeof ArtifactReceiptModel.findByHash>;
  declare findArtifactReceiptByComment:    (commentId: string) => MethodResult<typeof ArtifactReceiptModel.findByComment>;
  declare loadArtifactEvidenceReference:   (commentId: string) => Promise<ArtifactEvidenceReference | null>;
  declare attachArtifactReceiptComment:    (id: string, commentId: string) => Promise<void>;
  declare claimGitHubPullRequestMirror:    (input: ClaimGitHubPullRequestMirrorInput) => MethodResult<typeof GitHubPullRequestMirrorModel.claim>;
  declare listGitHubPullRequestMirrors:    (projectId: string, epicId: string) => MethodResult<typeof GitHubPullRequestMirrorModel.listForScope>;
  declare recordGitHubPullRequestSnapshot: (input: Parameters<typeof GitHubPullRequestMirrorModel.recordSnapshot>[0]) => MethodResult<typeof GitHubPullRequestMirrorModel.recordSnapshot>;
  declare recordGitHubPullRequestError:    (owner: string, repo: string, pull: number, message: string) => MethodResult<typeof GitHubPullRequestMirrorModel.recordError>;
  declare upsertKnowledgeProjection:       (input: KnowledgeNodeRecord) => Promise<unknown>;
  declare mergeKnowledgeProjection:        (sourceId: string, targetId: string) => Promise<boolean>;
}

let service: ProjectsApplicationService | undefined;
export function getProjectsApplicationService(): ProjectsApplicationService {
  service ??= getProjectsApiClient();
  return service;
}
