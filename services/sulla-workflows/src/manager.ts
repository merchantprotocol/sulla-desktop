import crypto from 'node:crypto';

import cronParser from 'cron-parser';
import express from 'express';
import schedule from 'node-schedule';

import {
  authenticateRequest,
  boundedJson,
  identityParams,
  identitySql,
  requestBearer,
  requireOwner,
  type AuthenticatedRequest,
  type RequestIdentity,
} from './auth.js';
import { config } from './config.js';
import { migrate, pool } from './db.js';
import { emitEvent } from './events.js';
import { createWorkflowLauncher } from './launcher.js';
import { scheduleGrantIssueRequest } from './scheduleGrantRequest.js';
import { createPlaybookState, resolveDecision } from '../../../pkg/rancher-desktop/agent/workflow/WorkflowPlaybook.js';
import { issueCapabilityToken } from '../../../pkg/rancher-desktop/runtime/capabilityToken.js';

import type { WorkflowPlaybookState } from '../../../pkg/rancher-desktop/agent/workflow/types.js';

const app = express();
app.use(express.json({ limit: '10mb' }));

const launcher = createWorkflowLauncher();
const jobs = new Map<string, { job: schedule.Job; identity: RequestIdentity }>();
let schedulerLeader = false;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface ScheduleGrantRow {
  workflow_id:      string;
  schedule_node_id: string;
  grant_id:         string;
  grant_token:      string;
  expires_at:       Date | string;
  owner_issuer:     string;
  owner_subject:    string;
  authority_id:     string;
  organization_id:  string;
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function runnerTools(nodes: any[]): string[] {
  const allowedTools = new Set<string>(['meta/spawn_agent', 'agents/check_agent_jobs']);
  for (const node of nodes) {
    const toolName = node?.data?.config?.toolName;
    if (typeof toolName === 'string' && toolName && toolName !== '*' && !toolName.endsWith('/*')) allowedTools.add(toolName);
    if (node?.data?.subtype === 'desktop-notification') allowedTools.add('notify/notify_user');
  }
  return [...allowedTools];
}

function cronFor(configValue: Record<string, unknown>): string | null {
  const frequency = String(configValue.frequency ?? 'daily');
  const minute = Number(configValue.minute ?? 0);
  const hour = Number(configValue.hour ?? 9);
  if (frequency === 'every-minutes') {
    const interval = Number(configValue.intervalMinutes ?? 15);
    return interval > 0 && interval <= 59 ? `*/${ interval } * * * *` : null;
  }
  if (frequency === 'hourly') return `${ minute } * * * *`;
  if (frequency === 'daily') return `${ minute } ${ hour } * * *`;
  if (frequency === 'weekly') return `${ minute } ${ hour } * * ${ Number(configValue.dayOfWeek ?? 1) }`;
  if (frequency === 'monthly') return `${ minute } ${ hour } ${ Number(configValue.dayOfMonth ?? 1) } * *`;
  return null;
}

function identityFromRow(row: any, kind: 'owner' | 'runner' = 'owner'): RequestIdentity {
  if (!row?.owner_issuer || !row?.owner_subject) throw new Error('workflow resource has no owner');
  return {
    kind,
    issuer:         row.owner_issuer,
    subject:        row.owner_subject,
    authorityId:    row.authority_id ?? null,
    organizationId: row.organization_id ?? null,
    roles:          [],
    groups:         [],
    executionId:    kind === 'runner' ? row.execution_id : undefined,
  };
}

function sameIdentity(left: RequestIdentity, right: RequestIdentity): boolean {
  return identityParams(left).every((value, index) => value === identityParams(right)[index]);
}

function serviceHeaders(): Record<string, string> {
  return {
    'Content-Type':          'application/json',
    'X-Sulla-Service-Id':    config.accountsServiceId,
    'X-Sulla-Service-Token': config.accountsServiceToken,
  };
}

async function accountsJson(path: string, init: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(`${ config.accountsUrl }${ path }`, {
    ...init,
    redirect: 'error',
    signal:   AbortSignal.timeout(5_000),
  });
  const body = await boundedJson(response);
  if (!response.ok) throw new Error(`Accounts denied workflow delegation (${ response.status })`);
  return body;
}

async function boundedText(response: Response, maxBytes = 10 * 1024 * 1024): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length') ?? 0);
  if (declaredLength > maxBytes) throw new Error('tool response is too large');
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error('tool response is too large');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return new TextDecoder().decode(bytes);
}

function scheduleNodes(workflow: any): { id: string }[] {
  if (workflow.location !== 'server' || workflow.status !== 'production' || workflow.enabled !== true) return [];
  const found = new Map<string, { id: string }>();
  for (const node of workflow.definition?.nodes ?? []) {
    if (node?.data?.category === 'trigger' && node?.data?.subtype === 'schedule' &&
        typeof node.id === 'string' && node.id.trim() === node.id && node.id.length > 0 && node.id.length <= 255) {
      found.set(node.id, { id: node.id });
    }
  }
  return [...found.values()];
}

