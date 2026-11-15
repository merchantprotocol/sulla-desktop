// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';

import {
  authenticateRequest,
  requireEditor,
  type AuthenticatedRequest,
  type RequestIdentity,
} from './auth.js';
import { config } from './config.js';
import { pool } from './db.js';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

const here = path.dirname(fileURLToPath(import.meta.url));
const uiRoot = path.resolve(here, '../../../../ui');
app.get('/healthz', async(_request, response) => {
  try { await pool.query('SELECT 1'); response.json({ ok: true, service: 'agents' }) }
  catch { response.status(503).json({ ok: false, service: 'agents' }) }
});
app.get(/^\/ui$/, (_request, response) => response.redirect(308, '/ui/'));
app.use('/ui', (_request, response, next) => {
  response.setHeader('Content-Security-Policy', "default-src 'self'; frame-ancestors 'self'; script-src 'self'; style-src 'self'"); next();
});
app.use('/ui', express.static(uiRoot, { index: 'index.html', fallthrough: false }));

const definitionColumns = `id,slug,name,description,system_prompt,soul_content,allowed_tools,skill_refs,routine_refs,
  model_priority,version,status,enabled,config,prompt_content,goals_content,provider,model,source_kind,
  when_to_call,when_not_to_call,send,returns,cost_tier,can_call,front_door,is_builtin,run_location,created_at,updated_at`;
function allowedTools(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > 100) return null;
  const tools = value.map(tool => typeof tool === 'string' ? tool.trim() : '');
  if (tools.some(tool => !/^[a-z][a-z0-9_-]{0,63}\/(?:[a-z][a-z0-9_-]{0,95}|\*)$/.test(tool))) return null;
  return [...new Set(tools)];
}

function canManageToolGrants(identity: RequestIdentity): boolean {
  return identity.roles.some(role => role === 'owner' || role === 'admin');
}

app.use('/v1', authenticateRequest);

app.get('/v1/agents', async(request: AuthenticatedRequest, response, next) => {
  try { response.json((await pool.query(`SELECT ${ definitionColumns } FROM agent_definitions ORDER BY name,slug`)).rows) }
  catch (error) { next(error) }
});
app.get('/v1/agents/:id', async(request: AuthenticatedRequest, response, next) => {
  try {
    const row = (await pool.query(`SELECT ${ definitionColumns } FROM agent_definitions WHERE id=$1 OR slug=$1 LIMIT 1`, [request.params.id])).rows[0];
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
    const row = (await pool.query(
      `INSERT INTO agent_definitions(id,slug,name,description,system_prompt,prompt_content,prompt_files,provider,model,status,enabled,source_kind,run_location,allowed_tools)
       VALUES($1,$2,$3,$4,$5::text,$5::text,jsonb_build_object('prompt.md',$5::text),$6,$7,$8,$9,'local',$10,$11) RETURNING ${ definitionColumns }`, values,
    )).rows[0];
    response.status(201).json(row);
  } catch (error) { next(error) }
});
app.patch('/v1/agents/:id', requireEditor, async(request: AuthenticatedRequest, response, next) => {
  try {
    const current = (await pool.query(`SELECT * FROM agent_definitions WHERE id=$1 OR slug=$1 LIMIT 1`, [request.params.id])).rows[0];
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
      `UPDATE agent_definitions SET name=$2,description=$3,provider=$4,model=$5,system_prompt=$6,prompt_content=$6,
       prompt_files=jsonb_set(COALESCE(prompt_files,'{}'::jsonb),'{prompt.md}',to_jsonb($6::text)),status=$7,enabled=$8,run_location=$9,allowed_tools=$10,updated_at=NOW()
       WHERE id=$1 RETURNING ${ definitionColumns }`,
      [current.id, body.name === undefined ? current.name : String(body.name).trim(), body.description === undefined ? current.description : String(body.description),
        body.provider === undefined ? current.provider : (body.provider || null), body.model === undefined ? current.model : (body.model || null),
        prompt, status, body.enabled === undefined ? current.enabled : body.enabled === true, runLocation, toolGrants,
      ],
    )).rows[0];
    response.json(row);
  } catch (error) { next(error) }
});

app.use((error: any, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  console.error('[agents-service]', error instanceof Error ? error.message : error);
  const status = Number(error?.status) || (String(error?.message).includes('duplicate key') ? 409 : 500);
  const publicMessage = status === 404 ? 'resource not found' : status === 409 ? 'resource state conflict' : 'request failed';
  response.status(status).json({ error: publicMessage });
});

async function main(): Promise<void> {
  app.listen(config.port, '0.0.0.0', () => console.log(`[agents-service] listening on :${ config.port }`));
}

main().catch(error => { console.error('[agents-service] fatal', error); process.exitCode = 1 });
