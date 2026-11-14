// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import cronParser from 'cron-parser';
import express from 'express';
import schedule from 'node-schedule';

import {
  authenticateRequest,
  identityParams,
  identitySql,
  requireMutationRole,
  requireOwner,
  type AuthenticatedRequest,
  type RequestIdentity,
} from './auth.js';
import { config } from './config.js';
import { advisoryLockPool, closeDb, migrate, pool } from './db.js';
import { emitEvent } from './events.js';
import { createWorkflowLauncher } from './launcher.js';
import { settleUnownedRun, waitForRunnerHandshake } from './managerLifecycle.js';
import { createPlaybookState, resolveDecision } from '../../../packages/workflow-engine/src/WorkflowPlaybook.js';
import { workflowConcurrencyLimit } from '../../../packages/workflow-engine/src/workflowConcurrency.js';
import { AbandonedRunReaper } from './AbandonedRunReaper.js';
import { ProcessGuard } from './ProcessGuard.js';
import { DatabaseHealthRepository } from './Repositories/DatabaseHealthRepository.js';
import { StartupDatabaseWait } from './StartupDatabaseWait.js';
import { WorkflowConcurrencyLimitError } from './WorkflowConcurrencyLimitError.js';

import { issueCapabilityToken } from '../../../packages/runtime-protocol/src/capabilityToken.js';
import { META_TOOL_CATEGORIES } from './metaToolCategories.js';

import type { WorkflowPlaybookState } from '../../../packages/workflow-engine/src/types.js';

const app = express();
app.use(express.json({ limit: '10mb' }));
const here = path.dirname(fileURLToPath(import.meta.url));
const uiRoot = path.resolve(here, '../../../../ui');

const launcher = createWorkflowLauncher();
const jobs = new Map<string, { job: schedule.Job; identity: RequestIdentity }>();
const launches = new Map<string, Promise<string>>();
let schedulerLeader = false;
const managerStartedAt = new Date();
const guard = new ProcessGuard({ name: 'workflow-manager' }).catchCrashes();
const databaseHealth = new DatabaseHealthRepository(pool);
const abandonedRuns = new AbandonedRunReaper({
  db:               pool,
  lockPool:         advisoryLockPool,
  launcher,
  emit:              emitEvent,
  isLaunching:       executionId => launches.has(executionId),
  managerStartedAt,
  location:          'desktop',
});

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function canonicalToolScope(toolName: string): string {
  if (toolName.includes('/')) return toolName;
  return `${ META_TOOL_CATEGORIES[toolName] ?? 'meta' }/${ toolName }`;
}

