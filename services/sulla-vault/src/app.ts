// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { timingSafeEqual } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import express, { type NextFunction, type Request, type Response } from 'express';

import { LocalVaultAuthority, LocalVaultError } from './localAuthority.js';
import { UPSTREAM_RETRY_AFTER_SECONDS, describeUpstreamError, isUpstreamNetworkError, upstreamFailurePhase, upstreamFailureReason } from './upstreamEgress.js';
import { FilesAuditEmitter } from './filesAudit.js';
import { VaultFilesKeyBundleAuthority } from './filesKeyBundleAuthority.js';
import { createFilesKeyBundleRouter } from './filesKeyBundleRoutes.js';
import { registerCloudSyncRoutes } from './browserEnvelope/routes.js';
import { CloudVaultSyncRunner } from './browserEnvelope/syncRunner.js';
import { DomainVaultSyncCodecProvider } from './browserEnvelope/DomainVaultSyncCodecProvider.js';
import { FilesCloudEscrowService, registerFilesCloudEscrowRoute } from './filesCloudEscrow.js';

import type { VaultConfig } from './config.js';
import { isTransientDbError, warnDatabaseUnavailable } from './db.js';
import type { Database } from './db.js';

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

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AUDIT_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$/;

function sanitizedAuditMetadata(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const input = value as Record<string, unknown>;
  const metadata: Record<string, string> = {};
  for (const key of ['agentId', 'operation', 'serviceId', 'threadId', 'jobId', 'workflowExecutionId', 'integrationId'] as const) {
    if (typeof input[key] === 'string' && AUDIT_IDENTIFIER_PATTERN.test(input[key])) metadata[key] = input[key];
  }
  if (typeof input.agentName === 'string' && input.agentName.length > 0 && input.agentName.length <= 160 && !/[\u0000-\u001f\u007f]/.test(input.agentName)) {
    metadata.agentName = input.agentName;
  }
  if (typeof input.requestedItemId === 'string' && UUID_PATTERN.test(input.requestedItemId)) {
    metadata.requestedItemId = input.requestedItemId;
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

function safeTokenEqual(actual: string | undefined, expected: string | undefined): boolean {
  if (!actual || !expected) return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function createApp(db: Database, config: VaultConfig, options: { localAuthority?: LocalVaultAuthority } = {}) {
  const app = express();
  const domainSyncCodec = new DomainVaultSyncCodecProvider();
  const localAuthority = options.localAuthority ?? new LocalVaultAuthority(db, config);
  const filesKeyBundleAuthority = new VaultFilesKeyBundleAuthority(db, localAuthority);
  const filesAudit = new FilesAuditEmitter(config);
  app.disable('x-powered-by');
  app.use((request, response, next) => {
    const origin = request.header('origin');
    const allowed = Boolean(origin && (origin.startsWith('chrome-extension://') || config.extensionOrigins.includes(origin)));
    if (allowed) {
      response.setHeader('Access-Control-Allow-Origin', origin as string);
      response.setHeader('Vary', 'Origin');
      response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Sulla-Accounts-Authorization, X-Sulla-Accounts-Authority-Id, X-Sulla-Authority-Id, X-Sulla-Organization-Id');
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
      response.setHeader('Access-Control-Allow-Credentials', 'true');
    }
    if (request.method === 'OPTIONS') { response.status(allowed ? 204 : 403).end(); return; }
    next();
  });
  app.use(express.json({ limit: '36mb' }));

  app.get('/healthz', async(_request, response) => {
    try {
      await db.query('SELECT 1');
    } catch (error) {
      // Report unhealthy while Postgres is down; keep the process (and logs) calm.
      if (!isTransientDbError(error)) throw error;
      warnDatabaseUnavailable(error);
      response.status(503).json({ ok: false, error: 'database_unavailable' });
      return;
    }
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

  app.use('/v1/desktop/files', createFilesKeyBundleRouter(filesKeyBundleAuthority!, {
    serviceId: config.filesServiceId!,
    token: config.filesServiceToken!,
  },(id,target)=>localAuthority.backupCredentials(id,'s3',target)));
  app.post('/v1/desktop/backup-credentials',async(request,response)=>{
    const identity=serviceIdentity(request);
    if(identity.serviceId!==config.approvalServiceId || !safeTokenEqual(identity.token,config.approvalServiceToken)) return response.sendStatus(401);
    response.setHeader('Cache-Control','no-store');
    response.json(await localAuthority.backupCredentials(requiredString(request.body.itemId,'itemId'),'nas',requiredString(request.body.target,'target')));
  });
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
  app.get('/v1/desktop/status', async(request, response) => {
    const identity = serviceIdentity(request);
    localAuthority.requireControlIdentity(identity.serviceId, identity.token);
    const status = localAuthority.status();
    const setupRequired = !status.unlocked && await localAuthority.isSetupRequired();
    response.json({ ...status, setup: { required: setupRequired }, migration: { required: status.state === 'migration_required', error: status.state === 'migration_failed' ? 'migration_failed' : undefined } });
  });
  app.post('/v1/desktop/lock', async(request, response) => {
    const identity = serviceIdentity(request);
    localAuthority.requireControlIdentity(identity.serviceId, identity.token);
    await localAuthority.lock();
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
  app.post('/v1/human/session/exchange', async(request, response) => {
    const session = localAuthority.exchangeHumanGrant(
      requiredString(request.body.grant, 'grant'), requiredString(request.body.csrf, 'csrf'),
    );
    setHumanCookie(response, session.sessionId, session.expiresAt);
    const setupRequired = session.phase === 'pre-unlock' && await localAuthority.isSetupRequired();
    response.json({ csrf: session.csrf, expiresAt: session.expiresAt, phase: session.phase, targetOrigin: session.browserTarget?.origin, setupRequired });
  });
  app.get('/v1/human/session', async(request, response) => {
    const status = localAuthority.humanSessionStatus(humanCookie(request), request.header('x-csrf-token'));
    const setupRequired = status.phase === 'pre-unlock' && await localAuthority.isSetupRequired();
    response.json({ ...status, setupRequired });
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
  app.post('/v1/human/lock', async(request, response) => {
    const result = await localAuthority.lockHumanSession(humanCookie(request), request.header('x-csrf-token'));
    setHumanCookie(response, result.sessionId, result.expiresAt);
    response.json({ csrf: result.csrf, expiresAt: result.expiresAt, phase: result.phase, state: result.state });
  });
  app.get('/v1/human/items', async(request, response) => {
    response.json({ items: await localAuthority.listHumanItems(humanCookie(request), request.header('x-csrf-token')) });
  });
  app.post('/v1/human/import/bitwarden/preview', async(request,response)=>{
    response.json(await localAuthority.previewBitwardenImport(humanCookie(request),request.header('x-csrf-token'),request.body));
  });
  app.post('/v1/human/import/bitwarden', async(request,response)=>{
    response.json(await localAuthority.importBitwarden(humanCookie(request),request.header('x-csrf-token'),request.body));
  });
  app.get('/v1/human/activity', async(request, response) => {
    const sessionId = humanCookie(request);
    const csrf = request.header('x-csrf-token');
    const session = localAuthority.humanSessionStatus(sessionId, csrf);
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
    const currentSession = localAuthority.humanSessionStatus(sessionId, csrf);
    if (currentSession.phase !== 'unlocked' || localAuthority.status().principalId !== principalId) {
      throw new LocalVaultError('vault_locked', 423, 'Vault locked during audit request');
    }
    response.json({ events, hasMore, limit, offset });
  });
  app.post('/v1/human/items', async(request, response) => {
    const result = await localAuthority.saveHumanItem(humanCookie(request), request.header('x-csrf-token'), request.body);
    response.status(201).json(result);
  });
  app.post('/v1/human/items/:itemId/reveal', async(request, response) => {
    const itemId = requiredString(request.params.itemId, 'itemId');
    const result = await localAuthority.revealHumanItem(humanCookie(request), request.header('x-csrf-token'), itemId);
    response.json(result);
  });
  app.patch('/v1/human/items/:itemId', async(request, response) => {
    const itemId = requiredString(request.params.itemId, 'itemId');
    const result = await localAuthority.saveHumanItem(humanCookie(request), request.header('x-csrf-token'), { ...request.body, id: itemId });
    response.json(result);
  });
  app.delete('/v1/human/items/:itemId', async(request, response) => {
    const itemId = requiredString(request.params.itemId, 'itemId');
    await localAuthority.deleteHumanItem(humanCookie(request), request.header('x-csrf-token'), itemId, Number(request.query.revision));
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
  app.post('/v1/broker/items', async(request, response) => {
    const identity = serviceIdentity(request);
    response.json(await localAuthority.listBrokerItems(request.body.claims, identity.serviceId, identity.token));
  });
  app.post('/v1/broker/items/create', async(request, response) => {
    const identity = serviceIdentity(request);
    response.status(201).json(await localAuthority.createAgentVaultItem(identity.serviceId, identity.token, request.body));
  });
  app.patch('/v1/broker/items/:itemId', async(request, response) => {
    const identity = serviceIdentity(request);
    response.json(await localAuthority.updateAgentVaultItem(identity.serviceId, identity.token, { ...request.body, itemId: requiredString(request.params.itemId, 'itemId') }));
  });
  app.put('/v1/broker/integrations/:integrationId/credential', async(request, response) => {
    const identity = serviceIdentity(request);
    response.json(await localAuthority.setAgentIntegrationCredential(identity.serviceId, identity.token, { ...request.body, integrationId: requiredString(request.params.integrationId, 'integrationId') }));
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
  app.put('/v1/broker/integrations/:integrationId/oauth-account', async(request, response) => {
    const identity = serviceIdentity(request);
    response.json(await localAuthority.ensureOAuthAccount(
      identity.serviceId, identity.token, requiredString(request.params.integrationId, 'integrationId'), request.body,
    ));
  });
  app.put('/v1/broker/integrations/:integrationId/desktop-account', async(request, response) => {
    const identity = serviceIdentity(request);
    response.json(await localAuthority.importDesktopIntegrationAccount(
      identity.serviceId, identity.token, requiredString(request.params.integrationId, 'integrationId'), request.body,
    ));
  });
  const filesCloudEscrow = new FilesCloudEscrowService(db, {
    withUnlockedUserKey: operation => localAuthority.withUnlockedUserKey(operation),
    sullaCloudRequest: input => localAuthority.executeDesktopSullaCloudRequest(
      config.approvalServiceId ?? '', config.approvalServiceToken, input,
    ),
  }, filesAudit, domainSyncCodec);
  app.put('/v1/broker/sulla-cloud/session', async(request, response) => {
    const identity = serviceIdentity(request);
    response.json(await localAuthority.adoptSullaCloudSession(identity.serviceId, identity.token, request.body));
  });
  app.delete('/v1/broker/sulla-cloud/session', async(request, response) => {
    const identity = serviceIdentity(request);
    const result = await localAuthority.clearSullaCloudSession(identity.serviceId, identity.token);
    filesCloudEscrow.clearCloudSessionKey();
    response.json(result);
  });
  app.post('/v1/broker/sulla-cloud/account-wrap', async(request, response) => {
    const identity = serviceIdentity(request);
    response.json(await localAuthority.rewrapForAccountPassword(identity.serviceId, identity.token, request.body));
  });
  app.post('/v1/broker/sulla-cloud/device-approval-wrap', async(request, response) => {
    const identity = serviceIdentity(request);
    response.json(await localAuthority.wrapUserKeyForApprovedDevice(identity.serviceId, identity.token, request.body));
  });
  app.post('/v1/broker/sulla-cloud/enrollment-wrap', async(request,response)=>{ const identity=serviceIdentity(request); response.json(await localAuthority.wrapVaultEnrollment(identity.serviceId,identity.token,request.body)); });
  app.post('/v1/broker/sulla-cloud/enrollment-adopt', async(request,response)=>{ const identity=serviceIdentity(request); response.json(await localAuthority.adoptVaultEnrollment(identity.serviceId,identity.token,request.body)); });
  app.post('/v1/broker/sulla-cloud/enrollment-commit', async(request,response)=>{ const identity=serviceIdentity(request); localAuthority.requireApprovalIdentity(identity.serviceId,identity.token); response.json(await localAuthority.commitVaultEnrollment(identity.serviceId,identity.token,requiredString(request.body?.requestId,'requestId'))); });
  app.post('/v1/broker/sulla-cloud/recovery-key/rotate', async(request, response) => {
    const identity = serviceIdentity(request);
    response.json(await localAuthority.rotateAccountRecoveryKey(identity.serviceId, identity.token));
  });
  app.post('/v1/broker/sulla-cloud/request', async(request, response) => {
    const identity = serviceIdentity(request);
    response.json(await localAuthority.executeDesktopSullaCloudRequest(identity.serviceId, identity.token, request.body));
  });
  registerFilesCloudEscrowRoute(app, filesCloudEscrow, request => {
    // Main calls with the approval service identity; Files/agents cannot invoke this route directly.
    const identity = serviceIdentity(request);
    localAuthority.requireApprovalIdentity(identity.serviceId, identity.token);
  }, request => { localAuthority.humanSessionStatus(humanCookie(request), request.header('x-csrf-token')); });
  // Passwords sync v3: the container builds/applies every body; main only signs hashes.
  registerCloudSyncRoutes(app, new CloudVaultSyncRunner(db, {
    withUnlockedUserKey: operation => localAuthority.withUnlockedUserKey(operation),
    sullaCloudRequest: input => localAuthority.executeDesktopSullaCloudRequest(
      config.approvalServiceId ?? '', config.approvalServiceToken, input,
    ),
  }, domainSyncCodec), request => {
    const identity = serviceIdentity(request);
    localAuthority.requireApprovalIdentity(identity.serviceId, identity.token);
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
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors app:");
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cache-Control', 'no-store');
    next();
  }, express.static(resolve(dirname(fileURLToPath(import.meta.url)), '../console/local')));

  // Any other /v1 path is refused. The local vault never exposes wrapped keys,
  // JWT CRUD, or the retired broker credential endpoint, even to a token issued
  // before a lock. (The hosted ciphertext API moved to merchantprotocol/sulla-server.)
  app.use('/v1', (_request, response) => {
    response.status(404).json({ error: 'not_found', message: 'This API is unavailable in local vault mode' });
  });

  app.use((error: unknown, request: Request, response: Response, _next: NextFunction) => {
    if (error instanceof LocalVaultError) {
      // Egress failures are transient path problems (network change, DNS, VPN), not policy decisions.
      const retryable = error.code === 'upstream_failed' || error.code === 'upstream_timeout';
      if (request.path.startsWith('/v1/broker/')) {
        response.setHeader('X-Sulla-Vault-Error', error.code);
        if (error.reason) response.setHeader('X-Sulla-Vault-Error-Reason', error.reason);
        if (retryable && error.status !== 499) response.setHeader('Retry-After', String(UPSTREAM_RETRY_AFTER_SECONDS));
      }
      response.status(error.status).json({
        error: error.code,
        message: error.code === 'approval_required' ? 'Owner approval is required' : error.message,
        ...(error.code === 'approval_required' ? { operationId: error.message } : {}),
        ...(error.reason ? { reason: error.reason } : {}),
        ...(retryable && error.status !== 499 ? { retryable: true } : {}),
      });
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
    if (isTransientDbError(error)) {
      warnDatabaseUnavailable(error);
      response.setHeader('Retry-After', '5');
      response.status(503).json({ error: 'database_unavailable' });
      return;
    }
    if (isUpstreamNetworkError(error)) {
      // An outbound fetch (provider, Sulla Cloud) failed; Postgres is fine. Report it as the egress failure it is.
      const detail = describeUpstreamError(error);
      const reason = upstreamFailureReason(upstreamFailurePhase(detail.code, false), detail.code);
      console.warn(`sulla-vault: upstream request failed (${ reason })`);
      response.setHeader('Retry-After', String(UPSTREAM_RETRY_AFTER_SECONDS));
      response.status(502).json({ error: 'upstream_failed', message: 'Upstream request failed', reason, retryable: true });
      return;
    }
    console.error(error);
    response.status(500).json({ error: 'internal_error' });
  });

  return app;
}
