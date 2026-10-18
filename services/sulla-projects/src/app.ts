import express from 'express';

import { getProjectsDatabase } from './database.js';
import { getProjectsApplicationService } from './domain/ProjectsApplicationService.js';
import { authenticateProjectsRequest, type ProjectsIdentity } from './auth.js';
import { claimTasks, recoverExpiredClaims, releaseClaims, renewClaims } from './claims.js';

import type { ProjectsConfig } from './config.js';

type AuthenticatedRequest = express.Request & { projectsIdentity?: ProjectsIdentity };
const LOCAL_SOURCES = new Set<ProjectsIdentity['source']>(['tool', 'ipc', 'heartbeat', 'routine', 'system']);

interface OperationRule { minArgs: number; maxArgs: number; contextIndex?: number }
const rule = (minArgs: number, maxArgs = minArgs, contextIndex?: number): OperationRule => ({ minArgs, maxArgs, contextIndex });
const OPERATION_RULES: Record<string, OperationRule> = {
  ready: rule(0), getProject: rule(1), getProjectBySlug: rule(1), listProjects: rule(0, 1), getEpic: rule(1),
  listEpics: rule(0, 1), getTask: rule(1), listTasks: rule(0, 1), listComments: rule(1), listRecentActivity: rule(0, 1),
  search: rule(1), listTaskDependencies: rule(1), resolveEffectiveLanes: rule(1, 2), laneRuntimeCapability: rule(0, 1),
  listViews: rule(0, 1), resolveView: rule(0, 1), saveView: rule(1, 1, 1), listLanes: rule(0, 1), createLane: rule(1, 1, 1),
  updateLane: rule(2, 2, 2), archiveLane: rule(1, 2, 2), previewArchiveLane: rule(1), restoreLane: rule(1, 1, 1),
  reorderLanes: rule(2, 3, 3), resetLaneOverride: rule(2, 2, 2), countKnowledgeForItems: rule(2), listKnowledgeForItem: rule(1),
  linkKnowledge: rule(1, 1, 1), unlinkKnowledge: rule(1, 1, 1), listWorkForKnowledge: rule(1, 2), searchKnowledgeNodes: rule(0, 1),
  createProject: rule(1, 1, 1), listProjectPipelineTemplates: rule(0, 1), getProjectPipelineTemplate: rule(1),
  createProjectPipelineTemplate: rule(1, 1, 1), applyProjectPipelineTemplate: rule(2, 2, 2),
  archiveProjectPipelineTemplate: rule(1, 1, 1), updateProjectPipelineTemplate: rule(2, 2, 2), updateProject: rule(2, 2, 2),
  createEpic: rule(1, 1, 1), updateEpic: rule(2, 2, 2), createTask: rule(1, 1, 1), updateTask: rule(2, 2, 2),
  archive: rule(2, 2, 2), addComment: rule(1, 1, 1), setTaskDependency: rule(2, 2, 2), removeTaskDependency: rule(2, 2, 2),
  createDependency: rule(1, 1, 1), removeDependency: rule(1, 1, 1), listDependencies: rule(1, 2), listDependents: rule(1, 2),
  readyTasks: rule(1), reorder: rule(1, 1, 1), listTasksAwaitingHumanReply: rule(0, 1), archiveCompletedTasks: rule(1),
  upsertKnowledgeProjection: rule(1), mergeKnowledgeProjection: rule(2), bootstrapTenant: rule(0, 0, 0),
  listActiveTaskAgents: rule(0, 1), insertArtifactReceipt: rule(1, 1, 1), listArtifactReceiptsByTask: rule(1), findArtifactReceiptsByHash: rule(1),
  claimDomainEvents: rule(1), completeDomainEvents: rule(2), failDomainEvents: rule(3),
  findArtifactReceiptByComment: rule(1), loadArtifactEvidenceReference: rule(1), attachArtifactReceiptComment: rule(2),
  claimGitHubPullRequestMirror: rule(1), listGitHubPullRequestMirrors: rule(2), recordGitHubPullRequestSnapshot: rule(1),
  recordGitHubPullRequestError: rule(4), latestCommentAtByTask: rule(1),
};
const VIEWER_OPERATIONS = new Set(['ready','getProject','getProjectBySlug','listProjects','getEpic','listEpics','getTask','listTasks',
  'listComments','listRecentActivity','search','listTaskDependencies','resolveEffectiveLanes','laneRuntimeCapability','listViews','resolveView',
  'listLanes','previewArchiveLane','countKnowledgeForItems','listKnowledgeForItem','listWorkForKnowledge','searchKnowledgeNodes',
  'listProjectPipelineTemplates','getProjectPipelineTemplate','listDependencies','listDependents','readyTasks','listTasksAwaitingHumanReply',
  'listActiveTaskAgents','listArtifactReceiptsByTask','findArtifactReceiptsByHash','findArtifactReceiptByComment','loadArtifactEvidenceReference',
  'listGitHubPullRequestMirrors','latestCommentAtByTask']);
