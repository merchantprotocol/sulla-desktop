import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { agentPolicyAllows, DEFAULT_AGENT_POLICY, DEFAULT_ARGON2ID, type AgentAccessLevel } from '@sulla/vault-crypto';
import express, { type NextFunction, type Response } from 'express';

import {
  authenticate,
  type AuthenticatedRequest,
  issueToken,
  makeLoginVerifier,
  verifyLoginHash,
} from './auth.js';
import { AccessDenied, getOrgRole, requireCollectionRight, requireOrgManager } from './rbac.js';
import { LocalVaultAuthority, LocalVaultError } from './localAuthority.js';

import type { VaultConfig } from './config.js';
import type { Database, Queryable } from './db.js';

const CONSOLE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Sulla Vault Console</title><style>
:root{color-scheme:light;--ink:#172033;--muted:#6b7788;--paper:#f5f8fb;--card:#fff;--line:#dce4ec;--accent:#5096b3;--danger:#b91c1c}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:14px system-ui,sans-serif}header{height:62px;background:#fff;border-bottom:1px solid var(--line);display:flex;align-items:center;padding:0 32px;gap:30px}header b{font:600 22px Georgia}nav{display:flex;gap:22px;color:var(--muted)}nav a{padding:22px 0;cursor:pointer}nav a.active{color:var(--ink);border-bottom:2px solid var(--accent)}main{max-width:1250px;margin:34px auto;padding:0 28px}.eyebrow{color:var(--accent);text-transform:uppercase;letter-spacing:.12em;font-size:11px}h1{font:600 34px Georgia;margin:4px 0}.lead{color:var(--muted)}.grid{display:grid;grid-template-columns:240px 1fr 270px;gap:18px;margin-top:24px}.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px;box-shadow:0 10px 30px #2030400b}.collection{padding:13px;border-radius:10px;margin:4px 0}.collection.active{background:#eaf4f7;color:#23627a}.collection small{display:block;color:var(--muted);margin-top:5px}table{width:100%;border-collapse:collapse;margin-top:16px}th,td{text-align:left;padding:13px 8px;border-top:1px solid var(--line)}th:not(:first-child),td:not(:first-child){text-align:center}.check{display:inline-grid;place-items:center;width:23px;height:23px;border-radius:7px;border:1px solid #aebdca}.check.on{background:var(--accent);border-color:var(--accent);color:white}.join{margin-top:24px;background:#eef7fa;border:1px solid #b6d9e4;border-radius:12px;padding:15px}.filters{display:flex;gap:8px;margin:20px 0}.chip,button{border:1px solid var(--line);background:white;border-radius:18px;padding:9px 14px;cursor:pointer}.chip.active,button.primary{background:var(--accent);color:white;border-color:var(--accent)}.audit{width:100%}.blocked{color:var(--danger);font-weight:600}.login{max-width:420px;margin:15vh auto}.login input{display:block;width:100%;padding:12px;border:1px solid var(--line);border-radius:8px;margin:10px 0}</style></head><body><header><b>Sulla <span style="color:var(--accent)">Vault</span></b><nav><a class="active" data-page="collections">Collections</a><a data-page="audit">Audit log</a><a data-page="people">People</a></nav><span style="margin-left:auto;color:var(--muted)">Encrypted in your browser · <span id="status">locked</span></span></header><main id="app"><section data-view="collections"><p class="eyebrow">Org vault</p><h1>Shared collections</h1><p class="lead">Share passwords with a team. Choose who can see them, and whose agents can use them.</p><div class="grid"><div class="card"><b>Collections</b><div class="collection active">Engineering<small>31 items · 18 agent-usable</small></div><div class="collection">Cloud &amp; deploy keys<small>14 items · 14 agent-usable</small></div><div class="collection">Support desk<small>9 items · 9 agent-usable</small></div><div class="collection">Finance<small>6 items · people only</small></div></div><div class="card"><h2>Engineering</h2><p class="lead">31 items · 18 agents can use</p><table><thead><tr><th>Person or group</th><th>View</th><th>Agents use</th><th>Edit</th><th>Manage</th></tr></thead><tbody><tr><td>Engineers · group</td><td><i class="check on">✓</i></td><td><i class="check on">✓</i></td><td><i class="check"></i></td><td><i class="check"></i></td></tr><tr><td>Jonathon Byrdziak · owner</td><td><i class="check on">✓</i></td><td><i class="check on">✓</i></td><td><i class="check on">✓</i></td><td><i class="check on">✓</i></td></tr><tr><td>Sam Ortiz · member</td><td><i class="check on">✓</i></td><td><i class="check"></i></td><td><i class="check"></i></td><td><i class="check"></i></td></tr></tbody></table><div class="join"><b>Join password</b><p class="lead">Rotate the organization password. Only a verifier is stored on the server.</p><button class="primary">Rotate password</button></div></div><div class="card"><b>People</b><p>Jonathon Byrdziak<br><small>Owner · 2 desktops</small></p><p>Maria Chen<br><small>Admin · 1 desktop</small></p><p>Sam Ortiz<br><small>Member · view only</small></p></div></div></section><section data-view="audit" hidden><p class="eyebrow">Org vault</p><h1>Audit log</h1><p class="lead">Every person and agent action. Secret values are never written here.</p><div class="filters"><span class="chip active">Everyone</span><span class="chip">People</span><span class="chip">Agents</span><span class="chip">Blocked only</span><input placeholder="Filter by person, item or collection"></div><div class="card"><table class="audit"><thead><tr><th>Actor</th><th>Action</th><th>Collection / item</th><th>When</th><th>Result</th></tr></thead><tbody><tr><td>Maria Chen</td><td>Viewed item</td><td>Engineering / Deploy key</td><td>Today, 09:42</td><td>Allowed</td></tr><tr><td>Sulla agent · Sam Ortiz</td><td>Agent use</td><td>Engineering / Deploy key</td><td>Today, 09:38</td><td class="blocked">Blocked</td></tr></tbody></table><div class="join" style="background:#fff5f5;border-color:#efc2c2"><b>Blocked reason</b><p>Sam can only view, so Sam's agent was blocked too.</p></div></div></section><section data-view="people" hidden><p class="eyebrow">Organization</p><h1>People &amp; groups</h1><div class="card"><h2>Members</h2><p>Owner and admin actions wrap organization and collection keys client-side. The server stores ciphertext only.</p><button class="primary">Invite member</button> <button>New group</button></div></section></main><script>for(const a of document.querySelectorAll('nav a'))a.onclick=()=>{document.querySelectorAll('nav a').forEach(x=>x.classList.remove('active'));a.classList.add('active');document.querySelectorAll('[data-view]').forEach(x=>x.hidden=x.dataset.view!==a.dataset.page)};</script></body></html>`;

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value) {
    throw new HttpError(400, `${ name } is required`);
  }
  return value;
}

function requiredObject(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, `${ name } is required`);
  }
  return value as Record<string, unknown>;
}

function sanitizedAuditMetadata(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const input = value as Record<string, unknown>;
  const metadata: Record<string, string> = {};
  for (const key of ['agentId', 'agentName', 'operation'] as const) {
    if (typeof input[key] === 'string' && input[key].length > 0 && input[key].length <= 160) metadata[key] = input[key];
  }
  if (typeof input.destination === 'string' && input.destination.length <= 2048) {
    try {
      const destination = new URL(input.destination);
      if (destination.protocol === 'https:' || destination.protocol === 'http:') metadata.destination = destination.origin;
    } catch {
      // Invalid destinations are omitted rather than copied into the immutable audit record.
    }
  }
  return metadata;
}

class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

const signupAttempts = new Map<string, { count: number; resetAt: number }>();
const JOIN_ATTEMPT_LIMIT = 10;
const JOIN_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

function enforceJoinAttemptLimit(ip: string, orgId: string): void {
  const key = `${ip}:${orgId}`;
  const now = Date.now();
  const current = signupAttempts.get(key);
  if (!current || current.resetAt <= now) {
    signupAttempts.set(key, { count: 1, resetAt: now + JOIN_ATTEMPT_WINDOW_MS });
    return;
  }
  if (current.count >= JOIN_ATTEMPT_LIMIT) throw new HttpError(429, 'Too many join attempts; try again later');
  current.count += 1;
}

async function auditEvent(db: Queryable, actorId: string, orgId: string, action: string, metadata: Record<string, unknown> = {}): Promise<void> {
  await db.query('INSERT INTO audit_log(actor_user_id, org_id, action, metadata) VALUES ($1, $2, $3, $4)', [actorId, orgId, action, metadata]);
}

async function auditPersonalItemEvent(db: Queryable, itemId: string, action: string): Promise<void> {
  await db.query(
    `INSERT INTO audit_log(actor_user_id,item_id,action,metadata)
     SELECT owner_user_id,id,$2,'{}'::jsonb FROM items WHERE id=$1 AND owner_user_id IS NOT NULL`,
    [itemId, action],
  );
}

function userId(request: AuthenticatedRequest): string {
  if (!request.auth) {
    throw new HttpError(401, 'Authentication required');
  }
  return request.auth.userId;
}

interface BrokerClaims {
  sub:                    string;
  org_id?:                string;
  agent_id:               string;
  pod_id:                 string;
  thread_id?:             string;
  job_id?:                string;
  workflow_execution_id?: string;
}

function brokerClaims(value: unknown): BrokerClaims {
  const claims = requiredObject(value, 'claims');
  return {
    sub:                    requiredString(claims.sub, 'claims.sub'),
    org_id:                 typeof claims.org_id === 'string' ? claims.org_id : undefined,
    agent_id:               requiredString(claims.agent_id, 'claims.agent_id'),
    pod_id:                 requiredString(claims.pod_id, 'claims.pod_id'),
    thread_id:              typeof claims.thread_id === 'string' ? claims.thread_id : undefined,
    job_id:                 typeof claims.job_id === 'string' ? claims.job_id : undefined,
    workflow_execution_id: typeof claims.workflow_execution_id === 'string' ? claims.workflow_execution_id : undefined,
  };
}

