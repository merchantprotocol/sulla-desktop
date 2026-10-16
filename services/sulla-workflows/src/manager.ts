import crypto from 'node:crypto';

import cronParser from 'cron-parser';
import express from 'express';
import schedule from 'node-schedule';

import { createPlaybookState, resolveDecision } from '../../../pkg/rancher-desktop/agent/workflow/WorkflowPlaybook.js';
import type { WorkflowPlaybookState } from '../../../pkg/rancher-desktop/agent/workflow/types.js';

import { config } from './config.js';
import { migrate, pool } from './db.js';
import { emitEvent } from './events.js';
import { createWorkflowLauncher } from './launcher.js';

const app = express();
app.use(express.json({ limit: '10mb' }));

const launcher = createWorkflowLauncher();
const jobs = new Map<string, schedule.Job>();
let schedulerLeader = false;

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
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

async function issueRunToken(executionId: string, allowedTools: string[] = ['*']): Promise<string> {
  const token = crypto.randomBytes(32).toString('base64url');
  await pool.query(
    `INSERT INTO workflow_run_tokens (token_hash, execution_id, allowed_tools, expires_at)
     VALUES ($1, $2, $3::jsonb, NOW() + INTERVAL '24 hours')`,
    [hashToken(token), executionId, JSON.stringify(allowedTools)],
  );
  return token;
}

async function launch(executionId: string): Promise<string> {
  const run = (await pool.query('SELECT playbook_state FROM workflow_executions WHERE execution_id=$1', [executionId])).rows[0];
  const nodes = run?.playbook_state?.definition?.nodes ?? [];
  const allowedTools = new Set<string>(['spawn_agent', 'check_agent_jobs']);
  for (const node of nodes) {
    const toolName = node?.data?.config?.toolName;
    if (typeof toolName === 'string' && toolName) allowedTools.add(toolName);
    if (node?.data?.subtype === 'desktop-notification') allowedTools.add('notify_user');
  }
  const token = await issueRunToken(executionId, [...allowedTools]);
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
  workflowId: string;
  message?: string;
  triggerKey?: string;
  parentExecutionId?: string;
  playbookState?: WorkflowPlaybookState;
}): Promise<{ executionId: string; runnerId: string; deduplicated?: boolean }> {
  const workflowResult = await pool.query(
    `SELECT * FROM workflows
     WHERE (id = $1 OR definition->>'slug' = $1) AND enabled = TRUE AND location = 'desktop'
     LIMIT 1`,
    [params.workflowId],
  );
  const workflow = workflowResult.rows[0];
  if (!workflow) throw new Error(`Enabled desktop workflow "${ params.workflowId }" was not found`);

  const definition = workflow.definition;
  const state = params.playbookState ?? createPlaybookState(definition, params.message ?? '');
  const executionId = state.executionId;
  const inserted = await pool.query(
    `INSERT INTO workflow_executions
       (execution_id, workflow_id, workflow_name, workflow_slug, status, auto_restart,
        trigger_input, parent_execution_id, trigger_key, playbook_state, started_at, updated_at)
     VALUES ($1, $2, $3, $4, 'running', TRUE, $5, $6, $7, $8::jsonb, NOW(), NOW())
     ON CONFLICT (trigger_key) WHERE trigger_key IS NOT NULL DO NOTHING
     RETURNING execution_id`,
    [executionId, workflow.id, workflow.name, definition.slug ?? workflow.id, params.message ?? null,
      params.parentExecutionId ?? null, params.triggerKey ?? null, JSON.stringify(state)],
  );
  if (inserted.rowCount === 0 && params.triggerKey) {
    const existing = await pool.query('SELECT execution_id, runner_id FROM workflow_executions WHERE trigger_key = $1', [params.triggerKey]);
    return { executionId: existing.rows[0].execution_id, runnerId: existing.rows[0].runner_id, deduplicated: true };
  }
  await emitEvent(executionId, workflow.id, 'workflow_started', { workflowName: workflow.name });
  return { executionId, runnerId: await launch(executionId) };
}

async function refreshSchedules(): Promise<any[]> {
  for (const job of jobs.values()) job.cancel();
  jobs.clear();
  if (!schedulerLeader) return [];
  const rows = (await pool.query(
    `SELECT * FROM workflows WHERE status = 'production' AND enabled = TRUE AND location = 'desktop'`,
  )).rows;
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
          await startRun({ workflowId: workflow.id, message: `Scheduled trigger ${ node.data.label ?? node.id }`, triggerKey });
        } catch (error) {
          console.error(`[workflow-manager] Schedule ${ key } failed:`, error);
        }
      });
      if (job) {
        jobs.set(key, job);
        armed.push({ workflowId: workflow.id, workflowName: workflow.name, nodeId: node.id, cronExpression: cron, timezone, nextInvocation: job.nextInvocation()?.toISOString() ?? null });
      }
    }
  }
  return armed;
}