async function issueScheduleGrant(identity: RequestIdentity, bearerToken: string, workflowId: string,
  scheduleNodeId: string, replaceGrantId?: string): Promise<{ grantId: string; grantToken: string; expiresAt: string }> {
  if (!bearerToken) throw new Error('user bearer is required to delegate a schedule');
  const expiresAt = new Date(Date.now() + 89 * 86_400_000).toISOString();
  const request = scheduleGrantIssueRequest({
    authorityId:    identity.authorityId,
    organizationId: identity.organizationId,
    audience:       config.audience,
    serviceId:      config.accountsServiceId,
    workflowId,
    scheduleNodeId,
    requiredRoles:  config.requiredRoles,
    expiresAt,
    ...(replaceGrantId ? { replaceGrantId } : {}),
  }, bearerToken, serviceHeaders());
  const result = await accountsJson(request.path, request.init);
  const returnedExpiry = typeof result.expiresAt === 'string' ? Date.parse(result.expiresAt) : Number.NaN;
  if (typeof result.grantId !== 'string' || !UUID.test(result.grantId) ||
      typeof result.grantToken !== 'string' || result.grantToken.length < 32 || result.grantToken.length > 2_048 ||
      typeof result.expiresAt !== 'string' || !Number.isFinite(returnedExpiry) || returnedExpiry <= Date.now() ||
      returnedExpiry > Date.parse(expiresAt) + 1_000) {
    throw new Error('Accounts returned an invalid schedule grant');
  }
  return { grantId: result.grantId, grantToken: result.grantToken, expiresAt: result.expiresAt };
}