function safeTokenEqual(actual: string | undefined, expected: string | undefined): boolean {
  if (!actual || !expected) return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function authorizeItem(db: Database, actorId: string, itemId: string, right: 'view' | 'edit'): Promise<Record<string, unknown>> {
  const result = await db.query(
    `SELECT id, owner_user_id, collection_id, folder_id, item_type, ciphertext, encrypted_item_key,
            agent_wrapped_item_key, agent_policy, revision, created_at, updated_at
       FROM items WHERE id = $1 AND deleted_at IS NULL`,
    [itemId],
  );
  const item = result.rows[0];
  if (!item) {
    throw new HttpError(404, 'Item not found');
  }
  if (item.owner_user_id === actorId) {
    return item;
  }
  if (!item.collection_id) {
    throw new AccessDenied();
  }
  await requireCollectionRight(db, actorId, item.collection_id, right);
  return item;
}

async function authorizeItemFolder(
  db: Database,
  actorId: string,
  folderId: string,
  collectionId: string | null,
): Promise<void> {
  const folder = await db.query<{ owner_user_id: string | null; org_id: string | null }>(
    'SELECT owner_user_id, org_id FROM folders WHERE id = $1', [folderId],
  );
  const row = folder.rows[0];
  if (!row) throw new HttpError(400, 'Folder not found');
  if (row.owner_user_id === actorId && !collectionId) return;
  if (row.org_id && collectionId) {
    const collection = await db.query('SELECT 1 FROM collections WHERE id = $1 AND org_id = $2', [collectionId, row.org_id]);
    if (collection.rowCount) return;
  }
  throw new AccessDenied('Folder access denied');
}

export function createApp(db: Database, config: VaultConfig, options: { localAuthority?: LocalVaultAuthority } = {}) {
  const app = express();
  const localAuthority = config.mode === 'desktop' ? options.localAuthority ?? new LocalVaultAuthority(db, config) : null;
  app.disable('x-powered-by');
  app.use((request, response, next) => {
    const origin = request.header('origin');
    const allowed = Boolean(origin && (origin.startsWith('chrome-extension://') || config.extensionOrigins.includes(origin)));
    if (allowed) {
      response.setHeader('Access-Control-Allow-Origin', origin as string);
      response.setHeader('Vary', 'Origin');
      response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
      response.setHeader('Access-Control-Allow-Credentials', 'true');
    }
    if (request.method === 'OPTIONS') { response.status(allowed ? 204 : 403).end(); return; }
    next();
  });
  app.use(express.json({ limit: config.mode === 'desktop' ? '36mb' : '1mb' }));

  app.get('/healthz', async(_request, response) => {
    await db.query('SELECT 1');
    response.json({ ok: true, mode: config.mode });
  });

  const serviceIdentity = (request: express.Request): { serviceId: string; token?: string } => ({
    serviceId: request.header('x-sulla-service-id') ?? '',
    token: request.header('authorization')?.replace(/^Bearer\s+/i, ''),
  });
  const humanCookie = (request: express.Request): string | undefined =>
    request.header('cookie')?.split(';').map(value => value.trim()).find(value => value.startsWith('sulla_vault_human='))?.slice('sulla_vault_human='.length);
  const setHumanCookie = (response: Response, sessionId: string, expiresAt: number): void => {
    const maxAge = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
    const secure = config.humanUiOrigin?.startsWith('https:') ? '; Secure' : '';
    response.setHeader('Set-Cookie', `sulla_vault_human=${ sessionId }; HttpOnly; SameSite=Strict; Path=/v1/human; Max-Age=${ maxAge }${ secure }`);
  };

  if (localAuthority) {
    app.post('/v1/desktop/bootstrap/challenge', (request, response) => {
      response.json(localAuthority.createChallenge(
        requiredString(request.body.callerId, 'callerId'),
        requiredString(request.body.clientNonce, 'clientNonce'),
        requiredString(request.body.clientProof, 'clientProof'),
      ));
    });
    app.post('/v1/desktop/bootstrap/unlock', async(request, response) => {
      response.json(await localAuthority.unlock({
        callerId: requiredString(request.body.callerId, 'callerId'),
        challengeId: requiredString(request.body.challengeId, 'challengeId'),
        clientProof: requiredString(request.body.clientProof, 'clientProof'),
        sealedUnlock: requiredString(request.body.sealedUnlock, 'sealedUnlock'),
      }));
    });
    app.post('/v1/desktop/cache/challenge', (request, response) => {
      response.json(localAuthority.createCacheUpdateChallenge(
        requiredString(request.body.callerId, 'callerId'),
        requiredString(request.body.clientNonce, 'clientNonce'),
        requiredString(request.body.clientProof, 'clientProof'),
      ));
    });
    app.post('/v1/desktop/cache/fetch', (request, response) => {
      response.json(localAuthority.fetchCacheUpdate({
        callerId: requiredString(request.body.callerId, 'callerId'),
        challengeId: requiredString(request.body.challengeId, 'challengeId'),
        clientProof: requiredString(request.body.clientProof, 'clientProof'),
        sealedLegacyVmk: typeof request.body.sealedLegacyVmk === 'string' ? request.body.sealedLegacyVmk : undefined,
      }));
    });
    app.get('/v1/desktop/status', (request, response) => {
      const identity = serviceIdentity(request);
      localAuthority.requireControlIdentity(identity.serviceId, identity.token);
      const status = localAuthority.status();
      response.json({ ...status, migration: { required: status.state === 'migration_required', error: status.state === 'migration_failed' ? 'migration_failed' : undefined } });
    });
    app.post('/v1/desktop/lock', (request, response) => {
      const identity = serviceIdentity(request);
      localAuthority.requireControlIdentity(identity.serviceId, identity.token);
      localAuthority.lock();
      response.json({ state: 'locked', unlocked: false, migration: { required: false } });
    });
    app.post('/v1/desktop/migrate', async(request, response) => {
      const identity = serviceIdentity(request);
      response.json(await localAuthority.migrateLegacy(identity.serviceId, identity.token));
    });
    app.post('/v1/human/session', (request, response) => {
      const identity = serviceIdentity(request);
      const target = request.body?.browserTarget;
      const session = localAuthority.createHumanSession(identity.serviceId, identity.token, target ? {
        tabId: requiredString(target.tabId, 'browserTarget.tabId'),
        origin: requiredString(target.origin, 'browserTarget.origin'),
      } : undefined);
      const fragment = new URLSearchParams({ grant: session.sessionId, csrf: session.csrf }).toString();
      response.json({ url: `${ config.humanUiOrigin }/vault/#${ fragment }`, csrf: session.csrf, expiresAt: session.expiresAt, phase: session.phase });
    });
    app.use('/v1/human', (request, response, next) => {
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Referrer-Policy', 'no-referrer');
      const origin = request.header('origin');
      const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
      const fetchSite = request.header('sec-fetch-site');
      if ((unsafe && origin !== config.humanUiOrigin) || (!unsafe && origin && origin !== config.humanUiOrigin) ||
          (fetchSite && fetchSite !== 'same-origin')) {
        response.status(403).json({ error: 'invalid_origin', message: 'Human vault origin is invalid' });
        return;
      }
      if (origin) response.setHeader('Access-Control-Allow-Origin', config.humanUiOrigin!);
      response.setHeader('Vary', 'Origin');
      next();
    });
    app.post('/v1/human/session/exchange', (request, response) => {
      const session = localAuthority.exchangeHumanGrant(
        requiredString(request.body.grant, 'grant'), requiredString(request.body.csrf, 'csrf'),
      );
      setHumanCookie(response, session.sessionId, session.expiresAt);
      response.json({ csrf: session.csrf, expiresAt: session.expiresAt, phase: session.phase, targetOrigin: session.browserTarget?.origin });
    });
    app.get('/v1/human/session', (request, response) => {
      response.json(localAuthority.humanSessionStatus(humanCookie(request), request.header('x-csrf-token')));
    });
    app.post('/v1/human/unlock', async(request, response) => {
      const result = await localAuthority.unlockHumanSession(
        humanCookie(request), request.header('x-csrf-token'), requiredString(request.body.password, 'password'),
      );
      setHumanCookie(response, result.sessionId, result.expiresAt);
      response.json({ csrf: result.csrf, expiresAt: result.expiresAt, phase: result.phase, state: result.state, cacheMode: result.cacheMode });
    });
    app.post('/v1/human/password', async(request, response) => {
      response.json(await localAuthority.changeHumanPassword(
        humanCookie(request), request.header('x-csrf-token'),
        requiredString(request.body.currentPassword, 'currentPassword'), requiredString(request.body.nextPassword, 'nextPassword'),
      ));
    });
    app.post('/v1/human/recovery/configure', async(request, response) => {
      await localAuthority.configureHumanRecovery(
        humanCookie(request), request.header('x-csrf-token'), requiredString(request.body.recoveryCode, 'recoveryCode'),
      );
      response.status(204).end();
    });
    app.post('/v1/human/recovery/unlock', async(request, response) => {
      const result = await localAuthority.recoverHumanSession(
        humanCookie(request), request.header('x-csrf-token'),
        requiredString(request.body.recoveryCode, 'recoveryCode'), requiredString(request.body.nextPassword, 'nextPassword'),
      );
      setHumanCookie(response, result.sessionId, result.expiresAt);
      response.json({ csrf: result.csrf, expiresAt: result.expiresAt, phase: result.phase, state: result.state, cacheMode: result.cacheMode });
    });
    app.post('/v1/human/backup/export', async(request, response) => {
      response.json(await localAuthority.exportHumanBackup(
        humanCookie(request), request.header('x-csrf-token'), requiredString(request.body.backupPassword, 'backupPassword'),
      ));
    });
    app.post('/v1/human/backup/import', async(request, response) => {
      await localAuthority.importHumanBackup(
        humanCookie(request), request.header('x-csrf-token'), requiredString(request.body.backupPassword, 'backupPassword'),
        requiredObject(request.body.backup, 'backup') as any,
      );
      response.status(204).end();
    });
    app.post('/v1/human/lock', (request, response) => {
      const result = localAuthority.lockHumanSession(humanCookie(request), request.header('x-csrf-token'));
      setHumanCookie(response, result.sessionId, result.expiresAt);
      response.json({ csrf: result.csrf, expiresAt: result.expiresAt, phase: result.phase, state: result.state });
    });
    app.get('/v1/human/items', async(request, response) => {
      response.json({ items: await localAuthority.listHumanItems(humanCookie(request), request.header('x-csrf-token')) });
    });
    app.get('/v1/human/activity', async(request, response) => {
      const session = localAuthority.humanSessionStatus(humanCookie(request), request.header('x-csrf-token'));
      const principalId = localAuthority.status().principalId;
      if (session.phase !== 'unlocked' || !principalId) throw new LocalVaultError('vault_locked', 423, 'Vault is locked');
      const limit = Math.min(Math.max(Number(request.query.limit) || 25, 1), 100);
      const offset = Math.min(Math.max(Number(request.query.offset) || 0, 0), 100_000);
      const conditions = ['a.actor_user_id=$1', 'a.org_id IS NULL', '(a.item_id IS NULL OR i.owner_user_id=$1)'];
      const params: unknown[] = [principalId];
      const add = (sql: string, value: unknown) => { params.push(value); conditions.push(sql.replace('?', `$${ params.length }`)); };
      if (typeof request.query.item === 'string') {
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(request.query.item)) {
          throw new HttpError(400, 'item is invalid');
        }
        add('a.item_id=?::uuid', request.query.item);
      }
      const agentEvent = `(a.action IN ('vault_outbound_request','agent_credential_broker_use','agent_credential_use') OR a.metadata ? 'agentId')`;
      if (request.query.actor === 'agent') conditions.push(agentEvent);
      else if (request.query.actor === 'human') conditions.push(`NOT ${ agentEvent }`);
      else if (request.query.actor !== undefined && request.query.actor !== 'all') throw new HttpError(400, 'actor is invalid');
      if (request.query.blocked === 'true') conditions.push('a.blocked=true');
      else if (request.query.blocked !== undefined && request.query.blocked !== 'false') throw new HttpError(400, 'blocked is invalid');
      if (typeof request.query.from === 'string') {
        if (!Number.isFinite(Date.parse(request.query.from))) throw new HttpError(400, 'from is invalid');
        add('a.created_at>=?::timestamptz', request.query.from);
      }
      if (typeof request.query.query === 'string') {
        const query = request.query.query.trim();
        if (query.length > 160) throw new HttpError(400, 'query is too long');
        if (query) {
          params.push(`%${ query.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_') }%`);
          const search = `$${ params.length }`;
          conditions.push(`(a.action ILIKE ${ search } OR COALESCE(a.pod_id,'') ILIKE ${ search } OR COALESCE(a.item_id::text,'') ILIKE ${ search } OR COALESCE(a.metadata->>'agentId','') ILIKE ${ search } OR COALESCE(a.metadata->>'operation','') ILIKE ${ search } OR COALESCE(a.metadata->>'destination','') ILIKE ${ search })`);
        }
      }
      params.push(limit + 1, offset);
      const result = await db.query(
        `SELECT a.id,a.item_id,a.action,a.pod_id,a.metadata,a.blocked,a.reason,a.created_at
           FROM audit_log a LEFT JOIN items i ON i.id=a.item_id
          WHERE ${ conditions.join(' AND ') }
          ORDER BY a.created_at DESC,a.id DESC LIMIT $${ params.length - 1 } OFFSET $${ params.length }`, params,
      );
      const hasMore = result.rows.length > limit;
      const events = result.rows.slice(0, limit).map(event => ({ ...event, metadata: sanitizedAuditMetadata(event.metadata) }));
      response.json({ events, hasMore, limit, offset });
    });
    app.post('/v1/human/items', async(request, response) => {
      const result = await localAuthority.saveHumanItem(humanCookie(request), request.header('x-csrf-token'), request.body);
      await auditPersonalItemEvent(db, result.id, 'human_item_created');
      response.status(201).json(result);
    });
    app.post('/v1/human/items/:itemId/reveal', async(request, response) => {
      const itemId = requiredString(request.params.itemId, 'itemId');
      const result = await localAuthority.revealHumanItem(humanCookie(request), request.header('x-csrf-token'), itemId);
      await auditPersonalItemEvent(db, itemId, 'human_item_reveal');
      response.json(result);
    });
    app.patch('/v1/human/items/:itemId', async(request, response) => {
      const itemId = requiredString(request.params.itemId, 'itemId');
      const result = await localAuthority.saveHumanItem(humanCookie(request), request.header('x-csrf-token'), { ...request.body, id: itemId });
      await auditPersonalItemEvent(db, itemId, 'human_item_updated');
      response.json(result);
    });
    app.delete('/v1/human/items/:itemId', async(request, response) => {
      const itemId = requiredString(request.params.itemId, 'itemId');
      await localAuthority.deleteHumanItem(humanCookie(request), request.header('x-csrf-token'), itemId, Number(request.query.revision));
      await auditPersonalItemEvent(db, itemId, 'human_item_deleted');
      response.status(204).end();
    });
    app.post('/v1/broker/approve', (request, response) => {
      const identity = serviceIdentity(request);
      response.json(localAuthority.approve(identity.serviceId, identity.token, requiredString(request.body.operationId, 'operationId')));
    });
    app.get('/v1/broker/status', (request, response) => {
      const identity = serviceIdentity(request);
      response.json(localAuthority.brokerStatus(identity.serviceId, identity.token));
    });
    app.get('/v1/broker/integrations/:integrationId/metadata', async(request, response) => {
      const identity = serviceIdentity(request);
      response.json(await localAuthority.integrationMetadata(
        identity.serviceId, identity.token, requiredString(request.params.integrationId, 'integrationId'),
        typeof request.query.accountId === 'string' ? request.query.accountId : undefined,
      ));
    });
    app.put('/v1/broker/integrations/:integrationId/active-account', async(request, response) => {
      const identity = serviceIdentity(request);
      response.json(await localAuthority.setActiveIntegrationAccount(
        identity.serviceId, identity.token, requiredString(request.params.integrationId, 'integrationId'),
        requiredString(request.body.accountId, 'accountId'),
      ));
    });
    app.post('/v1/broker/execute', async(request, response) => {
      const identity = serviceIdentity(request);
      response.json(await localAuthority.execute(request.body, identity.serviceId, identity.token));
    });
    app.post('/v1/broker/execute-stream', async(request, response) => {
      const identity = serviceIdentity(request);
      await localAuthority.executeStream(request.body, identity.serviceId, identity.token, {
        start: (status, headers) => { response.status(status); for (const [name, value] of Object.entries(headers)) response.setHeader(name, value); response.flushHeaders(); },
        write: chunk => response.write(chunk),
        onceDrain: callback => response.once('drain', callback),
        end: () => response.end(),
        destroy: error => response.destroy(error),
        onAbort: callback => response.once('close', callback),
      });
    });
    app.post('/v1/broker/relay/session', async(request, response) => {
      const identity = serviceIdentity(request);
      response.status(201).json(await localAuthority.createRelay(request.body, identity.serviceId, identity.token));
    });
    app.get('/v1/broker/relay/:relayId/events', async(request, response) => {
      const identity = serviceIdentity(request);
      const controller = new AbortController();
      request.once('close', () => controller.abort());
      response.status(200);
      response.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      response.setHeader('Cache-Control', 'no-store');
      response.flushHeaders();
      for await (const event of localAuthority.relayEvents(
        requiredString(request.params.relayId, 'relayId'), identity.serviceId, identity.token, controller.signal,
      )) {
        if (controller.signal.aborted) break;
        if (!response.write(`${ JSON.stringify(event) }\n`)) {
          await new Promise<void>(resolve => response.once('drain', resolve));
        }
      }
      response.end();
    });
    app.post('/v1/broker/relay/:relayId/send', async(request, response) => {
      const identity = serviceIdentity(request);
      await localAuthority.sendRelay(
        requiredString(request.params.relayId, 'relayId'), request.body, identity.serviceId, identity.token,
      );
      response.status(204).end();
    });
    app.delete('/v1/broker/relay/:relayId', (request, response) => {
      const identity = serviceIdentity(request);
      localAuthority.closeRelay(requiredString(request.params.relayId, 'relayId'), identity.serviceId, identity.token);
      response.status(204).end();
    });
    app.get(/^\/vault$/, (_request, response) => response.redirect(308, '/vault/'));
    app.use('/vault', (_request, response, next) => {
      response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors app: rancher-desktop:");
      response.setHeader('Referrer-Policy', 'no-referrer');
      response.setHeader('Cache-Control', 'no-store');
      next();
    }, express.static(resolve(dirname(fileURLToPath(import.meta.url)), '../console/local')));

    // Everything below this point is the remote/server ciphertext API. Local
    // mode must never expose wrapped keys, JWT CRUD, or the retired broker
    // credential endpoint, even to a token issued before a lock.
    app.use('/v1', (_request, response) => {
      response.status(404).json({ error: 'not_found', message: 'This API is unavailable in local vault mode' });
    });
  }

  app.post('/v1/accounts', async(request, response) => {
    if (config.mode !== 'server') {
      response.status(404).json({ error: 'not_found' });
      return;
    }
    const email = requiredString(request.body.email, 'email').trim().toLowerCase();
    const loginHash = requiredString(request.body.loginHash, 'loginHash');
    const publicKey = requiredString(request.body.publicKey, 'publicKey');
    const encryptedPrivateKey = requiredObject(request.body.encryptedPrivateKey, 'encryptedPrivateKey');
    const encryptedUserKey = requiredObject(request.body.encryptedUserKey, 'encryptedUserKey');
    const kdf = requiredObject(request.body.kdf, 'kdf');
    const joinOrgId = typeof request.body.orgId === 'string' ? request.body.orgId : null;
    const joinHash = typeof request.body.joinHash === 'string' ? request.body.joinHash : null;
    if ((joinOrgId && !joinHash) || (!joinOrgId && joinHash)) throw new HttpError(400, 'orgId and joinHash must be supplied together');
    if (joinOrgId) {
      enforceJoinAttemptLimit(request.ip ?? "unknown", joinOrgId);
      const org = await db.query<{ join_password_salt: Buffer; join_password_verifier: Buffer }>(
        'SELECT join_password_salt, join_password_verifier FROM orgs WHERE id = $1', [joinOrgId]);
      if (!org.rowCount || !org.rows[0].join_password_salt || !org.rows[0].join_password_verifier || !verifyLoginHash(joinHash!, org.rows[0].join_password_salt, org.rows[0].join_password_verifier)) {
        response.status(403).json({ error: 'invalid_join_password' }); return;
      }
    }
    const { salt, verifier } = makeLoginVerifier(loginHash);
    const result = await db.query<{ id: string }>(
      `INSERT INTO users(email, login_hash_salt, login_hash_verifier, public_key, encrypted_private_key, encrypted_user_key, kdf)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [email, salt, verifier, publicKey, encryptedPrivateKey, encryptedUserKey, kdf],
    );
    if (joinOrgId) {
      await db.query(`INSERT INTO org_members(org_id, user_id, role, wrapped_org_key, status)
        VALUES ($1, $2, 'member', NULL, 'pending')`, [joinOrgId, result.rows[0].id]);
    }
    response.status(201).json({ id: result.rows[0].id });
  });

  // KDF parameters are public by design and are required before a browser can
  // derive the login hash. No credential verifier or wrapped key is exposed.
  app.get('/v1/accounts/kdf', async(request, response) => {
    if (config.mode !== 'server') return response.status(404).json({ error: 'not_found' });
    const email = requiredString(request.query.email, 'email').trim().toLowerCase();
    const result = await db.query<{ kdf: unknown }>('SELECT kdf FROM users WHERE email = $1 AND disabled_at IS NULL', [email]);
    const fakeSalt = createHmac('sha256', config.jwtSecret)
      .update('sulla:fake-account-kdf:v1\0').update(email).digest().subarray(0, 16).toString('base64url');
    response.json({ kdf: result.rows[0]?.kdf ?? { salt: fakeSalt, parameters: DEFAULT_ARGON2ID } });
  });

  app.get('/console', async (_request, response) => {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const candidate of [resolve(here, '../console/index.html'), resolve(here, '../../console/index.html')]) {
      try { response.type('html').send(await readFile(candidate, 'utf8')); return; } catch { /* source tree vs image */ }
    }
    response.type('html').send(CONSOLE_HTML);
  });
  app.use('/console', express.static(resolve(dirname(fileURLToPath(import.meta.url)), '../console')));

  // Desktop bootstrap is deliberately limited to the local, single-user
  // mode. The client sends only derived login material and wrapped keys.
  app.post('/v1/desktop/bootstrap', async(request, response) => {
    if (config.mode !== 'desktop') {
      response.status(404).json({ error: 'not_found' });
      return;
    }
    const loginHash = requiredString(request.body.loginHash, 'loginHash');
    const publicKey = requiredString(request.body.publicKey, 'publicKey');
    const encryptedPrivateKey = requiredObject(request.body.encryptedPrivateKey, 'encryptedPrivateKey');
    const encryptedUserKey = requiredObject(request.body.encryptedUserKey, 'encryptedUserKey');
    const kdf = requiredObject(request.body.kdf, 'kdf');
    const existing = await db.query<{ id: string }>('SELECT id FROM users LIMIT 1');
    if (!existing.rowCount) {
      const { salt, verifier } = makeLoginVerifier(loginHash);
      await db.query(
        `INSERT INTO users(email, login_hash_salt, login_hash_verifier, public_key, encrypted_private_key, encrypted_user_key, kdf)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        ['desktop@local.sulla', salt, verifier, publicKey, encryptedPrivateKey, encryptedUserKey, kdf],
      );
    }
    response.status(existing.rowCount ? 200 : 201).json({ ok: true });
  });

  // The desktop client must use the persisted KDF parameters when an account
  // already exists. This endpoint intentionally exposes only public KDF data.
  app.get('/v1/desktop/bootstrap', async(_request, response) => {
    if (config.mode !== 'desktop') {
      response.status(404).json({ error: 'not_found' });
      return;
    }
    const existing = await db.query<{ kdf: unknown }>('SELECT kdf FROM users WHERE disabled_at IS NULL LIMIT 1');
    if (!existing.rowCount) {
      response.status(404).json({ error: 'not_bootstrapped' });
      return;
    }
    response.json({ kdf: existing.rows[0].kdf });
  });

  app.post('/v1/session', async(request, response) => {
    const loginHash = requiredString(request.body.loginHash, 'loginHash');
    const email = config.mode === 'desktop' ? undefined : requiredString(request.body.email, 'email').trim().toLowerCase();
    const result = await db.query<{
      id:                    string;
      login_hash_salt:       Buffer;
      login_hash_verifier:   Buffer;
      public_key:            string;
      encrypted_private_key: unknown;
      encrypted_user_key:    unknown;
      kdf:                   unknown;
    }>(
      config.mode === 'desktop'
        ? `SELECT id, login_hash_salt, login_hash_verifier, public_key, encrypted_private_key, encrypted_user_key, kdf
             FROM users WHERE disabled_at IS NULL LIMIT 1`
        : `SELECT id, login_hash_salt, login_hash_verifier, public_key, encrypted_private_key, encrypted_user_key, kdf
             FROM users WHERE email = $1 AND disabled_at IS NULL`,
      email ? [email] : [],
    );
    const account = result.rows[0];
    if (!account || !verifyLoginHash(loginHash, account.login_hash_salt, account.login_hash_verifier)) {
      response.status(401).json({ error: 'invalid_credentials' });
      return;
    }
    if (request.body.device && typeof request.body.device === 'object') {
      const device = request.body.device as Record<string, unknown>;
      const name = requiredString(device.name, 'device.name');
      await db.query(
        `INSERT INTO devices(user_id, name, public_key) VALUES ($1, $2, $3)`,
        [account.id, name, typeof device.publicKey === 'string' ? device.publicKey : null],
      );
    }
    response.json({
      token: issueToken(config, account.id),
      user:  {
        id:                  account.id,
        publicKey:           account.public_key,
        encryptedPrivateKey: account.encrypted_private_key,
        encryptedUserKey:    account.encrypted_user_key,
        kdf:                 account.kdf,
      },
    });
  });

  // Service-to-service only. The tool API passes verified capability claims;
  // this endpoint independently applies vault ownership, collection and item
  // policy, then returns ciphertext for the broker to unwrap in-memory.
  app.post('/v1/broker/credential', async(request, response) => {
    const serviceId = request.header('x-sulla-service-id');
    const token = request.header('authorization')?.replace(/^Bearer\s+/i, '');
    if (serviceId !== config.brokerServiceId || !safeTokenEqual(token, config.brokerServiceToken)) {
      response.status(401).json({ error: 'invalid_service_identity' });
      return;
    }

    const claims = brokerClaims(request.body.claims);
    const ref = requiredObject(request.body.ref, 'ref');
    const itemId = typeof ref.itemId === 'string' ? ref.itemId : null;
    const integrationId = typeof ref.integrationId === 'string' ? ref.integrationId : null;
    if (!itemId && !integrationId) throw new HttpError(400, 'ref.itemId or ref.integrationId is required');

    const result = await db.query(
      `SELECT i.id,i.owner_user_id,i.collection_id,i.ciphertext,i.agent_wrapped_item_key,i.agent_policy,
              c.org_id,om.role,cm.can_use_by_agents,
              EXISTS (
                SELECT 1 FROM group_members gm
                JOIN collection_group_members cgm ON cgm.group_id=gm.group_id
                JOIN org_groups g ON g.id=gm.group_id AND g.org_id=c.org_id
               WHERE gm.user_id=$1 AND cgm.collection_id=i.collection_id AND cgm.can_use_by_agents=true
              ) AS group_can_use_by_agents
         FROM items i
         LEFT JOIN collections c ON c.id=i.collection_id
         LEFT JOIN org_members om ON om.org_id=c.org_id AND om.user_id=$1 AND om.status='confirmed'
         LEFT JOIN collection_members cm ON cm.collection_id=i.collection_id AND cm.user_id=$1
        WHERE i.deleted_at IS NULL AND (($2::uuid IS NOT NULL AND i.id=$2) OR ($3::text IS NOT NULL AND i.integration_ref=$3))
        LIMIT 1`,
      [claims.sub, itemId, integrationId],
    );
    const item = result.rows[0] as Record<string, any> | undefined;
    let reason = 'Credential access denied';
    let allowed = false;
    if (item) {
      const personalAccess = item.owner_user_id === claims.sub;
      const collectionAccess = Boolean(item.collection_id) &&
        (!claims.org_id || claims.org_id === item.org_id) &&
        (item.role === 'owner' || item.role === 'admin' || item.can_use_by_agents === true || item.group_can_use_by_agents === true);
      const policy = agentPolicyAllows(item.agent_policy, {
        agentId:  claims.agent_id,
        level:    'autofill',
        host:     typeof request.body.host === 'string' ? request.body.host : undefined,
        onServer: config.mode === 'server',
      });
      if (!personalAccess && !collectionAccess) reason = 'User cannot use credentials from this collection';
      else if (!item.agent_wrapped_item_key) reason = 'Item is not enabled for agents';
      else if (!policy.allowed) reason = policy.reason ?? reason;
      else if (item.agent_policy?.askFirst) reason = 'Owner approval is required, but server agent approval is not available';
      else allowed = true;
    } else {
      reason = 'Item not found or inaccessible';
    }

    const audit = await db.query(
      `INSERT INTO audit_log(actor_user_id,org_id,collection_id,item_id,action,pod_id,metadata,blocked,reason)
       VALUES ($1,$2,$3,$4,'agent_credential_broker_use',$5,$6,$7,$8)
       RETURNING id,created_at`,
      [claims.sub, item?.org_id ?? claims.org_id ?? null, item?.collection_id ?? null, item?.id ?? null, claims.pod_id,
        {
          serviceId,
          agentId:             claims.agent_id,
          threadId:            claims.thread_id,
          jobId:               claims.job_id,
          workflowExecutionId: claims.workflow_execution_id,
          requestedItemId:     itemId,
          integrationId,
        },
        !allowed, allowed ? null : reason],
    );
    if (!allowed || !item) {
      response.status(403).json({
        error:          'credential_denied',
        policyDecision: { allowed: false, reason },
        auditId:        audit.rows[0].id,
      });
      return;
    }
    response.json({
      ciphertext:             item.ciphertext,
      agent_wrapped_item_key: item.agent_wrapped_item_key,
      policyDecision:         {
        allowed:        true,
        itemId:         item.id,
        contextOwnerId: item.collection_id ?? item.owner_user_id,
        auditId:        audit.rows[0].id,
      },
    });
  });

  app.use('/v1', authenticate(config));

  app.get('/v1/items', async(request: AuthenticatedRequest, response) => {
    const actorId = userId(request);
    const result = await db.query(
      `SELECT DISTINCT i.id, i.owner_user_id, i.collection_id, i.folder_id, i.item_type, i.ciphertext,
              i.encrypted_item_key, i.agent_wrapped_item_key, i.revision, i.created_at, i.updated_at
         FROM items i
         LEFT JOIN collections c ON c.id = i.collection_id
         LEFT JOIN org_members om ON om.org_id = c.org_id AND om.user_id = $1 AND om.status = 'confirmed'
         LEFT JOIN collection_members cm ON cm.collection_id = c.id AND cm.user_id = $1
        WHERE i.deleted_at IS NULL
          AND (i.owner_user_id = $1 OR om.role IN ('owner', 'admin') OR (om.role = 'member' AND cm.can_view = true))
          AND ($2::uuid IS NULL OR i.collection_id = $2)
        ORDER BY i.updated_at DESC`,
      [actorId, typeof request.query.collectionId === 'string' ? request.query.collectionId : null],
    );
    response.json({ items: result.rows });
  });

  app.post('/v1/items', async(request: AuthenticatedRequest, response) => {
    const actorId = userId(request);
    const itemId = requiredString(request.body.id, 'id');
    const collectionId = typeof request.body.collectionId === 'string' ? request.body.collectionId : null;
    if (collectionId) {
      await requireCollectionRight(db, actorId, collectionId, 'edit');
    }
    const folderId = typeof request.body.folderId === 'string' ? request.body.folderId : null;
    if (folderId) await authorizeItemFolder(db, actorId, folderId, collectionId);
    const result = await db.query(
      `INSERT INTO items(id, owner_user_id, collection_id, folder_id, item_type, ciphertext, encrypted_item_key, agent_wrapped_item_key, agent_policy, integration_ref)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id, revision, created_at, updated_at`,
      [itemId, collectionId ? null : actorId, collectionId, folderId,
        requiredString(request.body.itemType, 'itemType'), requiredObject(request.body.ciphertext, 'ciphertext'),
        requiredObject(request.body.encryptedItemKey, 'encryptedItemKey'), request.body.agentWrappedItemKey ?? null,
        request.body.agentPolicy ? requiredObject(request.body.agentPolicy, 'agentPolicy') : DEFAULT_AGENT_POLICY,
        typeof request.body.integrationRef === 'string' ? request.body.integrationRef : null],
    );
    response.status(201).json(result.rows[0]);
  });

  app.get('/v1/items/:itemId', async(request: AuthenticatedRequest, response) => {
    response.json(await authorizeItem(db, userId(request), requiredString(request.params.itemId, 'itemId'), 'view'));
  });

  app.patch('/v1/items/:itemId', async(request: AuthenticatedRequest, response) => {
    const actorId = userId(request);
    const item = await authorizeItem(db, actorId, requiredString(request.params.itemId, 'itemId'), 'edit');
    const revision = Number(request.body.revision);
    if (!Number.isSafeInteger(revision) || revision < 1) {
      throw new HttpError(400, 'revision is required');
    }
    const updatesFolder = Object.hasOwn(request.body, 'folderId');
    if (updatesFolder && request.body.folderId !== null) {
      await authorizeItemFolder(db, actorId, requiredString(request.body.folderId, 'folderId'),
        typeof item.collection_id === 'string' ? item.collection_id : null);
    }
    const result = await db.query(
      `UPDATE items
          SET folder_id = CASE WHEN $1::boolean THEN $2 ELSE folder_id END, item_type = COALESCE($3, item_type),
              ciphertext = COALESCE($4, ciphertext), encrypted_item_key = COALESCE($5, encrypted_item_key),
              agent_wrapped_item_key = CASE WHEN $6::boolean THEN $7 ELSE agent_wrapped_item_key END,
              agent_policy = COALESCE($10, agent_policy),
              integration_ref = CASE WHEN $11::boolean THEN $12 ELSE integration_ref END,
              revision = revision + 1, updated_at = now()
        WHERE id = $8 AND revision = $9 AND deleted_at IS NULL
        RETURNING id, revision, updated_at`,
      [updatesFolder, request.body.folderId ?? null, request.body.itemType ?? null, request.body.ciphertext ?? null,
        request.body.encryptedItemKey ?? null, Object.hasOwn(request.body, 'agentWrappedItemKey'),
        request.body.agentWrappedItemKey ?? null, request.params.itemId, revision,
        request.body.agentPolicy ? requiredObject(request.body.agentPolicy, 'agentPolicy') : null,
        Object.hasOwn(request.body, 'integrationRef'), request.body.integrationRef ?? null],
    );
    if (!result.rowCount) {
      throw new HttpError(409, 'Item revision conflict');
    }
    response.json(result.rows[0]);
  });

  app.delete('/v1/items/:itemId', async(request: AuthenticatedRequest, response) => {
    await authorizeItem(db, userId(request), requiredString(request.params.itemId, 'itemId'), 'edit');
    const revision = Number(request.query.revision);
    if (!Number.isSafeInteger(revision) || revision < 1) {
      throw new HttpError(400, 'revision query parameter is required');
    }
    const result = await db.query(
      `UPDATE items SET deleted_at = now(), revision = revision + 1, updated_at = now()
        WHERE id = $1 AND revision = $2 AND deleted_at IS NULL RETURNING id, revision`,
      [request.params.itemId, revision],
    );
    if (!result.rowCount) {
      throw new HttpError(409, 'Item revision conflict');
    }
    response.json(result.rows[0]);
  });

  app.get('/v1/folders', async(request: AuthenticatedRequest, response) => {
    const result = await db.query('SELECT * FROM folders WHERE owner_user_id = $1 ORDER BY updated_at DESC', [userId(request)]);
    response.json({ folders: result.rows });
  });

  app.post('/v1/folders', async(request: AuthenticatedRequest, response) => {
    const result = await db.query(
      'INSERT INTO folders(owner_user_id, encrypted_name) VALUES ($1, $2) RETURNING *',
      [userId(request), requiredObject(request.body.encryptedName, 'encryptedName')],
    );
    response.status(201).json(result.rows[0]);
  });

  app.patch('/v1/folders/:folderId', async(request: AuthenticatedRequest, response) => {
    const result = await db.query(
      `UPDATE folders SET encrypted_name = $1, revision = revision + 1, updated_at = now()
        WHERE id = $2 AND owner_user_id = $3 AND revision = $4 RETURNING *`,
      [requiredObject(request.body.encryptedName, 'encryptedName'), request.params.folderId, userId(request), Number(request.body.revision)],
    );
    if (!result.rowCount) throw new HttpError(409, 'Folder revision conflict');
    response.json(result.rows[0]);
  });

  app.delete('/v1/folders/:folderId', async(request: AuthenticatedRequest, response) => {
    const result = await db.query('DELETE FROM folders WHERE id = $1 AND owner_user_id = $2 RETURNING id', [request.params.folderId, userId(request)]);
    if (!result.rowCount) throw new HttpError(404, 'Folder not found');
    response.json(result.rows[0]);
  });

  app.post('/v1/orgs', async(request: AuthenticatedRequest, response) => {
    const actorId = userId(request);
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const org = await client.query<{ id: string }>(
        'INSERT INTO orgs(encrypted_name, created_by) VALUES ($1, $2) RETURNING id',
        [requiredObject(request.body.encryptedName, 'encryptedName'), actorId],
      );
      await client.query(
        `INSERT INTO org_members(org_id, user_id, role, wrapped_org_key) VALUES ($1, $2, 'owner', $3)`,
        [org.rows[0].id, actorId, requiredObject(request.body.wrappedOrgKey, 'wrappedOrgKey')],
      );
      await client.query('COMMIT');
      response.status(201).json(org.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });

  app.get('/v1/orgs', async(request: AuthenticatedRequest, response) => {
    const result = await db.query(
      `SELECT o.id, o.encrypted_name, om.role, om.wrapped_org_key, o.auto_confirm_new_members,
              (o.join_password_verifier IS NOT NULL) AS join_enabled, o.created_at, o.updated_at
         FROM orgs o JOIN org_members om ON om.org_id = o.id
        WHERE om.user_id = $1 AND om.status = 'confirmed' ORDER BY o.updated_at DESC`, [userId(request)],
    );
    response.json({ orgs: result.rows });
  });

  app.patch('/v1/orgs/:orgId', async(request: AuthenticatedRequest, response) => {
    const orgId = requiredString(request.params.orgId, 'orgId');
    await requireOrgManager(db, userId(request), orgId);
    const result = await db.query(
      'UPDATE orgs SET encrypted_name = $1, updated_at = now() WHERE id = $2 RETURNING id, encrypted_name, updated_at',
      [requiredObject(request.body.encryptedName, 'encryptedName'), orgId],
    );
    response.json(result.rows[0]);
  });

  app.get('/v1/orgs/:orgId/members', async(request: AuthenticatedRequest, response) => {
    const orgId = requiredString(request.params.orgId, 'orgId');
    if (!await getOrgRole(db, userId(request), orgId)) throw new AccessDenied('Organization access denied');
    const result = await db.query(
      `SELECT om.user_id, om.role, om.status, om.wrapped_org_key, u.email, u.public_key
         FROM org_members om JOIN users u ON u.id = om.user_id
        WHERE om.org_id = $1 ORDER BY om.created_at`, [orgId],
    );
    response.json({ members: result.rows });
  });

  app.get('/v1/orgs/:orgId/account', async(request: AuthenticatedRequest, response) => {
    const orgId = requiredString(request.params.orgId, 'orgId');
    await requireOrgManager(db, userId(request), orgId);
    const email = requiredString(request.query.email, 'email').trim().toLowerCase();
    const result = await db.query<{ id: string; email: string; public_key: string }>(
      'SELECT id, email, public_key FROM users WHERE email = $1 AND disabled_at IS NULL', [email],
    );
    if (!result.rowCount) return response.status(404).json({ error: 'account_not_found' });
    response.json(result.rows[0]);
  });

  app.post('/v1/orgs/:orgId/members', async(request: AuthenticatedRequest, response) => {
    const orgId = requiredString(request.params.orgId, 'orgId');
    const actorRole = await requireOrgManager(db, userId(request), orgId);
    const memberId = requiredString(request.body.userId, 'userId');
    const role = requiredString(request.body.role, 'role');
    if (!['owner', 'admin', 'member'].includes(role)) throw new HttpError(400, 'Invalid organization role');
    const current = await db.query<{ role: string; status: string }>(
      'SELECT role, status FROM org_members WHERE org_id = $1 AND user_id = $2', [orgId, memberId],
    );
    if (current.rows[0]?.status === 'pending') {
      throw new HttpError(409, 'Pending members must be confirmed with their public key');
    }
    if ((role === 'owner' || current.rows[0]?.role === 'owner') && actorRole !== 'owner') {
      throw new AccessDenied('Only owners can change owner membership');
    }
    if (current.rows[0]?.role === 'owner' && role !== 'owner') {
      const owners = await db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM org_members WHERE org_id = $1 AND role = 'owner'`, [orgId],
      );
      if (owners.rows[0].count === '1') throw new HttpError(409, 'Cannot demote the last organization owner');
    }
    const result = await db.query(
      `INSERT INTO org_members(org_id, user_id, role, wrapped_org_key, status) VALUES ($1, $2, $3, $4, 'confirmed')
       ON CONFLICT (org_id, user_id) DO UPDATE
       SET role = EXCLUDED.role, wrapped_org_key = EXCLUDED.wrapped_org_key, status = 'confirmed', updated_at = now()
       RETURNING org_id, user_id, role, status`,
      [orgId, memberId, role,
        requiredObject(request.body.wrappedOrgKey, 'wrappedOrgKey')],
    );
    response.status(201).json(result.rows[0]);
  });

  app.post('/v1/orgs/:orgId/members/:memberId/confirm', async(request: AuthenticatedRequest, response) => {
    const orgId = requiredString(request.params.orgId, 'orgId');
    const actorId = userId(request);
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await requireOrgManager(client, actorId, orgId);
      const result = await client.query(
        `UPDATE org_members SET wrapped_org_key = $1, status = 'confirmed', updated_at = now()
          WHERE org_id = $2 AND user_id = $3 AND status = 'pending'
          RETURNING org_id, user_id, role, status`,
        [requiredObject(request.body.wrappedOrgKey, 'wrappedOrgKey'), orgId, request.params.memberId],
      );
      if (!result.rowCount) throw new HttpError(404, 'Pending member not found');
      await auditEvent(client, actorId, orgId, 'member_confirmed', { memberId: request.params.memberId });
      await client.query('COMMIT');
      response.json(result.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });

  app.patch('/v1/orgs/:orgId/settings', async(request: AuthenticatedRequest, response) => {
    const orgId = requiredString(request.params.orgId, 'orgId');
    await requireOrgManager(db, userId(request), orgId);
    const enabled = request.body.autoConfirmNewMembers;
    if (typeof enabled !== 'boolean') throw new HttpError(400, 'autoConfirmNewMembers must be boolean');
    const result = await db.query(
      'UPDATE orgs SET auto_confirm_new_members = $1, updated_at = now() WHERE id = $2 RETURNING auto_confirm_new_members',
      [enabled, orgId],
    );
    response.json(result.rows[0]);
  });

  app.delete('/v1/orgs/:orgId/members/:memberId', async(request: AuthenticatedRequest, response) => {
    const orgId = requiredString(request.params.orgId, 'orgId');
    const actorRole = await requireOrgManager(db, userId(request), orgId);
    const owners = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM org_members WHERE org_id = $1 AND role = 'owner'`,
      [orgId],
    );
    const target = await db.query<{ role: string }>(
      'SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2', [orgId, request.params.memberId],
    );
    if (target.rows[0]?.role === 'owner' && actorRole !== 'owner') {
      throw new AccessDenied('Only owners can remove owners');
    }
    if (target.rows[0]?.role === 'owner' && owners.rows[0].count === '1') {
      throw new HttpError(409, 'Cannot remove the last organization owner');
    }
    await db.query('DELETE FROM org_members WHERE org_id = $1 AND user_id = $2', [orgId, request.params.memberId]);
    response.status(204).end();
  });

  app.post('/v1/orgs/:orgId/collections', async(request: AuthenticatedRequest, response) => {
    await requireOrgManager(db, userId(request), requiredString(request.params.orgId, 'orgId'));
    const result = await db.query(
      `INSERT INTO collections(org_id, encrypted_name, wrapped_collection_key) VALUES ($1, $2, $3) RETURNING *`,
      [request.params.orgId, requiredObject(request.body.encryptedName, 'encryptedName'),
        requiredObject(request.body.wrappedCollectionKey, 'wrappedCollectionKey')],
    );
    response.status(201).json(result.rows[0]);
  });

  app.get('/v1/orgs/:orgId/collections', async(request: AuthenticatedRequest, response) => {
    const orgId = requiredString(request.params.orgId, 'orgId');
    const actorId = userId(request);
    if (!await getOrgRole(db, actorId, orgId)) throw new AccessDenied('Organization access denied');
    const result = await db.query(
      `SELECT c.id, c.encrypted_name, c.wrapped_collection_key, c.created_at, c.updated_at,
              cm.can_view, cm.can_use_by_agents, cm.can_edit, cm.can_manage
         FROM collections c
         JOIN org_members om ON om.org_id = c.org_id AND om.user_id = $1 AND om.status = 'confirmed'
         LEFT JOIN collection_members cm ON cm.collection_id = c.id AND cm.user_id = $1
        WHERE c.org_id = $2
          AND (om.role IN ('owner', 'admin') OR cm.can_view = true)
        ORDER BY c.updated_at DESC`, [actorId, orgId],
    );
    response.json({ collections: result.rows });
  });

  app.patch('/v1/collections/:collectionId', async(request: AuthenticatedRequest, response) => {
    const collectionId = requiredString(request.params.collectionId, 'collectionId');
    await requireCollectionRight(db, userId(request), collectionId, 'manage');
    const result = await db.query(
      `UPDATE collections SET encrypted_name = $1, wrapped_collection_key = COALESCE($2, wrapped_collection_key),
              updated_at = now()
        WHERE id = $3 RETURNING id, encrypted_name, wrapped_collection_key, updated_at`,
      [requiredObject(request.body.encryptedName, 'encryptedName'), request.body.wrappedCollectionKey ?? null, collectionId],
    );
    response.json(result.rows[0]);
  });

  app.get('/v1/collections/:collectionId/items', async(request: AuthenticatedRequest, response) => {
    await requireCollectionRight(db, userId(request), requiredString(request.params.collectionId, 'collectionId'), 'view');
    const result = await db.query(
      'SELECT * FROM items WHERE collection_id = $1 AND deleted_at IS NULL ORDER BY updated_at DESC',
      [request.params.collectionId],
    );
    response.json({ items: result.rows });
  });

  app.get('/v1/collections/:collectionId/access', async(request: AuthenticatedRequest, response) => {
    const collectionId = requiredString(request.params.collectionId, 'collectionId');
    await requireCollectionRight(db, userId(request), collectionId, 'manage');
    const members = await db.query(`SELECT om.user_id,om.role,u.email,
      COALESCE(cm.can_view,false) AS can_view,COALESCE(cm.can_use_by_agents,false) AS can_use_by_agents,
      COALESCE(cm.can_edit,false) AS can_edit,COALESCE(cm.can_manage,false) AS can_manage
      FROM collections c JOIN org_members om ON om.org_id=c.org_id AND om.status='confirmed' JOIN users u ON u.id=om.user_id
      LEFT JOIN collection_members cm ON cm.collection_id=c.id AND cm.user_id=om.user_id
      WHERE c.id=$1 ORDER BY om.created_at`, [collectionId]);
    const groups = await db.query(`SELECT g.id,g.encrypted_name,count(gm.user_id)::int AS member_count,
      COALESCE(cgm.can_view,false) AS can_view,COALESCE(cgm.can_use_by_agents,false) AS can_use_by_agents,
      COALESCE(cgm.can_edit,false) AS can_edit,COALESCE(cgm.can_manage,false) AS can_manage
      FROM collections c JOIN org_groups g ON g.org_id=c.org_id
      LEFT JOIN group_members gm ON gm.group_id=g.id
      LEFT JOIN collection_group_members cgm ON cgm.collection_id=c.id AND cgm.group_id=g.id
      WHERE c.id=$1 GROUP BY g.id,cgm.can_view,cgm.can_use_by_agents,cgm.can_edit,cgm.can_manage ORDER BY g.created_at`, [collectionId]);
    response.json({ members: members.rows, groups: groups.rows });
  });

  app.put('/v1/collections/:collectionId/members/:memberId', async(request: AuthenticatedRequest, response) => {
    const collectionId = requiredString(request.params.collectionId, 'collectionId');
    await requireCollectionRight(db, userId(request), collectionId, 'manage');
    const memberOrg = await db.query(`SELECT 1 FROM collections c JOIN org_members om ON om.org_id = c.org_id AND om.user_id = $2 AND om.status = 'confirmed' WHERE c.id = $1`, [collectionId, request.params.memberId]);
    if (!memberOrg.rowCount) throw new HttpError(400, 'Member must belong to the collection organization');
    const view = Boolean(request.body.view);
    const useByAgents = Boolean(request.body.useByAgents);
    const edit = Boolean(request.body.edit);
    const manage = Boolean(request.body.manage);
    if (!view && (useByAgents || edit || manage)) {
      throw new HttpError(400, 'view is required for all other collection rights');
    }
    const result = await db.query(
      `INSERT INTO collection_members(collection_id, user_id, can_view, can_use_by_agents, can_edit, can_manage)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (collection_id, user_id) DO UPDATE
       SET can_view = EXCLUDED.can_view, can_use_by_agents = EXCLUDED.can_use_by_agents,
           can_edit = EXCLUDED.can_edit, can_manage = EXCLUDED.can_manage, updated_at = now()
       RETURNING *`,
      [collectionId, request.params.memberId, view, useByAgents, edit, manage],
    );
    response.json(result.rows[0]);
  });

  app.delete('/v1/collections/:collectionId/members/:memberId', async(request: AuthenticatedRequest, response) => {
    const collectionId = requiredString(request.params.collectionId, 'collectionId');
    await requireCollectionRight(db, userId(request), collectionId, 'manage');
    await db.query('DELETE FROM collection_members WHERE collection_id = $1 AND user_id = $2',
      [collectionId, request.params.memberId]);
    response.status(204).end();
  });

  app.post('/v1/orgs/:orgId/join-password', async(request: AuthenticatedRequest, response) => {
    const orgId = requiredString(request.params.orgId, 'orgId');
    await requireOrgManager(db, userId(request), orgId);
    const { salt, verifier } = makeLoginVerifier(requiredString(request.body.joinHash, 'joinHash'));
    await db.query('UPDATE orgs SET join_password_salt=$1,join_password_verifier=$2,updated_at=now() WHERE id=$3',
      [salt, verifier, orgId]);
    await auditEvent(db, userId(request), orgId, 'join_password_set');
    response.status(204).end();
  });

  app.post('/v1/orgs/:orgId/join-password/rotate', async(request: AuthenticatedRequest, response) => {
    const orgId = requiredString(request.params.orgId, 'orgId');
    await requireOrgManager(db, userId(request), orgId);
    const { salt, verifier } = makeLoginVerifier(requiredString(request.body.joinHash, 'joinHash'));
    await db.query('UPDATE orgs SET join_password_salt=$1,join_password_verifier=$2,updated_at=now() WHERE id=$3',
      [salt, verifier, orgId]);
    await auditEvent(db, userId(request), orgId, 'join_password_rotated');
    response.status(204).end();
  });

  app.get('/v1/orgs/:orgId/groups', async(request: AuthenticatedRequest, response) => {
    const orgId = requiredString(request.params.orgId, 'orgId');
    if (!await getOrgRole(db, userId(request), orgId)) throw new AccessDenied('Organization access denied');
    const result = await db.query(`SELECT g.*, count(gm.user_id)::int AS member_count FROM org_groups g LEFT JOIN group_members gm ON gm.group_id = g.id WHERE g.org_id = $1 GROUP BY g.id ORDER BY g.created_at`, [orgId]);
    response.json({ groups: result.rows });
  });

  app.post('/v1/orgs/:orgId/groups', async(request: AuthenticatedRequest, response) => {
    const orgId = requiredString(request.params.orgId, 'orgId');
    await requireOrgManager(db, userId(request), orgId);
    const result = await db.query('INSERT INTO org_groups(org_id, encrypted_name) VALUES ($1, $2) RETURNING *', [orgId, requiredObject(request.body.encryptedName, 'encryptedName')]);
    response.status(201).json(result.rows[0]);
  });

  // Recovery is a ciphertext relay. The browser unwraps the member key with
  // the recovery private key and re-encrypts credentials; this service never
  // receives a plaintext user key or master password.
  app.post('/v1/orgs/:orgId/recovery/opt-in', async(request: AuthenticatedRequest, response) => {
    const orgId = requiredString(request.params.orgId, 'orgId');
    const actorId = userId(request);
    if (!await getOrgRole(db, actorId, orgId)) throw new AccessDenied('Organization access denied');
    const wrappedUserKey = requiredObject(request.body.wrappedUserKey, 'wrappedUserKey');
    await db.query(`INSERT INTO org_recovery_keys(org_id, user_id, wrapped_user_key) VALUES ($1,$2,$3)
      ON CONFLICT (org_id,user_id) DO UPDATE SET wrapped_user_key = EXCLUDED.wrapped_user_key, created_at = now()`, [orgId, actorId, wrappedUserKey]);
    await auditEvent(db, actorId, orgId, 'recovery_opt_in');
    response.status(204).end();
  });

  app.delete('/v1/orgs/:orgId/recovery/opt-in', async(request: AuthenticatedRequest, response) => {
    const orgId = requiredString(request.params.orgId, 'orgId');
    const actorId = userId(request);
    if (!await getOrgRole(db, actorId, orgId)) throw new AccessDenied('Organization access denied');
    await db.query('DELETE FROM org_recovery_keys WHERE org_id = $1 AND user_id = $2', [orgId, actorId]);
    await auditEvent(db, actorId, orgId, 'recovery_opt_out');
    response.status(204).end();
  });

  app.get('/v1/orgs/:orgId/recovery', async(request: AuthenticatedRequest, response) => {
    const orgId = requiredString(request.params.orgId, 'orgId');
    const actorId = userId(request);
    const role = await getOrgRole(db, actorId, orgId);
    if (!role) throw new AccessDenied('Organization access denied');
    const result = await db.query(`SELECT r.user_id, r.wrapped_user_key, r.created_at, u.email, u.public_key
      FROM org_recovery_keys r JOIN users u ON u.id = r.user_id
      WHERE r.org_id = $1 AND ($2::boolean OR r.user_id = $3) ORDER BY r.created_at`, [orgId, role === 'owner' || role === 'admin', actorId]);
    response.json({ recoveryPublicKey: (await db.query('SELECT recovery_public_key FROM orgs WHERE id = $1', [orgId])).rows[0]?.recovery_public_key ?? null, members: result.rows });
  });

  app.put('/v1/orgs/:orgId/recovery/public-key', async(request: AuthenticatedRequest, response) => {
    const orgId = requiredString(request.params.orgId, 'orgId');
    await requireOrgManager(db, userId(request), orgId);
    const publicKey = requiredString(request.body.publicKey, 'publicKey');
    const result = await db.query('UPDATE orgs SET recovery_public_key = $1, recovery_enabled = true, updated_at = now() WHERE id = $2 RETURNING recovery_public_key', [publicKey, orgId]);
    await auditEvent(db, userId(request), orgId, 'recovery_key_rotated');
    response.json(result.rows[0]);
  });

  app.patch('/v1/account/credentials', async(request: AuthenticatedRequest, response) => {
    const actorId = userId(request);
    const loginHash = requiredString(request.body.loginHash, 'loginHash');
    const { salt, verifier } = makeLoginVerifier(loginHash);
    await db.query(`UPDATE users SET login_hash_salt=$1, login_hash_verifier=$2, public_key=$3,
      encrypted_private_key=$4, encrypted_user_key=$5, kdf=$6, updated_at=now() WHERE id=$7`,
      [salt, verifier, requiredString(request.body.publicKey, 'publicKey'), requiredObject(request.body.encryptedPrivateKey, 'encryptedPrivateKey'), requiredObject(request.body.encryptedUserKey, 'encryptedUserKey'), requiredObject(request.body.kdf, 'kdf'), actorId]);
    const orgs = await db.query("SELECT org_id FROM org_members WHERE user_id = $1 AND status = 'confirmed'", [actorId]);
    for (const org of orgs.rows) await auditEvent(db, actorId, org.org_id, 'account_recovered');
    response.status(204).end();
  });

  app.put('/v1/groups/:groupId/members/:memberId', async(request: AuthenticatedRequest, response) => {
    const group = await db.query<{ org_id: string }>('SELECT org_id FROM org_groups WHERE id = $1', [request.params.groupId]);
    if (!group.rowCount) throw new HttpError(404, 'Group not found');
    await requireOrgManager(db, userId(request), group.rows[0].org_id);
    const member = await db.query("SELECT 1 FROM org_members WHERE org_id = $1 AND user_id = $2 AND status = 'confirmed'", [group.rows[0].org_id, request.params.memberId]);
    if (!member.rowCount) throw new HttpError(400, 'Member must belong to the group organization');
    await db.query('INSERT INTO group_members(group_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [request.params.groupId, request.params.memberId]);
    response.status(204).end();
  });

  app.get('/v1/groups/:groupId/members', async(request: AuthenticatedRequest, response) => {
    const group = await db.query<{ org_id: string }>('SELECT org_id FROM org_groups WHERE id = $1', [request.params.groupId]);
    if (!group.rowCount) throw new HttpError(404, 'Group not found');
    if (!await getOrgRole(db, userId(request), group.rows[0].org_id)) throw new AccessDenied('Organization access denied');
    const result = await db.query(`SELECT u.id,u.email FROM group_members gm JOIN users u ON u.id=gm.user_id
      WHERE gm.group_id=$1 ORDER BY u.email`, [request.params.groupId]);
    response.json({ members: result.rows });
  });

  app.delete('/v1/groups/:groupId/members/:memberId', async(request: AuthenticatedRequest, response) => {
    const group = await db.query<{ org_id: string }>('SELECT org_id FROM org_groups WHERE id = $1', [request.params.groupId]);
    if (!group.rowCount) throw new HttpError(404, 'Group not found');
    await requireOrgManager(db, userId(request), group.rows[0].org_id);
    await db.query('DELETE FROM group_members WHERE group_id=$1 AND user_id=$2', [request.params.groupId, request.params.memberId]);
    response.status(204).end();
  });

  app.put('/v1/collections/:collectionId/groups/:groupId', async(request: AuthenticatedRequest, response) => {
    const collectionId = requiredString(request.params.collectionId, 'collectionId');
    await requireCollectionRight(db, userId(request), collectionId, 'manage');
    const sameOrg = await db.query('SELECT 1 FROM collections c JOIN org_groups g ON g.org_id = c.org_id WHERE c.id = $1 AND g.id = $2', [collectionId, request.params.groupId]);
    if (!sameOrg.rowCount) throw new HttpError(400, 'Group must belong to the collection organization');
    const values = [Boolean(request.body.view), Boolean(request.body.useByAgents), Boolean(request.body.edit), Boolean(request.body.manage)];
    if (!values[0] && values.slice(1).some(Boolean)) throw new HttpError(400, 'view is required for all other collection rights');
    const result = await db.query(`INSERT INTO collection_group_members(collection_id, group_id, can_view, can_use_by_agents, can_edit, can_manage) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (collection_id,group_id) DO UPDATE SET can_view=$3,can_use_by_agents=$4,can_edit=$5,can_manage=$6 RETURNING *`, [collectionId, request.params.groupId, ...values]);
    response.json(result.rows[0]);
  });

  app.delete('/v1/collections/:collectionId/groups/:groupId', async(request: AuthenticatedRequest, response) => {
    const collectionId = requiredString(request.params.collectionId, 'collectionId');
    await requireCollectionRight(db, userId(request), collectionId, 'manage');
    await db.query('DELETE FROM collection_group_members WHERE collection_id=$1 AND group_id=$2', [collectionId, request.params.groupId]);
    response.status(204).end();
  });

  app.get('/v1/orgs/:orgId/audit', async(request: AuthenticatedRequest, response) => {
    const orgId = requiredString(request.params.orgId, 'orgId');
    if (!await getOrgRole(db, userId(request), orgId)) throw new AccessDenied('Organization access denied');
    const limit = Math.min(Math.max(Number(request.query.limit) || 50, 1), 200); const offset = Math.max(Number(request.query.offset) || 0, 0);
    const conditions = ['a.org_id = $1']; const params: unknown[] = [orgId];
    const add = (sql: string, value: unknown) => { params.push(value); conditions.push(sql.replace('?', `$${params.length}`)); };
    if (typeof request.query.person === 'string') add('a.actor_user_id = ?::uuid', request.query.person);
    if (typeof request.query.collection === 'string') add('a.collection_id = ?::uuid', request.query.collection);
    if (typeof request.query.item === 'string') add('a.item_id = ?::uuid', request.query.item);
    if (typeof request.query.action === 'string') add('a.action = ?', request.query.action);
    if (request.query.blocked === 'true') conditions.push('a.blocked = true');
    if (typeof request.query.from === 'string') add('a.created_at >= ?::timestamptz', request.query.from);
    if (typeof request.query.to === 'string') add('a.created_at < ?::timestamptz', request.query.to);
    params.push(limit, offset);
    const result = await db.query(`SELECT a.id,a.actor_user_id,a.device_id,a.collection_id,a.item_id,a.action,a.pod_id,a.metadata,a.blocked,a.reason,a.created_at FROM audit_log a WHERE ${conditions.join(' AND ')} ORDER BY a.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    response.json({ events: result.rows, limit, offset });
  });

  app.get('/v1/sync', async(request: AuthenticatedRequest, response) => {
    const actorId = userId(request);
    const cursor = Number.isSafeInteger(Number(request.query.cursor)) ? Number(request.query.cursor) : 0;
    const result = await db.query(`
      SELECT i.id,i.owner_user_id,i.collection_id,i.folder_id,i.item_type,i.ciphertext,i.encrypted_item_key,
             i.agent_wrapped_item_key,i.agent_policy,i.revision,i.deleted_at,i.created_at,i.updated_at,
             GREATEST(i.change_seq, COALESCE(uic.change_seq, 0)) AS change_seq
        FROM items i
        LEFT JOIN user_item_changes uic ON uic.item_id = i.id AND uic.user_id = $1
       WHERE GREATEST(i.change_seq, COALESCE(uic.change_seq, 0)) > $2
         AND (i.owner_user_id = $1 OR EXISTS (
           SELECT 1 FROM collections c
           JOIN org_members om ON om.org_id = c.org_id AND om.user_id = $1 AND om.status = 'confirmed'
           LEFT JOIN collection_members cm ON cm.collection_id = c.id AND cm.user_id = $1
          WHERE c.id = i.collection_id AND (
            om.role IN ('owner','admin') OR cm.can_view = true OR EXISTS (
              SELECT 1 FROM group_members gm
              JOIN collection_group_members cgm ON cgm.group_id = gm.group_id
              JOIN org_groups g ON g.id = gm.group_id AND g.org_id = c.org_id
             WHERE gm.user_id = $1 AND cgm.collection_id = c.id AND cgm.can_view = true)))
         )
       ORDER BY GREATEST(i.change_seq, COALESCE(uic.change_seq, 0)) ASC
       LIMIT 501`, [actorId, cursor]);
    const hasMore = result.rows.length > 500;
    const items = hasMore ? result.rows.slice(0, 500) : result.rows;
    response.json({ cursor: items.length ? items[items.length - 1].change_seq : cursor, hasMore, items });
  });

  app.post('/v1/audit', async(request: AuthenticatedRequest, response) => {
    const actorId = userId(request);
    const itemId = typeof request.body.itemId === 'string' ? request.body.itemId : null;
    let collectionId = typeof request.body.collectionId === 'string' ? request.body.collectionId : null;
    let orgId = typeof request.body.orgId === 'string' ? request.body.orgId : null;
    const action = requiredString(request.body.action, 'action');
    if (!/^[a-z][a-z0-9_]{1,79}$/.test(action)) throw new HttpError(400, 'action is invalid');
    let blocked = false;
    let reason: string | null = null;
    let item: Record<string, unknown> | undefined;
    if (itemId) {
      item = await authorizeItem(db, actorId, itemId, 'view');
      const itemCollectionId = typeof item.collection_id === 'string' ? item.collection_id : null;
      if (collectionId && itemCollectionId !== collectionId) {
        throw new HttpError(400, 'itemId does not belong to collectionId');
      }
      collectionId = itemCollectionId;
      if (!collectionId && orgId) throw new HttpError(400, 'A personal item cannot be audited under an organization');
    }
    if (collectionId) {
      try {
        await requireCollectionRight(db, actorId, collectionId, action === 'agent_credential_use' ? 'useByAgents' : 'view');
      } catch (error) {
        if (action !== 'agent_credential_use' || !(error instanceof AccessDenied)) throw error;
        blocked = true;
        reason = 'Your collection access does not allow agent use';
        await requireCollectionRight(db, actorId, collectionId, 'view');
      }
      const collection = await db.query<{ org_id: string }>('SELECT org_id FROM collections WHERE id = $1', [collectionId]);
      if (orgId && orgId !== collection.rows[0].org_id) {
        throw new HttpError(400, 'collectionId does not belong to orgId');
      }
      orgId = collection.rows[0].org_id;
    }
    if (action === 'agent_credential_use' && item) {
      const agentId = requiredString(request.body.agentId, 'agentId');
      const level = (request.body.level === 'full' || request.body.level === 'autofill' ? request.body.level : 'metadata') as AgentAccessLevel;
      const policyResult = agentPolicyAllows((item?.agent_policy ?? null) as Parameters<typeof agentPolicyAllows>[0], { agentId, level, host: typeof request.body.host === 'string' ? request.body.host : undefined, onServer: true });
      if (!policyResult.allowed || (!collectionId && !item.agent_wrapped_item_key)) {
        blocked = true;
        reason = !policyResult.allowed ? policyResult.reason ?? 'Agent policy denied this request' : 'Item is not enabled for agents';
      } else if ((item.agent_policy as { askFirst?: boolean } | null)?.askFirst) {
        blocked = true;
        reason = 'Owner approval is required, but server agent approval is not available';
      }
    }
    if (orgId && !collectionId) {
      const membership = await db.query(
        "SELECT 1 FROM org_members WHERE org_id = $1 AND user_id = $2 AND status = 'confirmed'", [orgId, actorId],
      );
      if (!membership.rowCount) throw new AccessDenied('Organization access denied');
    }
    if (request.body.deviceId) {
      const device = await db.query('SELECT 1 FROM devices WHERE id = $1 AND user_id = $2', [request.body.deviceId, actorId]);
      if (!device.rowCount) throw new AccessDenied('Device access denied');
    }
    const podId = request.body.podId === undefined ? null : requiredString(request.body.podId, 'podId');
    if (podId && !/^[A-Za-z0-9._:-]{1,160}$/.test(podId)) throw new HttpError(400, 'podId is invalid');
    const result = await db.query(
      `INSERT INTO audit_log(actor_user_id, device_id, org_id, collection_id, item_id, action, pod_id, metadata, blocked, reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id, created_at, blocked, reason`,
      [actorId, request.body.deviceId ?? null, orgId, collectionId,
        itemId, action, podId, sanitizedAuditMetadata(request.body.metadata), blocked, reason],
    );
    if (blocked) { response.status(403).json({ error: 'agent_blocked', reason, auditId: result.rows[0].id }); return; }
    response.status(201).json(result.rows[0]);
  });

  app.use((error: unknown, request: AuthenticatedRequest, response: Response, _next: NextFunction) => {
    if (error instanceof LocalVaultError) {
      if (request.path.startsWith('/v1/broker/')) response.setHeader('X-Sulla-Vault-Error', error.code);
      response.status(error.status).json({
        error: error.code,
        message: error.code === 'approval_required' ? 'Owner approval is required' : error.message,
        ...(error.code === 'approval_required' ? { operationId: error.message } : {}),
      });
      return;
    }
    if (error instanceof AccessDenied) {
      response.status(403).json({ error: 'forbidden' });
      return;
    }
    if (error instanceof HttpError) {
      response.status(error.status).json({ error: error.message });
      return;
    }
    if (typeof error === 'object' && error && 'code' in error && error.code === '23505') {
      response.status(409).json({ error: 'already_exists' });
      return;
    }
    console.error(error);
    response.status(500).json({ error: 'internal_error' });
  });

  return app;
}