async function catchUp(dryRun = false, lookbackDays = 7): Promise<any> {
  const rows = (await pool.query(`SELECT * FROM workflows WHERE status = 'production' AND enabled = TRUE AND location = 'desktop'`)).rows;
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
      const exists = await pool.query('SELECT execution_id FROM workflow_executions WHERE trigger_key = $1', [key]);
      if (exists.rowCount) results.push({ workflowId: workflow.id, expectedAt: previous.toISOString(), status: 'already-fired' });
      else if (dryRun) results.push({ workflowId: workflow.id, expectedAt: previous.toISOString(), status: 'missed' });
      else results.push({ workflowId: workflow.id, expectedAt: previous.toISOString(), status: 'dispatched', ...(await startRun({ workflowId: workflow.id, message: `Catch-up for ${ previous.toISOString() }`, triggerKey: key })) });
    }
  }
  return results;
}

app.get('/healthz', (_request, response) => response.json({ ok: true, role: 'manager', schedulerLeader, schedules: jobs.size }));
app.get('/v1/workflows', async(_request, response, next) => {
  try {
    const rows = (await pool.query('SELECT id, name, description, status, enabled, location, system, definition, updated_at FROM workflows ORDER BY updated_at DESC')).rows;
    response.json(rows.map(row => ({
      id: row.id,
      name: row.name,
      description: row.description,
      status: row.status,
      enabled: row.enabled,
      location: row.location,
      system: row.system === true,
      nodeCount: Array.isArray(row.definition?.nodes) ? row.definition.nodes.length : 0,
      updatedAt: new Date(row.updated_at).toISOString(),
    })));
  } catch (error) { next(error); }
});
app.get('/v1/workflows/:id', async(request, response, next) => {
  try {
    const row = (await pool.query('SELECT * FROM workflows WHERE id = $1', [request.params.id])).rows[0];
    if (!row) return response.status(404).json({ error: 'workflow not found' });
    response.json(row);
  } catch (error) { next(error); }
});
app.put('/v1/workflows/:id', async(request, response, next) => {
  try {
    const workflow = request.body;
    const location = workflow.location === 'server' ? 'server' : 'desktop';
    const previous = (await pool.query('SELECT definition FROM workflows WHERE id=$1', [request.params.id])).rows[0]?.definition ?? null;
    const row = (await pool.query(
      `INSERT INTO workflows (id, name, description, version, status, definition, enabled, location)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)
       ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, description=EXCLUDED.description,
         version=EXCLUDED.version, status=EXCLUDED.status, definition=EXCLUDED.definition,
         enabled=EXCLUDED.enabled, location=EXCLUDED.location, updated_at=NOW()
       RETURNING *`,
      [request.params.id, workflow.name, workflow.description ?? null, workflow.version ?? null,
        workflow.status ?? 'draft', JSON.stringify(workflow.definition ?? workflow), workflow.enabled !== false, location],
    )).rows[0];
    await pool.query(
      `INSERT INTO workflow_history (workflow_id, definition_before, definition_after, changed_by, change_reason)
       VALUES ($1,$2::jsonb,$3::jsonb,'workflow-manager','manager API upsert')`,
      [request.params.id, previous ? JSON.stringify(previous) : null, JSON.stringify(workflow.definition ?? workflow)],
    );
    await refreshSchedules();
    response.json(row);
  } catch (error) { next(error); }
});
app.patch('/v1/workflows/:id/location', async(request, response, next) => {
  try {
    const location = request.body.location;
    if (!['desktop', 'server'].includes(location)) return response.status(400).json({ error: 'location must be desktop or server' });
    const row = (await pool.query('UPDATE workflows SET location=$2, updated_at=NOW() WHERE id=$1 RETURNING *', [request.params.id, location])).rows[0];
    await refreshSchedules();
    response.json(row);
  } catch (error) { next(error); }
});
app.post('/v1/runs', async(request, response, next) => {
  try { response.status(202).json(await startRun(request.body)); } catch (error) { next(error); }
});
app.get('/v1/runs/:id', async(request, response, next) => {
  try {
    const run = (await pool.query('SELECT * FROM workflow_executions WHERE execution_id=$1', [request.params.id])).rows[0];
    if (!run) return response.status(404).json({ error: 'run not found' });
    const events = (await pool.query('SELECT payload FROM workflow_execution_events WHERE execution_id=$1 ORDER BY id', [request.params.id])).rows.map(row => row.payload);
    response.json({ ...run, events });
  } catch (error) { next(error); }
});
app.post('/v1/runs/:id/resume', async(request, response, next) => {
  try {
    const row = (await pool.query('SELECT * FROM workflow_executions WHERE execution_id=$1', [request.params.id])).rows[0];
    if (!row) return response.status(404).json({ error: 'run not found' });
    let state = row.playbook_state as WorkflowPlaybookState;
    if (row.wait_kind === 'user-input' && state.pendingDecision) state = resolveDecision(state, String(request.body.input ?? '')).updatedPlaybook;
    await pool.query(`UPDATE workflow_executions SET playbook_state=$2::jsonb, resume_input=NULL, status='running', updated_at=NOW() WHERE execution_id=$1`, [request.params.id, JSON.stringify(state)]);
    response.status(202).json({ executionId: request.params.id, runnerId: await launch(request.params.id) });
  } catch (error) { next(error); }
});
app.post('/v1/runs/:id/restart', async(request, response, next) => {
  try {
    const checkpoint = (await pool.query(
      `SELECT playbook_state FROM workflow_checkpoints WHERE execution_id=$1
       AND ($2::text IS NULL OR node_id=$2) ORDER BY sequence DESC LIMIT 1`,
      [request.params.id, request.body.nodeId ?? null],
    )).rows[0];
    if (!checkpoint) return response.status(404).json({ error: 'checkpoint not found' });
    const state = checkpoint.playbook_state as WorkflowPlaybookState;
    state.executionId = `wfp-${ Date.now() }-${ crypto.randomBytes(3).toString('hex') }`;
    state.status = 'running';
    state.completedAt = undefined;
    response.status(202).json(await startRun({ workflowId: state.workflowId, message: 'Restarted from checkpoint', playbookState: state }));
  } catch (error) { next(error); }
});
app.post('/v1/schedules/refresh', async(_request, response, next) => {
  try { response.json({ schedules: await refreshSchedules() }); } catch (error) { next(error); }
});
app.post('/v1/schedules/catch-up', async(request, response, next) => {
  try { response.json({ results: await catchUp(request.body?.dryRun === true, Number(request.body?.lookbackDays ?? 7)) }); } catch (error) { next(error); }
});