function runnerTools(nodes: any[]): string[] {
  const allowedTools = new Set<string>(['meta/spawn_agent', 'agents/check_agent_jobs']);
  for (const node of nodes) {
    const toolName = node?.data?.config?.toolName;
    if (typeof toolName === 'string' && toolName && toolName !== '*' && !toolName.endsWith('/*')) {
      allowedTools.add(canonicalToolScope(toolName));
    }
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

async function launchUnchecked(executionId: string): Promise<string> {
  const run = (await pool.query(
    `SELECT e.execution_id,e.playbook_state,e.owner_issuer,e.owner_subject,e.authority_id,e.organization_id,
            e.status,e.runner_id,e.owner_id,e.lease_token,e.wait_kind,e.resume_at
       FROM workflow_executions e JOIN workflows w ON w.id=e.workflow_id
      WHERE e.execution_id=$1 AND e.status IN ('running','suspended') AND w.location='desktop' AND w.status <> 'archive'`,
    [executionId],
  )).rows[0];
  if (!run?.owner_issuer || !run?.owner_subject) throw new Error('workflow execution has no owner');
  if (run.runner_id || run.owner_id || run.lease_token) throw new Error(`workflow execution ${ executionId } is already launching or owned`);
  const allowedTools = runnerTools(run?.playbook_state?.definition?.nodes ?? []);
  const token = await issueRunToken(run, allowedTools);
  let runnerId: string | null = null;
  let assigned = false;
  try {
    runnerId = await launcher.prepareRunner({ executionId, runToken: token });
    const assignment = await pool.query(
      `UPDATE workflow_executions
         SET runner_id = $2, status = 'running', resume_at = NULL, wait_kind = NULL, updated_at = NOW()
       WHERE execution_id = $1 AND status = $3
         AND runner_id IS NOT DISTINCT FROM $4::text
         AND owner_id IS NOT DISTINCT FROM $5::text
         AND lease_token IS NOT DISTINCT FROM $6::text
         AND wait_kind IS NOT DISTINCT FROM $7::text
         AND resume_at IS NOT DISTINCT FROM $8::timestamptz
         AND NOT EXISTS (
           SELECT 1 FROM workflows
            WHERE workflows.id=workflow_executions.workflow_id AND workflows.status='archive'
         )
       RETURNING execution_id`,
      [executionId, runnerId, run.status, run.runner_id, run.owner_id, run.lease_token, run.wait_kind, run.resume_at],
    );
    if (!assignment.rowCount) throw new Error(`workflow execution ${ executionId } became inactive before runner assignment`);
    assigned = true;
    await launcher.startRunner(runnerId, { executionId, runToken: token });
    await waitForRunnerHandshake({ db: pool, launcher, emit: emitEvent, executionId, runnerId });
    return runnerId;
  } catch (error) {
    if (runnerId) await launcher.stopRunner(runnerId).catch(() => {});
    await settleUnownedRun(pool, emitEvent, executionId, 'runner_launch_failed', assigned ? runnerId : null);
    throw error;
  }
}

function launch(executionId: string): Promise<string> {
  const existing = launches.get(executionId);
  if (existing) return existing;
  const pending = (async() => {
    const lockClient = await advisoryLockPool.connect();
    try {
      const acquiredImmediately = (await lockClient.query(
        'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired', [`workflow-launch:${ executionId }`],
      )).rows[0]?.acquired === true;
      if (!acquiredImmediately) {
        await lockClient.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [`workflow-launch:${ executionId }`]);
        const current = (await pool.query(
          `SELECT status,runner_id,owner_id,lease_token,heartbeat_at,lease_expires_at,wait_kind
             FROM workflow_executions WHERE execution_id=$1`, [executionId],
        )).rows[0];
        if (!current) throw new Error(`workflow execution ${ executionId } no longer exists`);
        const alreadyHandled = ['completed', 'failed'].includes(current.status) ||
          (current.status === 'suspended' && current.wait_kind && !current.owner_id && !current.lease_token) ||
          (current.owner_id && current.lease_token && current.heartbeat_at && current.lease_expires_at);
        if (alreadyHandled) return current.runner_id ?? '';
      }
      return await launchUnchecked(executionId);
    } finally {
      await lockClient.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [`workflow-launch:${ executionId }`]).catch(() => {});
      lockClient.release();
      launches.delete(executionId);
    }
  })();
  launches.set(executionId, pending);
  return pending;
}