async function revokeScheduleGrant(grantToken: string): Promise<void> {
  const response = await fetch(`${ config.accountsUrl }/v1/private/schedule-grants/revoke`, {
    method:   'POST',
    headers:  serviceHeaders(),
    body:     JSON.stringify({ grantToken }),
    redirect: 'error',
    signal:   AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`Accounts refused schedule grant revocation (${ response.status })`);
}

async function reconcileScheduleGrants(workflow: any, identity: RequestIdentity, bearerToken: string, renew = false): Promise<void> {
  if (config.mode !== 'server') return;
  const wanted = new Set(scheduleNodes(workflow).map(node => node.id));
  const existing = (await pool.query(
    `SELECT * FROM workflow_schedule_grants WHERE workflow_id=$5 AND ${ identitySql }`,
    [...identityParams(identity), workflow.id],
  )).rows as ScheduleGrantRow[];

  for (const grant of existing) {
    if (wanted.has(grant.schedule_node_id)) continue;
    await revokeScheduleGrant(grant.grant_token);
    await pool.query(
      `DELETE FROM workflow_schedule_grants WHERE workflow_id=$5 AND schedule_node_id=$6 AND ${ identitySql }`,
      [...identityParams(identity), workflow.id, grant.schedule_node_id],
    );
  }

  for (const scheduleNodeId of wanted) {
    const prior = existing.find(grant => grant.schedule_node_id === scheduleNodeId);
    const renewSoon = !prior || Date.parse(String(prior.expires_at)) < Date.now() + 14 * 86_400_000;
    if (!renew && !renewSoon) continue;
    const issued = await issueScheduleGrant(identity, bearerToken, workflow.id, scheduleNodeId, prior?.grant_id);
    await pool.query(
      `INSERT INTO workflow_schedule_grants
         (workflow_id,schedule_node_id,grant_id,grant_token,expires_at,owner_issuer,owner_subject,authority_id,organization_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (workflow_id,schedule_node_id) DO UPDATE SET
         grant_id=EXCLUDED.grant_id,grant_token=EXCLUDED.grant_token,expires_at=EXCLUDED.expires_at,updated_at=NOW()
       WHERE workflow_schedule_grants.owner_issuer=EXCLUDED.owner_issuer
         AND workflow_schedule_grants.owner_subject=EXCLUDED.owner_subject
         AND workflow_schedule_grants.authority_id=EXCLUDED.authority_id
         AND workflow_schedule_grants.organization_id=EXCLUDED.organization_id`,
      [workflow.id, scheduleNodeId, issued.grantId, issued.grantToken, issued.expiresAt, ...identityParams(identity)],
    );
  }
}

async function resolveScheduleGrant(workflow: any, scheduleNodeId: string,
  grantToken?: string): Promise<{ identity: RequestIdentity; grantToken: string | null }> {
  if (config.mode === 'desktop') return { identity: identityFromRow(workflow), grantToken: null };
  let token = grantToken;
  if (!token) {
    const grant = (await pool.query(
      `SELECT grant_token FROM workflow_schedule_grants WHERE workflow_id=$5 AND schedule_node_id=$6 AND ${ identitySql }`,
      [...identityParams(identityFromRow(workflow)), workflow.id, scheduleNodeId],
    )).rows[0];
    token = grant?.grant_token;
  }
  if (!token) throw new Error('workflow schedule has no delegated grant');
  const context = await accountsJson('/v1/private/schedule-grants/resolve', {
    method: 'POST', headers: serviceHeaders(), body: JSON.stringify({ grantToken: token }),
  });
  const roles = Array.isArray(context.roles) && context.roles.every(value => typeof value === 'string' && value.length > 0) ? context.roles as string[] : null;
  const groups = Array.isArray(context.groups) && context.groups.every(value => typeof value === 'string' && value.length > 0) ? context.groups as string[] : null;
  if (context.issuer !== workflow.owner_issuer || context.subject !== workflow.owner_subject ||
      context.authorityId !== workflow.authority_id || context.organizationId !== workflow.organization_id ||
      context.audience !== config.audience || context.workflowId !== workflow.id || context.scheduleNodeId !== scheduleNodeId ||
      !roles || !groups || config.requiredRoles.some(role => !roles.includes(role))) {
    throw new Error('Accounts returned a schedule grant outside its bound context');
  }
  return {
    identity: {
      kind:           'owner',
      issuer:         context.issuer as string,
      subject:        context.subject as string,
      authorityId:    context.authorityId as string,
      organizationId: context.organizationId as string,
      roles,
      groups,
    },
    grantToken: token,
  };
}

async function issueRunToken(run: any, allowedTools: string[]): Promise<string> {
  if (!config.capabilitySigningKey) throw new Error('Workflow manager requires SULLA_CAPABILITY_SIGNING_KEY or SULLA_API_TOKEN');
  const token = issueCapabilityToken({
    sub:                   run.owner_subject,
    org_id:                run.organization_id ?? undefined,
    agent_id:              `workflow:${ run.execution_id }`,
    workflow_execution_id: run.execution_id,
    scopes:                allowedTools,
    expiresInSeconds:      3600,
  }, config.capabilitySigningKey, 'sulla-workflow-manager');
  await pool.query(
    `INSERT INTO workflow_run_tokens (token_hash, execution_id, allowed_tools, expires_at)
     VALUES ($1, $2, $3::jsonb, NOW() + INTERVAL '1 hour')`,
    [hashToken(token), run.execution_id, JSON.stringify(allowedTools)],
  );
  return token;
}

async function launch(executionId: string): Promise<string> {
  const run = (await pool.query(
    'SELECT execution_id,playbook_state,owner_issuer,owner_subject,authority_id,organization_id FROM workflow_executions WHERE execution_id=$1',
    [executionId],
  )).rows[0];
  if (!run?.owner_issuer || !run?.owner_subject) throw new Error('workflow execution has no owner');
  const allowedTools = runnerTools(run?.playbook_state?.definition?.nodes ?? []);
  if (config.mode === 'server') {
    const forbidden = allowedTools.filter(scope => !config.allowedRunnerScopes.has(scope));
    if (forbidden.length) throw new Error(`Workflow requests runner scopes outside server policy: ${ forbidden.join(', ') }`);
  }
  const token = await issueRunToken(run, allowedTools);
  const runnerId = await launcher.launchRunner({ executionId, runToken: token });
  await pool.query(
    `UPDATE workflow_executions
       SET runner_id = $2, status = 'running', resume_at = NULL, wait_kind = NULL, updated_at = NOW()
     WHERE execution_id = $1`,
    [executionId, runnerId],
  );
  return runnerId;
}

async function startRun(params: {
  workflowId:                string;
  message?:                  string;
  triggerKey?:               string;
  parentExecutionId?:        string;
  playbookState?:            WorkflowPlaybookState;
  delegatedGrantToken?:      string;
  delegatedGrantWorkflowId?: string;
  scheduleNodeId?:           string;
}, identity: RequestIdentity): Promise<{ executionId: string; runnerId: string; deduplicated?: boolean }> {
  let delegatedGrantToken = params.delegatedGrantToken;
  let delegatedGrantWorkflowId = params.delegatedGrantWorkflowId;
  let scheduleNodeId = params.scheduleNodeId;
  if (identity.kind === 'runner' && params.parentExecutionId !== identity.executionId) {
    throw new Error('runner may only start an explicitly linked child workflow');
  }
  if (identity.kind === 'runner') {
    const parent = (await pool.query(
      `SELECT playbook_state,delegated_grant_token,delegated_grant_workflow_id,schedule_node_id
         FROM workflow_executions WHERE execution_id=$5 AND status='running' AND ${ identitySql }`,
      [...identityParams(identity), identity.executionId],
    )).rows[0];
    delegatedGrantToken = parent?.delegated_grant_token ?? undefined;
    delegatedGrantWorkflowId = parent?.delegated_grant_workflow_id ?? undefined;
    scheduleNodeId = parent?.schedule_node_id ?? undefined;
    const allowedChildren = new Set<string>();
    for (const node of parent?.playbook_state?.definition?.nodes ?? []) {
      for (const value of [node?.data?.config?.workflowId, node?.data?.config?.targetWorkflowId]) {
        if (typeof value === 'string' && value) allowedChildren.add(value);
      }
    }
    if (!allowedChildren.has(params.workflowId)) throw new Error('child workflow is outside this runner scope');
  }
  const workflowResult = await pool.query(
    `SELECT * FROM workflows
     WHERE (id = $5 OR definition->>'slug' = $5) AND enabled = TRUE AND location = $6 AND ${ identitySql }
     LIMIT 1`,
    [...identityParams(identity), params.workflowId, config.mode],
  );
  const workflow = workflowResult.rows[0];
  if (!workflow) throw new Error(`Enabled ${ config.mode } workflow "${ params.workflowId }" was not found`);
  if (identity.kind === 'runner') {
    const parentScopes = new Set(identity.allowedTools ?? []);
    const widenedScopes = runnerTools(workflow.definition?.nodes ?? []).filter(scope => !parentScopes.has(scope));
    if (widenedScopes.length) throw new Error('child workflow would widen this runner grant');
  }

  const definition = workflow.definition;
  const state = params.playbookState ?? createPlaybookState(definition, params.message ?? '');
  const executionId = state.executionId;
  const inserted = await pool.query(
    `INSERT INTO workflow_executions
       (execution_id, workflow_id, workflow_name, workflow_slug, status, auto_restart,
        trigger_input, parent_execution_id, trigger_key, playbook_state,
        owner_issuer,owner_subject,authority_id,organization_id,delegated_grant_token,delegated_grant_workflow_id,schedule_node_id,started_at,updated_at)
     VALUES ($1,$2,$3,$4,'running',TRUE,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,NOW(),NOW())
     ON CONFLICT (trigger_key) WHERE trigger_key IS NOT NULL DO NOTHING
     RETURNING execution_id`,
    [executionId, workflow.id, workflow.name, definition.slug ?? workflow.id, params.message ?? null,
      params.parentExecutionId ?? null, params.triggerKey ?? null, JSON.stringify(state),
      ...identityParams(identity), delegatedGrantToken ?? null, delegatedGrantWorkflowId ?? null, scheduleNodeId ?? null],
  );
  if (inserted.rowCount === 0 && params.triggerKey) {
    const existing = await pool.query(
      `SELECT execution_id,runner_id FROM workflow_executions WHERE trigger_key=$5 AND ${ identitySql }`,
      [...identityParams(identity), params.triggerKey],
    );
    if (!existing.rows[0]) throw new Error('trigger key is already owned by another context');
    return { executionId: existing.rows[0].execution_id, runnerId: existing.rows[0].runner_id, deduplicated: true };
  }
  await emitEvent(executionId, workflow.id, 'workflow_started', { workflowName: workflow.name });
  return { executionId, runnerId: await launch(executionId) };
}

function cancelSchedules(visibleTo?: RequestIdentity): void {
  for (const [key, scheduled] of jobs) {
    if (!visibleTo || sameIdentity(scheduled.identity, visibleTo)) {
      scheduled.job.cancel();
      jobs.delete(key);
    }
  }
}

async function refreshSchedules(visibleTo?: RequestIdentity): Promise<any[]> {
  if (!schedulerLeader) return [];
  cancelSchedules(visibleTo);
  const scheduledWorkflows = config.mode === 'server' && visibleTo
    ? await pool.query(
      `SELECT * FROM workflows WHERE status='production' AND enabled=TRUE AND location=$5
         AND owner_issuer IS NOT NULL AND owner_subject IS NOT NULL AND ${ identitySql }`,
      [...identityParams(visibleTo), config.mode],
    )
    : await pool.query(
      `SELECT * FROM workflows WHERE status='production' AND enabled=TRUE AND location=$1
         AND owner_issuer IS NOT NULL AND owner_subject IS NOT NULL`, [config.mode],
    );
  const rows = scheduledWorkflows.rows;
  const armed: any[] = [];
  for (const workflow of rows) {
    for (const node of workflow.definition?.nodes ?? []) {
      if (node?.data?.category !== 'trigger' || node?.data?.subtype !== 'schedule') continue;
      const cron = cronFor(node.data.config ?? {});
      if (!cron) continue;
      const timezone = String(node.data.config?.timezone ?? '').trim() || 'UTC';
      const key = `${ workflow.id }:${ node.id }`;
      if (config.mode === 'server') {
        const delegated = await pool.query(
          `SELECT 1 FROM workflow_schedule_grants WHERE workflow_id=$5 AND schedule_node_id=$6 AND ${ identitySql }`,
          [...identityParams(identityFromRow(workflow)), workflow.id, node.id],
        );
        if (!delegated.rowCount) continue;
      }
      const job = schedule.scheduleJob({ rule: cron, tz: timezone }, async(fireDate: Date) => {
        const triggerKey = `schedule:${ key }:${ fireDate.toISOString() }`;
        try {
          const delegated = await resolveScheduleGrant(workflow, node.id);
          await startRun({
            workflowId:               workflow.id,
            message:                  `Scheduled trigger ${ node.data.label ?? node.id }`,
            triggerKey,
            delegatedGrantToken:      delegated.grantToken ?? undefined,
            delegatedGrantWorkflowId: workflow.id,
            scheduleNodeId:           node.id,
          }, delegated.identity);
        } catch (error) {
          console.error(`[workflow-manager] Schedule ${ key } failed:`, error);
        }
      });
      if (job) {
        jobs.set(key, { job, identity: identityFromRow(workflow) });
        armed.push({ workflowId: workflow.id, workflowName: workflow.name, nodeId: node.id, cronExpression: cron, timezone, nextInvocation: job.nextInvocation()?.toISOString() ?? null });
      }
    }
  }
  return armed;
}

async function catchUp(identity: RequestIdentity, dryRun = false, lookbackDays = 7): Promise<any> {
  const rows = (await pool.query(
    `SELECT * FROM workflows WHERE status='production' AND enabled=TRUE AND location=$5 AND ${ identitySql }`,
    [...identityParams(identity), config.mode],
  )).rows;
  const results: any[] = [];
  const now = new Date();
  for (const workflow of rows) {
    for (const node of workflow.definition?.nodes ?? []) {
      if (node?.data?.category !== 'trigger' || node?.data?.subtype !== 'schedule') continue;
      const cron = cronFor(node.data.config ?? {});
      if (!cron) continue;
      const timezone = String(node.data.config?.timezone ?? '').trim() || 'UTC';
      const previous = cronParser.parseExpression(cron, { tz: timezone, currentDate: now }).prev().toDate();
      if (now.getTime() - previous.getTime() > Math.min(Math.max(lookbackDays, 1), 31) * 86_400_000) continue;
      const key = `schedule:${ workflow.id }:${ node.id }:${ previous.toISOString() }`;
      const exists = await pool.query(`SELECT execution_id FROM workflow_executions WHERE trigger_key=$5 AND ${ identitySql }`, [...identityParams(identity), key]);
      if (exists.rowCount) results.push({ workflowId: workflow.id, expectedAt: previous.toISOString(), status: 'already-fired' });
      else if (dryRun) results.push({ workflowId: workflow.id, expectedAt: previous.toISOString(), status: 'missed' });
      else {
        const delegated = await resolveScheduleGrant(workflow, node.id);
        results.push({
          workflowId: workflow.id,
          expectedAt: previous.toISOString(),
          status:     'dispatched',
          ...(await startRun({
            workflowId:               workflow.id,
            message:                  `Catch-up for ${ previous.toISOString() }`,
            triggerKey:               key,
            delegatedGrantToken:      delegated.grantToken ?? undefined,
            delegatedGrantWorkflowId: workflow.id,
            scheduleNodeId:           node.id,
          }, delegated.identity)),
        });
      }
    }
  }
  return results;
}

app.get('/healthz', (_request, response) => response.json({ ok: true }));
app.use('/v1', authenticateRequest);

app.get('/v1/workflows', requireOwner, async(request: AuthenticatedRequest, response, next) => {
  try {
    const rows = (await pool.query(
      `SELECT id,name,description,status,enabled,location,system,definition,updated_at
         FROM workflows WHERE ${ identitySql } ORDER BY updated_at DESC`,
      identityParams(request.identity!),
    )).rows;
    response.json(rows.map(row => ({
      id:          row.id,
      name:        row.name,
      description: row.description,
      status:      row.status,
      enabled:     row.enabled,
      location:    row.location,
      system:      row.system === true,
      nodeCount:   Array.isArray(row.definition?.nodes) ? row.definition.nodes.length : 0,
      updatedAt:   new Date(row.updated_at).toISOString(),
    })));
  } catch (error) { next(error) }
});
app.get('/v1/workflows/:id', requireOwner, async(request: AuthenticatedRequest, response, next) => {
  try {
    const row = (await pool.query(
      `SELECT * FROM workflows WHERE id=$5 AND ${ identitySql }`,
      [...identityParams(request.identity!), request.params.id],
    )).rows[0];
    if (!row) return response.status(404).json({ error: 'workflow not found' });
    response.json(row);
  } catch (error) { next(error) }
});
app.put('/v1/workflows/:id', requireOwner, async(request: AuthenticatedRequest, response, next) => {
  try {
    const workflow = request.body;
    const identity = request.identity!;
    const location = workflow.location === 'server' ? 'server' : 'desktop';
    const existing = (await pool.query('SELECT definition,owner_issuer,owner_subject,authority_id,organization_id FROM workflows WHERE id=$1', [request.params.id])).rows[0];
    if (existing && !identityParams(identity).every((value, index) => value === identityParams(identityFromRow(existing))[index])) {
      return response.status(404).json({ error: 'workflow not found' });
    }
    const previous = existing?.definition ?? null;
    const row = (await pool.query(
      `INSERT INTO workflows
         (id,name,description,version,status,definition,enabled,location,owner_issuer,owner_subject,authority_id,organization_id)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, description=EXCLUDED.description,
         version=EXCLUDED.version, status=EXCLUDED.status, definition=EXCLUDED.definition,
         enabled=EXCLUDED.enabled, location=EXCLUDED.location, updated_at=NOW()
       WHERE workflows.owner_issuer=EXCLUDED.owner_issuer AND workflows.owner_subject=EXCLUDED.owner_subject
         AND workflows.authority_id IS NOT DISTINCT FROM EXCLUDED.authority_id
         AND workflows.organization_id IS NOT DISTINCT FROM EXCLUDED.organization_id
       RETURNING *`,
      [request.params.id, workflow.name, workflow.description ?? null, workflow.version ?? null,
        workflow.status ?? 'draft', JSON.stringify(workflow.definition ?? workflow), workflow.enabled !== false, location,
        ...identityParams(identity)],
    )).rows[0];
    if (!row) return response.status(409).json({ error: 'workflow id is unavailable' });
    await pool.query(
      `INSERT INTO workflow_history
         (workflow_id,definition_before,definition_after,changed_by,change_reason,owner_issuer,owner_subject,authority_id,organization_id)
       VALUES ($1,$2::jsonb,$3::jsonb,$4,'manager API upsert',$5,$6,$7,$8)`,
      [request.params.id, previous ? JSON.stringify(previous) : null, JSON.stringify(workflow.definition ?? workflow),
        identity.subject, ...identityParams(identity)],
    );
    cancelSchedules(identity);
    await reconcileScheduleGrants(row, identity, requestBearer(request), true);
    await refreshSchedules(identity);
    response.json(row);
  } catch (error) { next(error) }
});
app.delete('/v1/workflows/:id', requireOwner, async(request: AuthenticatedRequest, response, next) => {
  try {
    const identity = request.identity!;
    const workflow = (await pool.query(
      `SELECT * FROM workflows WHERE id=$5 AND ${ identitySql }`,
      [...identityParams(identity), request.params.id],
    )).rows[0];
    if (!workflow) return response.status(404).json({ error: 'workflow not found' });
    cancelSchedules(identity);
    if (config.mode === 'server') await reconcileScheduleGrants({ ...workflow, enabled: false }, identity, requestBearer(request));
    await pool.query(
      `DELETE FROM workflows WHERE id=$5 AND ${ identitySql }`,
      [...identityParams(identity), request.params.id],
    );
    await refreshSchedules(identity);
    response.status(204).send();
  } catch (error) { next(error) }
});
app.patch('/v1/workflows/:id/location', requireOwner, async(request: AuthenticatedRequest, response, next) => {
  try {
    const location = request.body.location;
    if (!['desktop', 'server'].includes(location)) return response.status(400).json({ error: 'location must be desktop or server' });
    const row = (await pool.query(
      `UPDATE workflows SET location=$6,updated_at=NOW() WHERE id=$5 AND ${ identitySql } RETURNING *`,
      [...identityParams(request.identity!), request.params.id, location],
    )).rows[0];
    if (!row) return response.status(404).json({ error: 'workflow not found' });
    cancelSchedules(request.identity);
    await reconcileScheduleGrants(row, request.identity!, requestBearer(request), true);
    await refreshSchedules(request.identity);
    response.json(row);
  } catch (error) { next(error) }
});
app.patch('/v1/workflows/:id/status', requireOwner, async(request: AuthenticatedRequest, response, next) => {
  try {
    const status = request.body.status;
    if (!['draft', 'production', 'archive'].includes(status)) return response.status(400).json({ error: 'invalid workflow status' });
    const identity = request.identity!;
    const row = (await pool.query(
      `UPDATE workflows SET status=$6,updated_at=NOW() WHERE id=$5 AND ${ identitySql } RETURNING *`,
      [...identityParams(identity), request.params.id, status],
    )).rows[0];
    if (!row) return response.status(404).json({ error: 'workflow not found' });
    cancelSchedules(identity);
    await reconcileScheduleGrants(row, identity, requestBearer(request), true);
    await refreshSchedules(identity);
    response.json(row);
  } catch (error) { next(error) }
});
app.post('/v1/runs', async(request: AuthenticatedRequest, response, next) => {
  try {
    const workflowId = typeof request.body?.workflowId === 'string' ? request.body.workflowId.trim() : '';
    if (!workflowId) return response.status(400).json({ error: 'workflowId is required' });
    const message = typeof request.body?.message === 'string' ? request.body.message : '';
    const identity = request.identity!;
    response.status(202).json(await startRun({
      workflowId,
      message,
      parentExecutionId: identity.kind === 'runner' ? identity.executionId : undefined,
    }, identity));
  } catch (error) { next(error) }
});
app.get('/v1/runs/:id', async(request: AuthenticatedRequest, response, next) => {
  try {
    const identity = request.identity!;
    const runnerClause = identity.kind === 'runner' ? 'AND (execution_id=$6 OR parent_execution_id=$6)' : '';
    const values = [...identityParams(identity), request.params.id, ...(identity.kind === 'runner' ? [identity.executionId] : [])];
    const run = (await pool.query(
      `SELECT * FROM workflow_executions WHERE execution_id=$5 AND ${ identitySql } ${ runnerClause }`, values,
    )).rows[0];
    if (!run) return response.status(404).json({ error: 'run not found' });
    const events = (await pool.query('SELECT payload FROM workflow_execution_events WHERE execution_id=$1 ORDER BY id', [run.execution_id])).rows.map(row => row.payload);
    const { delegated_grant_token: _delegatedGrantToken, ...publicRun } = run;
    response.json({ ...publicRun, events });
  } catch (error) { next(error) }
});
app.post('/v1/runs/:id/resume', requireOwner, async(request: AuthenticatedRequest, response, next) => {
  try {
    const row = (await pool.query(
      `SELECT * FROM workflow_executions WHERE execution_id=$5 AND ${ identitySql }`,
      [...identityParams(request.identity!), request.params.id],
    )).rows[0];
    if (!row) return response.status(404).json({ error: 'run not found' });
    let state = row.playbook_state as WorkflowPlaybookState;
    if (row.wait_kind === 'user-input' && state.pendingDecision) state = resolveDecision(state, String(request.body.input ?? '')).updatedPlaybook;
    await pool.query(`UPDATE workflow_executions SET playbook_state=$2::jsonb, resume_input=NULL, status='running', updated_at=NOW() WHERE execution_id=$1`, [request.params.id, JSON.stringify(state)]);
    response.status(202).json({ executionId: request.params.id, runnerId: await launch(request.params.id) });
  } catch (error) { next(error) }
});
app.post('/v1/runs/:id/restart', requireOwner, async(request: AuthenticatedRequest, response, next) => {
  try {
    const checkpoint = (await pool.query(
      `SELECT c.playbook_state FROM workflow_checkpoints c
       JOIN workflow_executions e ON e.execution_id=c.execution_id
       WHERE c.execution_id=$5 AND ($6::text IS NULL OR c.node_id=$6) AND ${ identitySql.replaceAll('owner_', 'e.owner_').replace('authority_id', 'e.authority_id').replace('organization_id', 'e.organization_id') }
       ORDER BY c.sequence DESC LIMIT 1`,
      [...identityParams(request.identity!), request.params.id, request.body.nodeId ?? null],
    )).rows[0];
    if (!checkpoint) return response.status(404).json({ error: 'checkpoint not found' });
    const state = checkpoint.playbook_state as WorkflowPlaybookState;
    state.executionId = `wfp-${ Date.now() }-${ crypto.randomBytes(3).toString('hex') }`;
    state.status = 'running';
    state.completedAt = undefined;
    response.status(202).json(await startRun({ workflowId: state.workflowId, message: 'Restarted from checkpoint', playbookState: state }, request.identity!));
  } catch (error) { next(error) }
});
app.post('/v1/schedules/refresh', requireOwner, async(request: AuthenticatedRequest, response, next) => {
  try {
    const identity = request.identity!;
    if (config.mode === 'server') {
      const rows = (await pool.query(`SELECT * FROM workflows WHERE ${ identitySql }`, identityParams(identity))).rows;
      for (const workflow of rows) await reconcileScheduleGrants(workflow, identity, requestBearer(request));
    }
    response.json({ schedules: await refreshSchedules(identity) });
  } catch (error) { next(error) }
});
app.post('/v1/schedules/catch-up', requireOwner, async(request: AuthenticatedRequest, response, next) => {
  try { response.json({ results: await catchUp(request.identity!, request.body?.dryRun === true, Number(request.body?.lookbackDays ?? 7)) }) } catch (error) { next(error) }
});

app.post('/internal/tools/:category/:tool', async(request, response, next) => {
  try {
    const token = request.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '';
    const tokenRow = (await pool.query(
      `SELECT t.* FROM workflow_run_tokens t
       JOIN workflow_executions e ON e.execution_id=t.execution_id
       WHERE t.token_hash=$1 AND t.expires_at > NOW() AND e.status='running'`,
      [hashToken(token)],
    )).rows[0];
    if (!tokenRow) return response.status(401).json({ error: 'invalid or expired workflow run token' });
    const allowed = tokenRow.allowed_tools as string[];
    const scopedName = `${ request.params.category }/${ request.params.tool }`;
    if (!allowed.includes(scopedName)) {
      return response.status(403).json({ error: 'tool is outside this run scope' });
    }
    const upstream = await fetch(`${ config.toolApiUrl }/v1/tools/internal/${ encodeURIComponent(request.params.category) }/${ encodeURIComponent(request.params.tool) }/call`, {
      method:  'POST',
      headers: {
        'Content-Type':               'application/json',
        Authorization:                `Bearer ${ token }`,
        'X-Sulla-Workflow-Execution': tokenRow.execution_id,
      },
      body:     JSON.stringify(request.body ?? {}),
      redirect: 'error',
      signal:   AbortSignal.timeout(120_000),
    });
    response.status(upstream.status).send(await boundedText(upstream));
  } catch (error) { next(error) }
});

app.use((error: any, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  console.error('[workflow-manager]', error);
  response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
});

async function resumeDueRuns(): Promise<void> {
  if (!schedulerLeader) return;
  const due = (await pool.query(
    `SELECT execution_id FROM workflow_executions
     WHERE status='suspended' AND resume_at IS NOT NULL AND resume_at <= NOW()
       AND owner_issuer IS NOT NULL AND owner_subject IS NOT NULL
     FOR UPDATE SKIP LOCKED`,
  )).rows;
  for (const row of due) {
    try {
      const current = (await pool.query(
        `SELECT w.*,e.execution_id,e.workflow_id,e.wait_payload,e.delegated_grant_token,
                e.delegated_grant_workflow_id,e.schedule_node_id
           FROM workflow_executions e JOIN workflows w ON w.id=e.workflow_id
          WHERE e.execution_id=$1`,
        [row.execution_id],
      )).rows[0];
      if (config.mode === 'server') {
        if (!current?.delegated_grant_token || !current?.delegated_grant_workflow_id || !current?.schedule_node_id) {
          throw new Error('server continuation has no delegated schedule grant');
        }
        await resolveScheduleGrant(
          { ...current, id: current.delegated_grant_workflow_id },
          current.schedule_node_id,
          current.delegated_grant_token,
        );
      }
      if (current?.wait_payload?.nodeId) {
        await emitEvent(row.execution_id, current.workflow_id, 'node_completed', { output: 'wait elapsed' }, current.wait_payload.nodeId);
      }
      await launch(row.execution_id);
    } catch (error) {
      await pool.query(
        `UPDATE workflow_executions SET resume_at=NOW() + INTERVAL '5 minutes',updated_at=NOW() WHERE execution_id=$1`,
        [row.execution_id],
      );
      console.error('[workflow-manager] wait resume failed closed; retry delayed:', error);
    }
  }
}

async function establishLegacyOwnership(): Promise<void> {
  if (config.mode === 'server') {
    const ambiguous = await pool.query(
      `SELECT
         (SELECT count(*) FROM workflows WHERE owner_issuer IS NULL OR owner_subject IS NULL) +
         (SELECT count(*) FROM workflow_executions WHERE owner_issuer IS NULL OR owner_subject IS NULL) +
         (SELECT count(*) FROM workflow_history WHERE owner_issuer IS NULL OR owner_subject IS NULL) AS count`,
    );
    if (Number(ambiguous.rows[0]?.count ?? 0) > 0) {
      throw new Error('Server mode refuses ambiguous legacy workflow ownership; migrate these rows through authenticated desktop ownership first');
    }
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE workflows SET owner_issuer='urn:sulla:desktop',owner_subject='local-owner'
        WHERE owner_issuer IS NULL AND owner_subject IS NULL`,
    );
    await client.query(
      `UPDATE workflow_executions e SET owner_issuer=w.owner_issuer,owner_subject=w.owner_subject,
          authority_id=w.authority_id,organization_id=w.organization_id
         FROM workflows w WHERE e.workflow_id=w.id AND e.owner_issuer IS NULL AND e.owner_subject IS NULL`,
    );
    await client.query(
      `UPDATE workflow_history h SET owner_issuer=w.owner_issuer,owner_subject=w.owner_subject,
          authority_id=w.authority_id,organization_id=w.organization_id
         FROM workflows w WHERE h.workflow_id=w.id AND h.owner_issuer IS NULL AND h.owner_subject IS NULL`,
    );
    const remaining = await client.query(
      `SELECT
         (SELECT count(*) FROM workflow_executions WHERE owner_issuer IS NULL OR owner_subject IS NULL) +
         (SELECT count(*) FROM workflow_history WHERE owner_issuer IS NULL OR owner_subject IS NULL) AS count`,
    );
    if (Number(remaining.rows[0]?.count ?? 0) > 0) throw new Error('orphaned legacy workflow rows have ambiguous ownership');
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  await migrate();
  await establishLegacyOwnership();
  const lockClient = await pool.connect();
  schedulerLeader = (await lockClient.query(`SELECT pg_try_advisory_lock(hashtext('sulla-workflow-manager')) AS acquired`)).rows[0].acquired === true;
  if (!schedulerLeader) console.warn('[workflow-manager] Another manager owns triggers; API remains healthy without scheduling');
  await refreshSchedules();
  setInterval(() => resumeDueRuns().catch(error => console.error('[workflow-manager] wait scan failed:', error)), 1_000).unref();
  app.listen(config.port, '0.0.0.0', () => console.log(`[workflow-manager] listening on :${ config.port }; schedulerLeader=${ schedulerLeader }`));
}

main().catch(error => {
  console.error('[workflow-manager] fatal:', error);
  process.exitCode = 1;
});
