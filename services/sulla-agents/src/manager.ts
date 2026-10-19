import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';

import {
  authenticateRequest,
  authenticateWorkflowService,
  requireEditor,
  tenantParams,
  tenantSql,
  type AuthenticatedRequest,
  type RequestIdentity,
  type WorkflowServiceRequest,
} from './auth.js';
import { config } from './config.js';
import { migrate, pool } from './db.js';
import { messageAgentRun, recoverRuns, startAgentRun, stopAgentRun } from './runtime.js';

const app = express();
app.disable('x-powered-by');
app.use(express.json({
  limit: '1mb',
  verify: (request, _response, buffer) => { (request as WorkflowServiceRequest).rawBody = Buffer.from(buffer) },
}));

const here = path.dirname(fileURLToPath(import.meta.url));
const uiRoot = path.resolve(here, '../../../../ui');
app.get('/healthz', async(_request, response) => {
  try { await pool.query('SELECT 1'); response.json({ ok: true, service: 'agents' }) }
  catch { response.status(503).json({ ok: false, service: 'agents' }) }
});
app.get('/ui', (_request, response) => response.redirect(308, '/ui/'));
app.use('/ui', (_request, response, next) => {
  response.setHeader('Content-Security-Policy', "default-src 'self'; frame-ancestors 'self'; script-src 'self'; style-src 'self'"); next();
});
app.use('/ui', express.static(uiRoot, { index: 'index.html', fallthrough: false }));

const definitionColumns = `id,slug,name,description,system_prompt,soul_content,allowed_tools,skill_refs,routine_refs,
  model_priority,version,status,enabled,config,prompt_content,goals_content,provider,model,source_kind,
  when_to_call,when_not_to_call,send,returns,cost_tier,can_call,front_door,is_builtin,run_location,created_at,updated_at`;
const definitionsTable = config.mode === 'server' ? 'service_agent_definitions' : 'agent_definitions';
function definitionTenant(identity: RequestIdentity): { clause: string; params: unknown[] } {
  return config.mode === 'server'
    ? { clause: 'authority_id=$1::uuid AND organization_id=$2::uuid', params: tenantParams(identity) }
    : { clause: 'TRUE', params: [] };
}

function allowedTools(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > 100) return null;
  const tools = value.map(tool => typeof tool === 'string' ? tool.trim() : '');
  if (tools.some(tool => !/^[a-z][a-z0-9_-]{0,63}\/(?:[a-z][a-z0-9_-]{0,95}|\*)$/.test(tool))) return null;
  return [...new Set(tools)];
}

function canManageToolGrants(identity: RequestIdentity): boolean {
  return identity.roles.some(role => role === 'owner' || role === 'admin');
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function boundedIdentity(value: unknown, max = 2_048): string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value ? value : '';
}

app.post('/internal/workflow-runs', authenticateWorkflowService, async(request, response, next) => {
  try {
    const body = request.body ?? {};
    const invocationId = boundedIdentity(body.invocationId, 36);
    const workflowExecutionId = boundedIdentity(body.workflowExecutionId, 300);
    const issuer = boundedIdentity(body.issuer);
    const subject = boundedIdentity(body.subject);
    const authorityId = boundedIdentity(body.authorityId, 36);
    const organizationId = boundedIdentity(body.organizationId, 36);
    const agentId = boundedIdentity(body.agentId, 300);
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    if (!UUID.test(invocationId) || !workflowExecutionId || !issuer || !subject || !UUID.test(authorityId) ||
        !UUID.test(organizationId) || !agentId || !prompt || prompt.length > 100_000) {
      return response.status(400).json({ error: 'invalid workflow agent invocation' });
    }
    const existing = (await pool.query(
      `SELECT id,status FROM server_agent_runs
        WHERE workflow_invocation_id=$1 AND workflow_execution_id=$2
          AND authority_id=$3::uuid AND organization_id=$4::uuid`,
      [invocationId, workflowExecutionId, authorityId, organizationId],
    )).rows[0];
    if (existing) return response.status(202).json(existing);
    const agent = (await pool.query(
      `SELECT * FROM service_agent_definitions
        WHERE authority_id=$1::uuid AND organization_id=$2::uuid AND (id=$3 OR slug=$3)
          AND enabled=TRUE AND status='production' LIMIT 1`,
      [authorityId, organizationId, agentId],
    )).rows[0];
    if (!agent) return response.status(404).json({ error: 'active production agent not found' });
    const identity: RequestIdentity = { issuer, subject, authorityId, organizationId, roles: [] };
    response.status(202).json(await startAgentRun(agent, prompt, identity, { executionId: workflowExecutionId, invocationId }));
  } catch (error: any) {
    if (String(error?.message).includes('duplicate key')) {
      const body = request.body ?? {};
      const row = (await pool.query(
        `SELECT id,status FROM server_agent_runs
          WHERE workflow_invocation_id=$1 AND workflow_execution_id=$2
            AND authority_id=$3::uuid AND organization_id=$4::uuid`,
        [body.invocationId, body.workflowExecutionId, body.authorityId, body.organizationId],
      )).rows[0];
      if (row) return response.status(202).json(row);
    }
    next(error);
  }
});