async function startRun(params: {
  workflowId:                string;
  message?:                  string;
  triggerKey?:               string;
  parentExecutionId?:        string;
  playbookState?:            WorkflowPlaybookState;
  if (identity.kind === 'runner' && params.parentExecutionId !== identity.executionId) {
    throw new Error('runner may only start an explicitly linked child workflow');
  }
  if (identity.kind === 'runner') {
    const parent = (await pool.query(
      `SELECT playbook_state
         FROM workflow_executions WHERE execution_id=$5 AND status='running' AND ${ identitySql }`,
      [...identityParams(identity), identity.executionId],
    )).rows[0];
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
     WHERE (id = $5 OR definition->>'slug' = $5) AND enabled = TRUE AND status <> 'archive' AND location = 'desktop' AND ${ identitySql }
     LIMIT 1`,
    [...identityParams(identity), params.workflowId],
  );
  const workflow = workflowResult.rows[0];
  if (!workflow) throw new Error(`Enabled Desktop workflow "${ params.workflowId }" was not found`);
  if (identity.kind === 'runner') {
    const parentScopes = new Set(identity.allowedTools ?? []);
    const widenedScopes = runnerTools(workflow.definition?.nodes ?? []).filter(scope => !parentScopes.has(scope));
    if (widenedScopes.length) throw new Error('child workflow would widen this runner grant');
  }

  const definition = workflow.definition;
  const maxConcurrentRuns = workflowConcurrencyLimit(definition);
  const autoRestart = definition.auto_restart !== false && maxConcurrentRuns > 1;
  const state = params.playbookState ?? createPlaybookState(definition, params.message ?? '');
  const executionId = state.executionId;
  await abandonedRuns.reap(workflow.id);
  const client = await pool.connect();
  let inserted;
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`workflow-admission:${ workflow.id }`]);
    if (params.triggerKey) {
      const existing = await client.query(
        `SELECT execution_id,runner_id FROM workflow_executions WHERE trigger_key=$5 AND ${ identitySql }`,
        [...identityParams(identity), params.triggerKey],
      );
      if (existing.rows[0]) {
        await client.query('COMMIT');
        return { executionId: existing.rows[0].execution_id, runnerId: existing.rows[0].runner_id, deduplicated: true };
      }
    }
    const active = await client.query(
      `SELECT execution_id FROM workflow_executions
        WHERE workflow_id=$1 AND status IN ('running','suspended')
        ORDER BY started_at ASC LIMIT $2`, [workflow.id, maxConcurrentRuns],
    );
    if (active.rows.length >= maxConcurrentRuns) {
      throw new WorkflowConcurrencyLimitError(maxConcurrentRuns, active.rows.map(row => row.execution_id));
    }
    inserted = await client.query(
      `INSERT INTO workflow_executions
       (execution_id, workflow_id, workflow_name, workflow_slug, status, auto_restart,
        trigger_input, parent_execution_id, trigger_key, playbook_state,
        owner_issuer,owner_subject,authority_id,organization_id,started_at,updated_at)
     VALUES ($1,$2,$3,$4,'running',$13,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,NOW(),NOW())
     ON CONFLICT (trigger_key) WHERE trigger_key IS NOT NULL DO NOTHING
     RETURNING execution_id`,
    [executionId, workflow.id, workflow.name, definition.slug ?? workflow.id, params.message ?? null,
      params.parentExecutionId ?? null, params.triggerKey ?? null, JSON.stringify(state),
      ...identityParams(identity), autoRestart],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  if (!inserted?.rowCount) throw new Error('trigger key is already owned by another context');
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
  const scheduledWorkflows = visibleTo
    ? await pool.query(
      `SELECT * FROM workflows WHERE status='production' AND enabled=TRUE AND location='desktop'
         AND owner_issuer IS NOT NULL AND owner_subject IS NOT NULL AND ${ identitySql }`,
      identityParams(visibleTo),
    )
    : await pool.query(
      `SELECT * FROM workflows WHERE status='production' AND enabled=TRUE AND location='desktop'
         AND owner_issuer IS NOT NULL AND owner_subject IS NOT NULL`,
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
      const job = schedule.scheduleJob({ rule: cron, tz: timezone }, async(fireDate: Date) => {
        const triggerKey = `schedule:${ key }:${ fireDate.toISOString() }`;
        try {
          await startRun({
            workflowId:               workflow.id,
            message:                  `Scheduled trigger ${ node.data.label ?? node.id }`,
            triggerKey,
          }, identityFromRow(workflow));
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
    `SELECT * FROM workflows WHERE status='production' AND enabled=TRUE AND location='desktop' AND ${ identitySql }`,
    identityParams(identity),
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
        results.push({
          workflowId: workflow.id,
          expectedAt: previous.toISOString(),
          status:     'dispatched',
          ...(await startRun({
            workflowId:               workflow.id,
            message:                  `Catch-up for ${ previous.toISOString() }`,
            triggerKey:               key,
          }, identity)),
        });
      }
    }
  }
  return results;
}

app.get('/healthz', async(_request, response) => {
  const ok = await databaseHealth.reachable();
  response.status(ok ? 200 : 503).json({ ok, service: 'workflows' });
});
app.get(/^\/ui$/, (_request, response) => response.redirect(308, '/ui/'));
app.use('/ui', (_request, response, next) => {
  response.setHeader('Content-Security-Policy', "default-src 'self'; frame-ancestors 'self'; script-src 'self'; style-src 'self'"); next();
});
app.use('/ui', express.static(uiRoot, { index: 'index.html', fallthrough: false }));
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
app.put('/v1/workflows/:id', requireOwner, requireMutationRole, async(request: AuthenticatedRequest, response, next) => {
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
    await refreshSchedules(identity);
    response.json(row);
  } catch (error) { next(error) }
});
app.delete('/v1/workflows/:id', requireOwner, requireMutationRole, async(request: AuthenticatedRequest, response, next) => {
  try {
    const identity = request.identity!;
    const workflow = (await pool.query(
      `SELECT * FROM workflows WHERE id=$5 AND ${ identitySql }`,
      [...identityParams(identity), request.params.id],
    )).rows[0];
    if (!workflow) return response.status(404).json({ error: 'workflow not found' });
    cancelSchedules(identity);
    await pool.query(
      `DELETE FROM workflows WHERE id=$5 AND ${ identitySql }`,
      [...identityParams(identity), request.params.id],
    );
    await refreshSchedules(identity);
    response.status(204).send();
  } catch (error) { next(error) }
});
app.patch('/v1/workflows/:id/location', requireOwner, requireMutationRole, async(request: AuthenticatedRequest, response, next) => {
  try {
    const location = request.body.location;
    if (!['desktop', 'server'].includes(location)) return response.status(400).json({ error: 'location must be desktop or server' });
    const row = (await pool.query(
      `UPDATE workflows SET location=$6,updated_at=NOW() WHERE id=$5 AND ${ identitySql } RETURNING *`,
      [...identityParams(request.identity!), request.params.id, location],
    )).rows[0];
    if (!row) return response.status(404).json({ error: 'workflow not found' });
    cancelSchedules(request.identity);
    await refreshSchedules(request.identity);
    response.json(row);
  } catch (error) { next(error) }
});
app.patch('/v1/workflows/:id/status', requireOwner, requireMutationRole, async(request: AuthenticatedRequest, response, next) => {
  try {
    const status = request.body.status;
    if (!['draft', 'production', 'archive'].includes(status)) return response.status(400).json({ error: 'invalid workflow status' });
    const identity = request.identity!;
    const row = (await pool.query(
      `UPDATE workflows SET status=$6,updated_at=NOW() WHERE id=$5 AND ${ identitySql } RETURNING *`,
      [...identityParams(identity), request.params.id, status],
    )).rows[0];
    if (!row) return response.status(404).json({ error: 'workflow not found' });
    if (status === 'archive') {
      const retired = (await pool.query(
        `UPDATE workflow_executions
            SET status='failed',auto_restart=FALSE,completed_at=COALESCE(completed_at,NOW()),
                terminal_at=COALESCE(terminal_at,NOW()),terminal_reason='workflow_archived',
                error=COALESCE(error,'workflow_archived'),owner_id=NULL,lease_token=NULL,
                lease_expires_at=NULL,updated_at=NOW()
          WHERE workflow_id=$5 AND status IN ('running','suspended') AND ${ identitySql }
          RETURNING runner_id`,
        [...identityParams(identity), row.id],
      )).rows;
      await Promise.all(retired.map(async(run: any) => {
        if (!run.runner_id) return;
        try {
          await launcher.stopRunner(run.runner_id);
        } catch (error) {
          console.error(`[workflow-manager] could not stop archived workflow runner ${ run.runner_id }:`, error);
        }
      }));
    }
    cancelSchedules(identity);
    await refreshSchedules(identity);
    response.json(row);
  } catch (error) { next(error) }
});
app.post('/v1/runs', requireMutationRole, async(request: AuthenticatedRequest, response, next) => {
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
app.get('/v1/runs', requireOwner, async(request: AuthenticatedRequest, response, next) => {
  try {
    const limit = Math.min(200, Math.max(1, Number(request.query.limit ?? 100)));
    const rows = (await pool.query(
      `SELECT execution_id,workflow_id,workflow_name,status,runner_id,trigger_input,started_at,completed_at,error,
              wait_kind,resume_at,updated_at
         FROM workflow_executions WHERE ${ identitySql } ORDER BY started_at DESC LIMIT $5`,
      [...identityParams(request.identity!), limit],
    )).rows;
    response.json(rows);
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
app.post('/v1/runs/:id/stop', requireOwner, requireMutationRole, async(request: AuthenticatedRequest, response, next) => {
  try {
    const identity = request.identity!;
    const run = (await pool.query(
      `UPDATE workflow_executions SET status='failed',auto_restart=FALSE,completed_at=COALESCE(completed_at,NOW()),
              terminal_at=COALESCE(terminal_at,NOW()),terminal_reason='user_cancelled',error=COALESCE(error,'user_cancelled'),
              owner_id=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=NOW()
        WHERE execution_id=$5 AND status IN ('running','suspended') AND ${ identitySql }
          AND EXISTS (SELECT 1 FROM workflows w WHERE w.id=workflow_executions.workflow_id AND w.location='desktop')
        RETURNING runner_id`,
      [...identityParams(identity), request.params.id],
    )).rows[0];
    if (!run) return response.status(409).json({ error: 'run is not active or was not found' });
    if (run.runner_id) await launcher.stopRunner(run.runner_id);
    response.status(202).json({ accepted: true });
  } catch (error) { next(error) }
});
app.post('/v1/runs/:id/resume', requireOwner, requireMutationRole, async(request: AuthenticatedRequest, response, next) => {
  try {
    const executionId = request.params.id;
    if (typeof executionId !== 'string' || !executionId || executionId.length > 300 || executionId.trim() !== executionId) {
      return response.status(400).json({ error: 'invalid execution id' });
    }
    const row = (await pool.query(
      `SELECT * FROM workflow_executions
       WHERE execution_id=$5
         AND NOT EXISTS (
           SELECT 1 FROM workflows
            WHERE workflows.id=workflow_executions.workflow_id AND workflows.status='archive'
         )
         AND ${ identitySql }
         AND EXISTS (SELECT 1 FROM workflows w WHERE w.id=workflow_executions.workflow_id AND w.location='desktop')`,
      [...identityParams(request.identity!), executionId],
    )).rows[0];
    if (!row) return response.status(404).json({ error: 'run not found' });
    let state = row.playbook_state as WorkflowPlaybookState;
    if (row.wait_kind === 'user-input' && state.pendingDecision) state = resolveDecision(state, String(request.body.input ?? '')).updatedPlaybook;
    const resumed = await pool.query(
      `UPDATE workflow_executions
          SET playbook_state=$2::jsonb,resume_input=NULL,status='running',updated_at=NOW()
        WHERE execution_id=$1 AND status IN ('running','suspended')
          AND EXISTS (SELECT 1 FROM workflows WHERE workflows.id=workflow_executions.workflow_id AND workflows.location='desktop' AND workflows.status <> 'archive')
        RETURNING execution_id`,
      [executionId, JSON.stringify(state)],
    );
    if (!resumed.rowCount) return response.status(409).json({ error: 'run is no longer resumable' });
    response.status(202).json({ executionId, runnerId: await launch(executionId) });
  } catch (error) { next(error) }
});
app.post('/v1/runs/:id/restart', requireOwner, requireMutationRole, async(request: AuthenticatedRequest, response, next) => {
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
app.post('/v1/schedules/refresh', requireOwner, requireMutationRole, async(request: AuthenticatedRequest, response, next) => {
  try {
    const identity = request.identity!;
    response.json({ schedules: await refreshSchedules(identity) });
  } catch (error) { next(error) }
});
app.post('/v1/schedules/catch-up', requireOwner, requireMutationRole, async(request: AuthenticatedRequest, response, next) => {
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
  if (error instanceof WorkflowConcurrencyLimitError) {
    response.status(409).json({ error: error.message, code: 'concurrency_limit', activeExecutions: error.activeExecutionIds });
    return;
  }
  console.error('[workflow-manager]', error);
  response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
});

async function resumeDueRuns(): Promise<void> {
  if (!schedulerLeader) return;
  const due = (await pool.query(
    `SELECT e.execution_id FROM workflow_executions e
     JOIN workflows w ON w.id=e.workflow_id
     WHERE e.status='suspended' AND e.resume_at IS NOT NULL AND e.resume_at <= NOW()
       AND w.location='desktop' AND w.status <> 'archive'
       AND e.owner_issuer IS NOT NULL AND e.owner_subject IS NOT NULL
     FOR UPDATE SKIP LOCKED`,
  )).rows;
  for (const row of due) {
    try {
      const current = (await pool.query(
        `SELECT w.*,e.execution_id,e.workflow_id,e.wait_payload
           FROM workflow_executions e JOIN workflows w ON w.id=e.workflow_id
          WHERE e.execution_id=$1`,
        [row.execution_id],
      )).rows[0];
      if (current?.wait_payload?.nodeId) {
        await emitEvent(row.execution_id, current.workflow_id, 'node_completed', { output: 'wait elapsed' }, current.wait_payload.nodeId);
      }
      await launch(row.execution_id);
    } catch (error) {
      await pool.query(
        `UPDATE workflow_executions SET resume_at=NOW() + INTERVAL '5 minutes',updated_at=NOW()
          WHERE execution_id=$1 AND status IN ('running','suspended')`,
        [row.execution_id],
      );
      console.error('[workflow-manager] wait resume failed closed; retry delayed:', error);
    }
  }
}

async function establishLegacyOwnership(): Promise<void> {
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
  await new StartupDatabaseWait({ name: 'workflow-manager' }).until('connect', () => pool.query('SELECT 1'));
  await migrate();
  await establishLegacyOwnership();
  const reconciled = await abandonedRuns.reap();
  if (reconciled.length) console.warn(`[workflow-manager] Settled ${ reconciled.length } abandoned workflow run(s) at startup`);
  const lockClient = await pool.connect();
  lockClient.on('error', (error) => {
    if (schedulerLeader) guard.fatal('scheduler lock connection lost', error);
    else console.warn('[workflow-manager] idle scheduler lock connection lost:', error.message);
  });
  schedulerLeader = (await lockClient.query(`SELECT pg_try_advisory_lock(hashtext('sulla-workflow-manager')) AS acquired`)).rows[0].acquired === true;
  if (!schedulerLeader) console.warn('[workflow-manager] Another manager owns triggers; API remains healthy without scheduling');
  await refreshSchedules();
  setInterval(() => resumeDueRuns().catch(error => console.error('[workflow-manager] wait scan failed:', error)), 1_000).unref();
  setInterval(() => abandonedRuns.reap().catch(error => console.error('[workflow-manager] runner reconciliation failed:', error)), 5_000).unref();
  const server = app.listen(config.port, '0.0.0.0', () => console.log(`[workflow-manager] listening on :${ config.port }; schedulerLeader=${ schedulerLeader }`));
  guard.handleSignals(async() => {
    server.closeIdleConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    lockClient.release();
    await closeDb();
  });
}

main().catch(error => guard.fatal('startup failed', error));
