// Copyright © 2026 Merchant Protocol, LLC. All rights reserved.
// Licensed under the Sulla Fair-Code License. See LICENSE.

import { randomUUID } from 'node:crypto';

import { Router, type Request, type Response } from 'express';

import { forwardedWebHeaders } from './clients/accounts.js';
import type { UpstreamClients } from './clients/index.js';
import { UpstreamError } from './clients/upstream.js';
import type { ConsoleConfig } from './config.js';
import type { Database } from './db.js';
import { envelope } from './envelope.js';
import { LicenseError, ServerLicenseManager } from './license.js';
import { isServerAdmin, requireOrganization } from './orgScope.js';

export interface RouteContext { db: Database; clients: UpstreamClients; config: ConsoleConfig; license: ServerLicenseManager }
type Handler = (request: Request, response: Response) => Promise<unknown>;
const route = (handler: Handler) => (request: Request, response: Response, next: (error?: unknown) => void) => void handler(request, response).catch(next);

function session(request: Request) {
  if (!request.consoleSession) throw Object.assign(new Error('authentication_required'), { status: 401 });
  return request.consoleSession;
}

function requestedOrg(request: Request): string {
  const value = request.query.team ?? request.body?.organizationId ?? request.body?.teamId ?? request.params.id;
  if (typeof value !== 'string' || !value) throw Object.assign(new Error('organization_required'), { status: 400 });
  requireOrganization(session(request), value);
  return value;
}

function webInit(request: Request, method = request.method): RequestInit {
  const headers = forwardedWebHeaders(request);
  if (!['GET', 'HEAD'].includes(method) && request.body !== undefined) headers.set('content-type', 'application/json');
  return { method, headers, body: !['GET', 'HEAD'].includes(method) ? JSON.stringify(request.body ?? {}) : undefined };
}

async function uiToken(request: Request, clients: UpstreamClients, service: string, audience: string, organizationId: string): Promise<string> {
  const result = await clients.accounts.request<{ token: string }>('/v1/web/ui-sessions', {
    method: 'POST', headers: new Headers({ ...Object.fromEntries(forwardedWebHeaders(request)), 'content-type': 'application/json' }),
    body: JSON.stringify({ service, audience, organizationId }),
  });
  return result.token;
}

async function serviceJson(request: Request, clients: UpstreamClients, service: keyof Omit<UpstreamClients, 'accounts'>, audience: string, organizationId: string, path: string, method = request.method) {
  const token = await uiToken(request, clients, service, audience, organizationId);
  const headers = new Headers({ authorization: `Bearer ${token}`, 'x-sulla-organization-id': organizationId });
  if (!['GET', 'HEAD'].includes(method)) headers.set('content-type', 'application/json');
  return clients[service].request(path, { method, headers, body: !['GET', 'HEAD'].includes(method) ? JSON.stringify(request.body ?? {}) : undefined });
}

async function audit(db: Database, request: Request, organizationId: string | null, kind: string, details: Record<string, unknown> = {}) {
  const identity = session(request).identity;
  await db.query('INSERT INTO sulla_console.audit_events(id,organization_id,issuer,subject,kind,details) VALUES($1,$2,$3,$4,$5,$6)', [randomUUID(), organizationId, identity.issuer, identity.subject, kind, details]);
}

