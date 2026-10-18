import fs from 'node:fs/promises';
import path from 'node:path';

import paths from '@pkg/utils/paths';

import type { ProjectsApplicationService, ProjectsCommandContext } from './ProjectsApplicationService';

interface RpcResponse<T> { result?: T; error?: string }

const CONTEXT_INDEX: Record<string, number> = {
  saveView:                       1,
  createLane:                     1,
  updateLane:                     2,
  archiveLane:                    2,
  restoreLane:                    1,
  reorderLanes:                   3,
  resetLaneOverride:              2,
  linkKnowledge:                  1,
  unlinkKnowledge:                1,
  createProject:                  1,
  createProjectPipelineTemplate:  1,
  applyProjectPipelineTemplate:   2,
  archiveProjectPipelineTemplate: 1,
  updateProjectPipelineTemplate:  2,
  updateProject:                  2,
  createEpic:                     1,
  updateEpic:                     2,
  createTask:                     1,
  updateTask:                     2,
  archive:                        2,
  addComment:                     1,
  setTaskDependency:              2,
  removeTaskDependency:           2,
  createDependency:               1,
  removeDependency:               1,
  reorder:                        1,
  bootstrapTenant:                0,
  insertArtifactReceipt:          1,
};

const RPC_OPERATIONS = new Set([
  'ready', 'getProject', 'getProjectBySlug', 'listProjects', 'getEpic', 'listEpics', 'getTask', 'listTasks', 'listComments',
  'listRecentActivity', 'search', 'listTaskDependencies', 'resolveEffectiveLanes', 'laneRuntimeCapability', 'listViews', 'resolveView',
  'saveView', 'listLanes', 'createLane', 'updateLane', 'archiveLane', 'previewArchiveLane', 'restoreLane', 'reorderLanes',
  'resetLaneOverride', 'countKnowledgeForItems', 'listKnowledgeForItem', 'linkKnowledge', 'unlinkKnowledge', 'listWorkForKnowledge',
  'searchKnowledgeNodes', 'createProject', 'listProjectPipelineTemplates', 'getProjectPipelineTemplate', 'createProjectPipelineTemplate',
  'applyProjectPipelineTemplate', 'archiveProjectPipelineTemplate', 'updateProjectPipelineTemplate', 'updateProject', 'createEpic', 'updateEpic',
  'createTask', 'updateTask', 'archive', 'addComment', 'setTaskDependency', 'removeTaskDependency', 'createDependency', 'removeDependency',
  'listDependencies', 'listDependents', 'readyTasks', 'reorder', 'listTasksAwaitingHumanReply', 'archiveCompletedTasks', 'bootstrapTenant',
  'listActiveTaskAgents', 'insertArtifactReceipt', 'listArtifactReceiptsByTask', 'findArtifactReceiptsByHash', 'findArtifactReceiptByComment', 'loadArtifactEvidenceReference',
  'attachArtifactReceiptComment', 'claimGitHubPullRequestMirror', 'listGitHubPullRequestMirrors', 'recordGitHubPullRequestSnapshot',
  'recordGitHubPullRequestError', 'latestCommentAtByTask', 'upsertKnowledgeProjection', 'mergeKnowledgeProjection',
  'claimDomainEvents', 'completeDomainEvents', 'failDomainEvents',
]);

function stripAuthority(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripAuthority);
  if (!value || typeof value !== 'object') return value;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !['actor', 'tenant', 'tenantId', 'tenant_id'].includes(key))
    .map(([key, child]) => [key, stripAuthority(child)]));
}

export class ProjectsApiClient {
  private readonly baseUrl = (process.env.SULLA_PROJECTS_API_URL ?? 'http://127.0.0.1:30138').replace(/\/+$/, '');

  private async token(context: ProjectsCommandContext): Promise<string> {
    const human = context.source === 'ipc' && context.actor === 'human';
    const configured = (human ? process.env.SULLA_PROJECTS_HUMAN_API_TOKEN : process.env.SULLA_PROJECTS_API_TOKEN)?.trim();
    if (configured) return configured;
    const tokenPath = human
      ? process.env.SULLA_PROJECTS_HUMAN_TOKEN_FILE?.trim() || path.join(paths.appHome, 'projects-human-token')
      : process.env.SULLA_PROJECTS_LOCAL_TOKEN_FILE?.trim() || path.join(paths.appHome, 'projects-local-token');
    const stat = await fs.stat(tokenPath);
    if ((stat.mode & 0o077) !== 0) throw new Error('Projects service token file permissions are unsafe');
    const token = (await fs.readFile(tokenPath, 'utf8')).trim();
    if (!token) throw new Error('Projects service authentication is unavailable');
    return token;
  }

  async request<T>(path: string, body: unknown, context: ProjectsCommandContext = { actor: 'sulla', source: 'system' }): Promise<T> {
    const response = await fetch(`${ this.baseUrl }${ path }`, {
      method:  'POST',
      headers: {
        authorization:             `Bearer ${ await this.token(context) }`,
        'content-type':            'application/json',
        'x-sulla-projects-actor':  context.actor,
        'x-sulla-projects-source': context.source,
      },
      body:   JSON.stringify(body),
      signal: AbortSignal.timeout(Number(process.env.SULLA_PROJECTS_API_TIMEOUT_MS ?? 15_000)),
    });
    const raw = await response.text();
    let payload: RpcResponse<T>;
    try { payload = JSON.parse(raw) as RpcResponse<T> } catch { throw new Error(`Projects service returned an invalid response (${ response.status })`) }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Projects service returned an invalid response envelope');
    if (!response.ok) throw new Error(`Projects service rejected the request (${ payload.error ?? response.status })`);
    if (!Object.prototype.hasOwnProperty.call(payload, 'result')) throw new Error('Projects service response is missing its result');
    return payload.result as T;
  }

  rpc<T>(operation: string, originalArgs: unknown[]): Promise<T> {
    const contextIndex = CONTEXT_INDEX[operation];
    const context = contextIndex === undefined
      ? { actor: 'sulla', source: 'system' } as ProjectsCommandContext
      : (originalArgs[contextIndex] as ProjectsCommandContext | undefined) ?? { actor: 'sulla', source: 'system' };
    const args = contextIndex === undefined ? originalArgs : originalArgs.slice(0, contextIndex);
    return this.request<T>('/v1/rpc', { operation, args: stripAuthority(args) }, context);
  }
}

let apiClient: ProjectsApplicationService | undefined;
export function getProjectsApiClient(): ProjectsApplicationService {
  apiClient ??= new Proxy(new ProjectsApiClient(), {
    get(target, property) {
      if (property in target) return Reflect.get(target, property, target);
      if (typeof property !== 'string' || property === 'then' || !RPC_OPERATIONS.has(property)) return undefined;
      return (...args: unknown[]) => target.rpc(property, args);
    },
  }) as unknown as ProjectsApplicationService;
  return apiClient;
}