app.post('/internal/workflow-runs/status', authenticateWorkflowService, async(request, response, next) => {
  try {
    const body = request.body ?? {};
    const runId = boundedIdentity(body.runId, 300);
    const workflowExecutionId = boundedIdentity(body.workflowExecutionId, 300);
    const authorityId = boundedIdentity(body.authorityId, 36);
    const organizationId = boundedIdentity(body.organizationId, 36);
    if (!runId || !workflowExecutionId || !UUID.test(authorityId) || !UUID.test(organizationId)) {
      return response.status(400).json({ error: 'invalid workflow agent status request' });
    }
    const run = (await pool.query(
      `SELECT id,status,output,error FROM server_agent_runs
        WHERE id=$1 AND workflow_execution_id=$2
          AND authority_id=$3::uuid AND organization_id=$4::uuid`,
      [runId, workflowExecutionId, authorityId, organizationId],
    )).rows[0];
    if (!run) return response.status(404).json({ error: 'workflow agent run not found' });
    response.json(run);
  } catch (error) { next(error) }
});

app.use('/v1', authenticateRequest);

app.get('/v1/agents', async(request: AuthenticatedRequest, response, next) => {
  try { const scope = definitionTenant(request.identity!); response.json((await pool.query(`SELECT ${ definitionColumns } FROM ${ definitionsTable } WHERE ${ scope.clause } ORDER BY name,slug`, scope.params)).rows) }
  catch (error) { next(error) }
});
app.get('/v1/agents/:id', async(request: AuthenticatedRequest, response, next) => {
  try {
    const scope = definitionTenant(request.identity!); const idIndex = scope.params.length + 1;
    const row = (await pool.query(`SELECT ${ definitionColumns } FROM ${ definitionsTable } WHERE ${ scope.clause } AND (id=$${ idIndex } OR slug=$${ idIndex }) LIMIT 1`, [...scope.params, request.params.id])).rows[0];
    if (!row) return response.status(404).json({ error: 'agent not found' });
    response.json(row);
  } catch (error) { next(error) }
});
app.post('/v1/agents', requireEditor, async(request: AuthenticatedRequest, response, next) => {
  try {
    const body = request.body ?? {};
    const slug = String(body.slug ?? '').trim(); const name = String(body.name ?? '').trim();
    if (!/^[a-z0-9][a-z0-9-]{1,78}[a-z0-9]$/.test(slug) || !name) return response.status(400).json({ error: 'valid slug and name are required' });
    if (body.allowedTools !== undefined && !canManageToolGrants(request.identity!)) return response.status(403).json({ error: 'admin_role_required_for_tool_grants' });
    const toolGrants = allowedTools(body.allowedTools ?? []);
    if (!toolGrants) return response.status(400).json({ error: 'allowedTools must contain canonical category/tool grants' });
    const id = `agent-${ crypto.randomUUID() }`;
    const values = [id, slug, name, String(body.description ?? ''), String(body.prompt ?? ''), body.provider || null, body.model || null,
      ['draft','production','archive'].includes(body.status) ? body.status : 'draft', body.enabled !== false,
      body.runLocation === 'vm' ? 'vm' : 'container', toolGrants];
    const row = config.mode === 'server'
      ? (await pool.query(
        `INSERT INTO service_agent_definitions(id,slug,name,description,system_prompt,prompt_content,prompt_files,provider,model,status,enabled,source_kind,run_location,allowed_tools,owner_issuer,owner_subject,authority_id,organization_id)
         VALUES($1,$2,$3,$4,$5::text,$5::text,jsonb_build_object('prompt.md',$5::text),$6,$7,$8,$9,'local',$10,$11,$12,$13,$14,$15) RETURNING ${ definitionColumns }`,
        [...values, request.identity!.issuer, request.identity!.subject, ...tenantParams(request.identity!)],
      )).rows[0]
      : (await pool.query(
        `INSERT INTO agent_definitions(id,slug,name,description,system_prompt,prompt_content,prompt_files,provider,model,status,enabled,source_kind,run_location,allowed_tools)
         VALUES($1,$2,$3,$4,$5::text,$5::text,jsonb_build_object('prompt.md',$5::text),$6,$7,$8,$9,'local',$10,$11) RETURNING ${ definitionColumns }`, values,
      )).rows[0];
    response.status(201).json(row);
  } catch (error) { next(error) }
});
app.patch('/v1/agents/:id', requireEditor, async(request: AuthenticatedRequest, response, next) => {
  try {
    const scope = definitionTenant(request.identity!); const idIndex = scope.params.length + 1;
    const current = (await pool.query(`SELECT * FROM ${ definitionsTable } WHERE ${ scope.clause } AND (id=$${ idIndex } OR slug=$${ idIndex }) LIMIT 1`, [...scope.params, request.params.id])).rows[0];
    if (!current) return response.status(404).json({ error: 'agent not found' });
    const body = request.body ?? {};
    const status = body.status === undefined ? current.status : body.status;
    const runLocation = body.runLocation === undefined ? current.run_location : body.runLocation;
    if (!['draft','production','archive'].includes(status) || !['vm','container'].includes(runLocation)) return response.status(400).json({ error: 'invalid status or run location' });
    if (body.allowedTools !== undefined && !canManageToolGrants(request.identity!)) return response.status(403).json({ error: 'admin_role_required_for_tool_grants' });
    const toolGrants = body.allowedTools === undefined ? current.allowed_tools : allowedTools(body.allowedTools);
    if (!toolGrants) return response.status(400).json({ error: 'allowedTools must contain canonical category/tool grants' });
    const prompt = body.prompt === undefined ? current.prompt_content : String(body.prompt);
    const row = (await pool.query(
      `UPDATE ${ definitionsTable } SET name=$2,description=$3,provider=$4,model=$5,system_prompt=$6,prompt_content=$6,
       prompt_files=jsonb_set(COALESCE(prompt_files,'{}'::jsonb),'{prompt.md}',to_jsonb($6::text)),status=$7,enabled=$8,run_location=$9,allowed_tools=$10,updated_at=NOW()
       WHERE id=$1 ${ config.mode === 'server' ? 'AND authority_id=$11::uuid AND organization_id=$12::uuid' : '' } RETURNING ${ definitionColumns }`,
      [current.id, body.name === undefined ? current.name : String(body.name).trim(), body.description === undefined ? current.description : String(body.description),
        body.provider === undefined ? current.provider : (body.provider || null), body.model === undefined ? current.model : (body.model || null),
        prompt, status, body.enabled === undefined ? current.enabled : body.enabled === true, runLocation, toolGrants,
        ...(config.mode === 'server' ? tenantParams(request.identity!) : [])],
    )).rows[0];
    response.json(row);
  } catch (error) { next(error) }
});