const ADMIN_OPERATIONS = new Set(['bootstrapTenant']);

function containsAuthorityField(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(containsAuthorityField);
  return Object.entries(value as Record<string, unknown>).some(([key, child]) =>
    ['actor', 'tenant', 'tenantId', 'tenant_id'].includes(key) || containsAuthorityField(child));
}

function stringRecord(value: unknown, field: string): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Object.assign(new Error(field), { status: 400, publicCode: 'invalid_arguments' });
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 100 || entries.some(([key, child]) => !key.trim() || typeof child !== 'string' || !child.trim())) {
    throw Object.assign(new Error(field), { status: 400, publicCode: 'invalid_arguments' });
  }
  if (entries.some(([key]) => ['__proto__', 'prototype', 'constructor'].includes(key))) {
    throw Object.assign(new Error(field), { status: 400, publicCode: 'invalid_arguments' });
  }
  return Object.assign(Object.create(null), Object.fromEntries(entries)) as Record<string, string>;
}

function leases(value: unknown): Array<{ taskId: string; token: string }> {
  if (!Array.isArray(value) || value.length > 100 || value.some(item => !item || typeof item.taskId !== 'string' || typeof item.token !== 'string')) {
    throw Object.assign(new Error('leases'), { status: 400, publicCode: 'invalid_arguments' });
  }
  return value;
}