export function createRouteRegistry(context: RouteContext): Router {
  const { db, clients, config, license } = context;
  const router = Router();

  router.get('/auth/me', route(async(request, response) => {
    const current = session(request);
    const prefs = await db.query('SELECT active_org,timezone,colour FROM sulla_console.user_prefs WHERE issuer=$1 AND subject=$2', [current.identity.issuer, current.identity.subject]);
    const activeTeamId = prefs.rows[0]?.active_org ?? current.organizations[0]?.id ?? null;
    response.json({ contractor: { id: current.identity.subject, activeTeamId, memberships: current.organizations, isServerAdmin: isServerAdmin(current), timezone: prefs.rows[0]?.timezone, colour: prefs.rows[0]?.colour } });
  }));
  router.post('/auth/switch-team', route(async(request, response) => {
    const current = session(request); const organizationId = String(request.body?.teamId ?? request.body?.organizationId ?? ''); requireOrganization(current, organizationId);
    await db.query(`INSERT INTO sulla_console.user_prefs(issuer,subject,active_org) VALUES($1,$2,$3) ON CONFLICT(issuer,subject) DO UPDATE SET active_org=excluded.active_org,updated_at=now()`, [current.identity.issuer, current.identity.subject, organizationId]);
    response.json({ activeTeamId: organizationId });
  }));
  router.post('/auth/logout', route(async(request, response) => { const value = await clients.accounts.request('/v1/web/logout', webInit(request)); response.json(value); }));

  router.get('/teams', route(async(request, response) => {
    const data = await clients.accounts.request<{ organizations: unknown[] }>('/v1/web/organizations', webInit(request)); response.json(data.organizations);
  }));
  router.post('/teams', route(async(request, response) => {
    if (!isServerAdmin(session(request))) throw Object.assign(new Error('server_admin_required'), { status: 403 });
    response.status(201).json(await clients.accounts.request('/v1/web/organizations', webInit(request)));
  }));
  router.get('/teams/:id', route(async(request, response) => { const id = request.params.id; requireOrganization(session(request), id); response.json(await clients.accounts.request(`/v1/web/overview?organizationId=${encodeURIComponent(id)}`, webInit(request))); }));
  router.patch('/teams/:id', route(async(request, response) => { const id = request.params.id; requireOrganization(session(request), id); response.json(await clients.accounts.request(`/v1/web/organizations/${id}`, webInit(request))); }));
  router.get('/teams/:id/members', route(async(request, response) => { const id = request.params.id; requireOrganization(session(request), id); response.json(await clients.accounts.request(`/v1/web/users?organizationId=${encodeURIComponent(id)}`, webInit(request))); }));
  router.patch('/teams/:id/members/:userId', route(async(request, response) => { requireOrganization(session(request), request.params.id); response.json(await clients.accounts.request(`/v1/web/users/${encodeURIComponent(request.params.userId)}`, webInit(request))); }));
  router.delete('/teams/:id/members/:userId', route(async(request, response) => { const id = request.params.id; requireOrganization(session(request), id); response.json(await clients.accounts.request(`/v1/web/memberships/${encodeURIComponent(request.params.userId)}?organizationId=${encodeURIComponent(id)}`, webInit(request))); }));
  for (const method of ['get', 'post'] as const) router[method]('/teams/:id/invitations', route(async(request, response) => {
    const id = request.params.id; requireOrganization(session(request), id);
    response.json(await clients.accounts.request(`/v1/web/invitations?organizationId=${encodeURIComponent(id)}`, webInit(request)));
  }));
  router.delete('/teams/:id/invitations/:invitationId', route(async(request, response) => {
    const id = request.params.id; requireOrganization(session(request), id);
    response.json(await clients.accounts.request(`/v1/web/invitations/${encodeURIComponent(request.params.invitationId)}?organizationId=${encodeURIComponent(id)}`, webInit(request)));
  }));

  router.get('/cloud-dashboard/v1/organizations', route(async(request, response) => response.json(envelope(requestedOrg(request), { organizations: session(request).organizations }))));
  router.get('/cloud-dashboard/v1/summary', route(async(request, response) => {
    const org = requestedOrg(request); const [files, agents, workflows] = await Promise.all([
      serviceJson(request, clients, 'files', 'sulla-files', org, '/v1/files').catch(() => []),
      serviceJson(request, clients, 'agents', 'sulla-agents', org, '/v1/runs').catch(() => []),
      serviceJson(request, clients, 'workflows', 'sulla-workflows', org, '/v1/workflows').catch(() => []),
    ]); response.json(envelope(org, { files, agents, workflows }));
  }));
  router.get('/cloud-dashboard/v1/devices', route(async(request, response) => { const org = requestedOrg(request); response.json(envelope(org, await clients.accounts.admin(`/devices?organizationId=${encodeURIComponent(org)}`))); }));

  router.use('/cloud-files/v1', route(async(request, response) => {
    const org = requestedOrg(request); const suffix = request.originalUrl.slice(request.originalUrl.indexOf('/cloud-files/v1') + '/cloud-files/v1'.length).replace(/([?&])team=[^&]*&?/, '$1').replace(/[?&]$/, '');
    response.json(await serviceJson(request, clients, 'files', 'sulla-files', org, `/v1${suffix || '/files'}`));
  }));
  router.use('/cloud-runtime/v1', route(async(request, response) => {
    const org = requestedOrg(request); const suffix = request.originalUrl.slice(request.originalUrl.indexOf('/cloud-runtime/v1') + '/cloud-runtime/v1'.length).replace(/([?&])team=[^&]*&?/, '$1').replace(/[?&]$/, '');
    const service: 'workflows' | 'agents' = suffix.startsWith('/workflow') ? 'workflows' : 'agents'; const audience = service === 'workflows' ? 'sulla-workflows' : 'sulla-agents';
    response.json(envelope(org, await serviceJson(request, clients, service, audience, org, `/v1${suffix}`)));
  }));
  router.post('/routines/:id/execute', route(async(request, response) => { const org = requestedOrg(request); response.status(201).json(await serviceJson(request, clients, 'workflows', 'sulla-workflows', org, '/v1/runs', 'POST')); }));

  router.get('/chat/conversations', route(async(request, response) => {
    const org = requestedOrg(request); const identity = session(request).identity;
    const found = await db.query('SELECT * FROM sulla_console.conversations WHERE organization_id=$1 AND issuer=$2 AND subject=$3 ORDER BY updated_at DESC', [org, identity.issuer, identity.subject]); response.json(envelope(org, found.rows));
  }));
  router.post('/chat/conversations', route(async(request, response) => {
    const org = requestedOrg(request); const identity = session(request).identity; const id = randomUUID();
    const found = await db.query('INSERT INTO sulla_console.conversations(id,organization_id,issuer,subject,title) VALUES($1,$2,$3,$4,$5) RETURNING *', [id, org, identity.issuer, identity.subject, String(request.body?.title ?? 'New chat').slice(0, 200)]); response.status(201).json(envelope(org, found.rows[0]));
  }));
  router.get('/chat/conversations/:conversationId/messages', route(async(request, response) => {
    const org = requestedOrg(request); const identity = session(request).identity;
    const found = await db.query(`SELECT m.* FROM sulla_console.messages m JOIN sulla_console.conversations c ON c.id=m.conversation_id WHERE c.id=$1 AND c.organization_id=$2 AND c.issuer=$3 AND c.subject=$4 ORDER BY m.created_at`, [request.params.conversationId, org, identity.issuer, identity.subject]); response.json(envelope(org, found.rows));
  }));
  router.post('/chat/conversations/:conversationId/messages', route(async(request, response) => {
    const org = requestedOrg(request); const identity = session(request).identity; const id = randomUUID();
    const found = await db.query(`INSERT INTO sulla_console.messages(id,conversation_id,role,content) SELECT $1,c.id,$2,$3 FROM sulla_console.conversations c WHERE c.id=$4 AND c.organization_id=$5 AND c.issuer=$6 AND c.subject=$7 RETURNING *`, [id, request.body?.role ?? 'user', String(request.body?.content ?? ''), request.params.conversationId, org, identity.issuer, identity.subject]);
    if (!found.rowCount) throw Object.assign(new Error('conversation_not_found'), { status: 404 }); response.status(201).json(envelope(org, found.rows[0]));
  }));
  router.post('/chat/conversations/:conversationId/run', route(async(request, response) => { const org = requestedOrg(request); response.status(202).json(await serviceJson(request, clients, 'agents', 'sulla-agents', org, '/v1/runs', 'POST')); }));

  router.get('/cloud-vault-sync/status', route(async(request, response) => { const org = requestedOrg(request); response.json(await serviceJson(request, clients, 'vault', 'sulla-vault', org, '/cloud-vault-sync/status')); }));
  router.post('/cloud-vault-sync/browser/handoff', route(async(request, response) => { const org = requestedOrg(request); response.json(await serviceJson(request, clients, 'vault', 'sulla-vault', org, '/cloud-vault-sync/browser/handoff', 'POST')); }));

  for (const method of ['patch', 'delete'] as const) router[method]('/devices/:deviceId', route(async(request, response) => {
    const org = requestedOrg(request);
    response.json(await clients.accounts.admin(`/devices/${encodeURIComponent(request.params.deviceId)}?organizationId=${encodeURIComponent(org)}`, webInit(request)));
  }));

  router.patch('/chat/conversations/:conversationId', route(async(request, response) => {
    const org = requestedOrg(request); const identity = session(request).identity;
    const found = await db.query(`UPDATE sulla_console.conversations SET title=$1,updated_at=now() WHERE id=$2 AND organization_id=$3 AND issuer=$4 AND subject=$5 RETURNING *`, [String(request.body?.title ?? '').slice(0, 200), request.params.conversationId, org, identity.issuer, identity.subject]);
    if (!found.rowCount) throw Object.assign(new Error('conversation_not_found'), { status: 404 }); response.json(envelope(org, found.rows[0]));
  }));
  router.delete('/chat/conversations/:conversationId', route(async(request, response) => {
    const org = requestedOrg(request); const identity = session(request).identity;
    const found = await db.query('DELETE FROM sulla_console.conversations WHERE id=$1 AND organization_id=$2 AND issuer=$3 AND subject=$4', [request.params.conversationId, org, identity.issuer, identity.subject]);
    if (!found.rowCount) throw Object.assign(new Error('conversation_not_found'), { status: 404 }); response.status(204).end();
  }));

  router.get('/usage/tokens', route(async(request, response) => {
    const org = requestedOrg(request); const days = Math.min(366, Math.max(1, Number(request.query.period ?? 30) || 30));
    const found = await db.query(`SELECT date_trunc('day',created_at) AS day,source,model,provider,sum(input_tokens)::bigint AS input_tokens,sum(output_tokens)::bigint AS output_tokens FROM sulla_console.usage_events WHERE organization_id=$1 AND created_at >= now()-($2::text || ' days')::interval GROUP BY 1,2,3,4 ORDER BY 1`, [org, days]);
    response.json(envelope(org, found.rows));
  }));
  router.get('/usage/summary', route(async(request, response) => {
    const org = requestedOrg(request); const found = await db.query('SELECT count(*)::int AS runs,coalesce(sum(duration_ms),0)::bigint AS duration_ms,coalesce(sum(input_tokens+output_tokens),0)::bigint AS tokens FROM sulla_console.usage_events WHERE organization_id=$1', [org]); response.json(envelope(org, found.rows[0]));
  }));
  router.get('/usage/token-caps', route(async(request, response) => { const org = requestedOrg(request); const found = await db.query('SELECT * FROM sulla_console.usage_settings WHERE organization_id=$1', [org]); response.json(envelope(org, found.rows[0] ?? { organization_id: org, monthly_token_cap: null, action: 'block' })); }));
  router.get('/usage/settings', route(async(request, response) => { const org = requestedOrg(request); const found = await db.query('SELECT * FROM sulla_console.usage_settings WHERE organization_id=$1', [org]); response.json(envelope(org, found.rows[0] ?? { organization_id: org, monthly_token_cap: null, action: 'block' })); }));
  router.put('/usage/settings', route(async(request, response) => {
    const org = requestedOrg(request); const found = await db.query(`INSERT INTO sulla_console.usage_settings(organization_id,monthly_token_cap,action) VALUES($1,$2,$3) ON CONFLICT(organization_id) DO UPDATE SET monthly_token_cap=excluded.monthly_token_cap,action=excluded.action,updated_at=now() RETURNING *`, [org, request.body?.monthlyTokenCap ?? null, request.body?.action ?? 'block']); response.json(envelope(org, found.rows[0]));
  }));

  router.use('/marketplace', route(async(request, response) => {
    const org = requestedOrg(request); const suffix = request.originalUrl.slice(request.originalUrl.indexOf('/marketplace')).replace(/([?&])team=[^&]*&?/, '$1').replace(/[?&]$/, '');
    if (suffix.startsWith('/marketplace/mine') || suffix.startsWith('/marketplace/submit-manifest')) throw Object.assign(new Error('not_found'), { status: 404 });
    const upstream = await license.cloudRequest(suffix, { method: request.method, headers: request.body === undefined ? undefined : { 'content-type': 'application/json' }, body: ['GET','HEAD'].includes(request.method) ? undefined : JSON.stringify(request.body ?? {}) });
    const body = await upstream.json().catch(() => ({})); if (!upstream.ok) throw new UpstreamError(upstream.status, body); response.status(upstream.status).json(envelope(org, body));
  }));
  router.get('/cloud-usecase-installs/v1/library', route(async(request, response) => { const org = requestedOrg(request); const found = await db.query('SELECT * FROM sulla_console.usecase_installs WHERE organization_id=$1 ORDER BY installed_at DESC', [org]); response.json(envelope(org, found.rows)); }));
  router.get('/cloud-usecase-installs/v1/templates/:templateId/installs', route(async(request, response) => { const org = requestedOrg(request); const found = await db.query('SELECT * FROM sulla_console.usecase_installs WHERE organization_id=$1 AND template_id=$2', [org, request.params.templateId]); response.json(envelope(org, found.rows)); }));
  router.get('/cloud-usecase-installs/v1/templates/:templateId/review', route(async(request, response) => { const org = requestedOrg(request); response.json(envelope(org, { templateId: request.params.templateId, targets: String(request.query.targets ?? 'server').split(','), installable: license.status().catalogAllowed })); }));

  router.get('/server/v1/license', route(async(request, response) => { if (!isServerAdmin(session(request))) throw Object.assign(new Error('server_admin_required'), { status: 403 }); await license.evaluate(); response.json(license.status()); }));
  router.post('/server/v1/license', route(async(request, response) => {
    if (!isServerAdmin(session(request))) throw Object.assign(new Error('server_admin_required'), { status: 403 });
    const status = await license.activate(String(request.body?.licenseKey ?? ''));
    await clients.accounts.admin('/limits', { method: 'PUT', body: JSON.stringify({ seatLimit: status.seats }), headers: { 'content-type': 'application/json' } });
    await audit(db, request, null, 'license.activate', { fingerprint: status.masked, edition: status.edition, seats: status.seats }); void license.checkIn({ force: true }); response.json(status);
  }));

  return router;
}

export function consoleError(error: unknown, _request: Request, response: Response): void {
  if (error instanceof LicenseError) { response.status(422).json({ error: error.code, message: error.message }); return; }
  const status = typeof error === 'object' && error && 'status' in error ? Number((error as { status: unknown }).status) : error instanceof UpstreamError ? error.status : 500;
  response.status(status >= 400 && status < 600 ? status : 500).json({ error: error instanceof Error ? error.message : 'internal_error' });
}