app.post('/internal/tools/:category/:tool', async(request, response, next) => {
  try {
    const token = request.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '';
    const tokenRow = (await pool.query(
      'SELECT * FROM workflow_run_tokens WHERE token_hash=$1 AND expires_at > NOW()',
      [hashToken(token)],
    )).rows[0];
    if (!tokenRow) return response.status(401).json({ error: 'invalid or expired workflow run token' });
    const allowed = tokenRow.allowed_tools as string[];
    if (!allowed.includes('*') && !allowed.includes(request.params.tool)) return response.status(403).json({ error: 'tool is outside this run scope' });
    const upstream = await fetch(`${ config.toolApiUrl }/v1/tools/internal/${ encodeURIComponent(request.params.category) }/${ encodeURIComponent(request.params.tool) }/call`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ config.toolApiToken }`,
        'X-Sulla-Workflow-Execution': tokenRow.execution_id,
      },
      body: JSON.stringify(request.body ?? {}),
    });
    response.status(upstream.status).send(await upstream.text());
  } catch (error) { next(error); }
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
     FOR UPDATE SKIP LOCKED`,
  )).rows;
  for (const row of due) {
    try {
      const current = (await pool.query('SELECT workflow_id, wait_payload FROM workflow_executions WHERE execution_id=$1', [row.execution_id])).rows[0];
      if (current?.wait_payload?.nodeId) {
        await emitEvent(row.execution_id, current.workflow_id, 'node_completed', { output: 'wait elapsed' }, current.wait_payload.nodeId);
      }
      await launch(row.execution_id);
    } catch (error) { console.error('[workflow-manager] wait resume failed:', error); }
  }
}

async function main(): Promise<void> {
  await migrate();
  const lockClient = await pool.connect();
  schedulerLeader = (await lockClient.query(`SELECT pg_try_advisory_lock(hashtext('sulla-workflow-manager')) AS acquired`)).rows[0].acquired === true;
  if (!schedulerLeader) console.warn('[workflow-manager] Another manager owns triggers; API remains healthy without scheduling');
  await refreshSchedules();
  setInterval(() => void resumeDueRuns(), 1_000).unref();
  app.listen(config.port, '0.0.0.0', () => console.log(`[workflow-manager] listening on :${ config.port }; schedulerLeader=${ schedulerLeader }`));
}

void main().catch(error => {
  console.error('[workflow-manager] fatal:', error);
  process.exitCode = 1;
});