export function createApp(config: ProjectsConfig): express.Express {
  const app = express();
  const activeTenants = new Set<string>([config.tenantId]);
  const tenantBootstraps = new Map<string, Promise<void>>();
  let sweepingExpiredClaims = false;
  const sweepExpiredClaims = async(): Promise<void> => {
    if (sweepingExpiredClaims) return;
    sweepingExpiredClaims = true;
    const database = getProjectsDatabase();
    try {
      const registered = await database.withTenant(config.tenantId, () =>
        database.query<{ tenant_id: string }>('SELECT tenant_id FROM projects_tenant_registry ORDER BY tenant_id'));
      registered.forEach(row => activeTenants.add(row.tenant_id));
      for (const tenantId of activeTenants) {
        await database.withTenant(tenantId, () =>
          database.transaction(client => recoverExpiredClaims(client, tenantId)));
      }
    } finally {
      sweepingExpiredClaims = false;
    }
  };
  const ensureTenant = (tenantId: string): Promise<void> => {
    const pending = tenantBootstraps.get(tenantId);
    if (pending) return pending;
    const database = getProjectsDatabase();
    const created = database.withTenant(tenantId, async() => {
      await database.transaction(async() => {
        await database.query(`INSERT INTO projects_tenant_registry(tenant_id) VALUES($1)
          ON CONFLICT(tenant_id) DO UPDATE SET last_seen_at=now()`, [tenantId]);
        await getProjectsApplicationService().bootstrapTenant({ actor: 'projects-service', source: 'system' });
      });
      activeTenants.add(tenantId);
    }).catch((error) => {
      tenantBootstraps.delete(tenantId);
      throw error;
    });
    tenantBootstraps.set(tenantId, created);
    return created;
  };
  void sweepExpiredClaims().catch(error => console.error('[SullaProjects] initial claim recovery failed', error));
  const claimRecoveryTimer = setInterval(() => {
    void sweepExpiredClaims().catch(error => console.error('[SullaProjects] claim recovery failed', error));
  }, 60 * 1000);
  claimRecoveryTimer.unref();
  if (config.autoArchiveHours && config.autoArchiveHours > 0) {
    const timer = setInterval(() => {
      for (const tenantId of activeTenants) {
        void getProjectsDatabase().withTenant(tenantId, () =>
          getProjectsDatabase().transaction(() =>
            getProjectsApplicationService().archiveCompletedTasks(config.autoArchiveHours!))).catch(error =>
          console.error('[SullaProjects] autoarchive failed', { tenantId, error }));
      }
    }, 15 * 60 * 1000);
    timer.unref();
  }
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.get('/healthz', (_request, response) => response.json({ ok: true, service: 'sulla-projects' }));
  app.use('/v1', async(request: AuthenticatedRequest, _response, next) => {
    try {
      request.projectsIdentity = authenticateProjectsRequest({
        authorization: request.header('authorization'), localToken: config.localToken, humanToken: config.humanToken, mode: config.mode,
        jwtSecret: config.jwtSecret, jwtPublicKey: config.jwtPublicKey, jwtIssuer: config.jwtIssuer,
        jwtAudience: config.jwtAudience, localSubject: config.userId, localTenant: config.tenantId,
        localActor: config.mode === 'desktop' ? request.header('x-sulla-projects-actor') : undefined,
        localSource: config.mode === 'desktop' && LOCAL_SOURCES.has(request.header('x-sulla-projects-source') as ProjectsIdentity['source'])
          ? request.header('x-sulla-projects-source') as ProjectsIdentity['source'] : undefined,
      });
      await ensureTenant(request.projectsIdentity.tenantId);
      next();
    } catch (error) { next(error); }
  });
  app.post('/v1/rpc', async(request: AuthenticatedRequest, response, next) => {
    try {
      const operation = String(request.body?.operation ?? '');
      const args = Array.isArray(request.body?.args) ? request.body.args : [];
      if (!Object.prototype.hasOwnProperty.call(OPERATION_RULES, operation)) {
        throw Object.assign(new Error('unknown_operation'), { status: 404, publicCode: 'unknown_operation' });
      }
      const rule = OPERATION_RULES[operation];
      if (args.length < rule.minArgs || args.length > rule.maxArgs || containsAuthorityField(args)) {
        throw Object.assign(new Error('invalid_arguments'), { status: 400, publicCode: 'invalid_arguments' });
      }
      // Tenant, actor and source are always derived from the authenticated identity.
      // Caller-provided authority fields are never consulted in server mode.
      const identity = request.projectsIdentity!;
      if (identity.role === 'viewer' && !VIEWER_OPERATIONS.has(operation)) throw Object.assign(new Error('forbidden'), { status: 403, publicCode: 'forbidden' });
      if (ADMIN_OPERATIONS.has(operation) && identity.role !== 'admin') throw Object.assign(new Error('forbidden'), { status: 403, publicCode: 'forbidden' });
      const context = { actor: identity.actor, source: identity.source };
      const projects = getProjectsApplicationService() as unknown as Record<string, (...values: unknown[]) => unknown>;
      const values = [...args];
      if (rule.contextIndex !== undefined) {
        while (values.length < rule.contextIndex) values.push(undefined);
        values[rule.contextIndex] = context;
      }
      const database = getProjectsDatabase();
      const invoke = async() => projects[operation](...values);
      const result = await database.withTenant(identity.tenantId, () =>
        VIEWER_OPERATIONS.has(operation) ? invoke() : database.transaction(() => invoke()));
      response.json({ result: result === undefined ? null : result });
    } catch (error) { next(error); }
  });
  app.post('/v1/claims/claim', async(request: AuthenticatedRequest, response, next) => {
    try {
      const identity = request.projectsIdentity!;
      if (identity.role === 'viewer') throw Object.assign(new Error('forbidden'), { status: 403, publicCode: 'forbidden' });
      const database = getProjectsDatabase();
      const result = await database.withTenant(identity.tenantId, () => database.transaction(client => claimTasks(client, {
        tenantId: identity.tenantId, subject: identity.subject, externalRef: String(request.body?.externalRef ?? ''),
        assignees: stringRecord(request.body?.assignees ?? {}, 'assignees'),
        inheritedClaims: request.body?.inheritedClaims === undefined ? undefined : stringRecord(request.body.inheritedClaims, 'inheritedClaims'),
        leaseSeconds: request.body?.leaseSeconds,
      })));
      response.json({ result });
    } catch (error) { next(error); }
  });
  app.post('/v1/claims/renew', async(request: AuthenticatedRequest, response, next) => {
    try {
      const identity = request.projectsIdentity!;
      if (identity.role === 'viewer') throw Object.assign(new Error('forbidden'), { status: 403, publicCode: 'forbidden' });
      const database = getProjectsDatabase();
      const result = await database.withTenant(identity.tenantId, () => database.transaction(client => renewClaims(client, {
        tenantId: identity.tenantId, subject: identity.subject, externalRef: String(request.body?.externalRef ?? ''),
        leases: leases(request.body?.leases), leaseSeconds: request.body?.leaseSeconds,
      })));
      response.json({ result });
    } catch (error) { next(error); }
  });
  app.post('/v1/claims/release', async(request: AuthenticatedRequest, response, next) => {
    try {
      const identity = request.projectsIdentity!;
      if (identity.role === 'viewer') throw Object.assign(new Error('forbidden'), { status: 403, publicCode: 'forbidden' });
      const database = getProjectsDatabase();
      await database.withTenant(identity.tenantId, () => database.transaction(client => releaseClaims(client, {
        tenantId: identity.tenantId, subject: identity.subject, externalRef: String(request.body?.externalRef ?? ''),
        leases: leases(request.body?.leases),
      })));
      response.json({ result: true });
    } catch (error) { next(error); }
  });
  app.use((error: Error & { status?: number }, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    const status = error.status && error.status >= 400 && error.status < 600 ? error.status : 500;
    if (status >= 500) console.error('[SullaProjects]', error);
    response.status(status).json({ error: (error as Error & { publicCode?: string }).publicCode ?? (status >= 500 ? 'projects_internal_error' : 'projects_request_rejected') });
  });
  return app;
}