app.get('/v1/runs', async(request: AuthenticatedRequest, response, next) => {
  try {
    const limit = Math.min(200, Math.max(1, Number(request.query.limit ?? 100)));
    response.json((await pool.query(`SELECT * FROM server_agent_runs WHERE ${ tenantSql } ORDER BY created_at DESC LIMIT $3`, [...tenantParams(request.identity!), limit])).rows);
  } catch (error) { next(error) }
});
app.get('/v1/runs/:id', async(request: AuthenticatedRequest, response, next) => {
  try {
    const row = (await pool.query(`SELECT * FROM server_agent_runs WHERE id=$3 AND ${ tenantSql }`, [...tenantParams(request.identity!), request.params.id])).rows[0];
    if (!row) return response.status(404).json({ error: 'run not found' }); response.json(row);
  } catch (error) { next(error) }
});
app.post('/v1/runs', requireEditor, async(request: AuthenticatedRequest, response, next) => {
  try {
    const agentId = String(request.body?.agentId ?? '').trim(); const prompt = String(request.body?.prompt ?? '').trim();
    if (!agentId || !prompt || prompt.length > 100_000) return response.status(400).json({ error: 'agentId and a bounded prompt are required' });
    const scope = definitionTenant(request.identity!); const idIndex = scope.params.length + 1;
    const agent = (await pool.query(`SELECT * FROM ${ definitionsTable } WHERE ${ scope.clause } AND (id=$${ idIndex } OR slug=$${ idIndex }) AND enabled=TRUE AND status='production' LIMIT 1`, [...scope.params, agentId])).rows[0];
    if (!agent) return response.status(404).json({ error: 'active production agent not found' });
    response.status(202).json(await startAgentRun(agent, prompt, request.identity!));
  } catch (error) { next(error) }
});
app.post('/v1/runs/:id/messages', requireEditor, async(request: AuthenticatedRequest, response, next) => {
  try {
    const message = String(request.body?.message ?? '').trim();
    if (!message || message.length > 20_000) return response.status(400).json({ error: 'bounded message is required' });
    await messageAgentRun(String(request.params.id), message, request.identity!); response.status(202).json({ accepted: true });
  } catch (error) { next(error) }
});
app.post('/v1/runs/:id/stop', requireEditor, async(request: AuthenticatedRequest, response, next) => {
  try { await stopAgentRun(String(request.params.id), request.identity!); response.status(202).json({ accepted: true }) }
  catch (error) { next(error) }
});

app.use((error: any, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  console.error('[agents-service]', error instanceof Error ? error.message : error);
  const status = Number(error?.status) || (String(error?.message).includes('duplicate key') ? 409 : 500);
  const publicMessage = status === 404 ? 'resource not found' : status === 409 ? 'resource state conflict' : 'request failed';
  response.status(status).json({ error: publicMessage });
});

async function main(): Promise<void> {
  await migrate(); await recoverRuns();
  app.listen(config.port, '0.0.0.0', () => console.log(`[agents-service] listening on :${ config.port }`));
}

main().catch(error => { console.error('[agents-service] fatal', error); process.exitCode = 1 });
