// Copyright © 2026 Merchant Protocol, LLC. All rights reserved.
// Licensed under the Sulla Fair-Code License. See LICENSE.

// Server-mode /cloud-vault-sync/*: the API Sulla Cloud's Passwords page
// already speaks, over this Vault's own ciphertext store.
//
//   GET    /status                          bearer (Console API) or vault cookie: metadata only
//   POST   /browser/handoff                 bearer only: one-time code for the vault origin
//   POST   /browser/session                 vault origin: code -> __Host- HttpOnly cookie
//   GET    /browser/session                 vault origin: who is signed in
//   DELETE /browser/session                 vault origin: sign out (revokes the session)
//   GET    /browser/devices                 vault origin: this member's enrolled devices
//   GET    /audit                           metadata-only vault events (newest first)
//   GET    /vaults/:vaultId/enrollment      vault origin: the unsigned bundle fields to MAC on first unlock
//   PUT    /vaults/:vaultId?op=create|rewrap  vault origin: store the member's MAC'd bundle
//   GET    /vaults/:vaultId/bundle          vault origin: the member's bundle (?include=collections adds
//                                           the wrapped keys of every collection they can read)
//   GET    /vaults/:vaultId/records         vault origin: paged ciphertext records + head for one scope
//   POST   /vaults/:vaultId/commit          vault origin: CAS writes for one scope
//
// The org vault: one vaultId per organization; each member has their own
// bundle (their wrapped user key) and personal scope; shared collections are
// scopes keyed by collection id, readable only with the collection's `view`
// right and writable only with `edit`. A scope the member can't read is 404.
//
// Ciphertext only: the server never holds a key, never decrypts, and these
// handlers never log request or response bodies.

import express, { type NextFunction, type Request, type Response } from 'express';

import { authenticate, type AuthenticatedRequest } from '../auth.js';
import {
  InvalidBody,
  isScope,
  isUuid,
  validateCommitBody,
  validateCreateBody,
  validateRewrapBody,
} from './validator.js';
import { listAudit, recordAudit, type BrowserSyncEvent } from './audit.js';
import {
  createHandoff,
  exchangeHandoff,
  keyedHash,
  loadSession,
  onVaultHost,
  readSessionToken,
  revokeSession,
  sessionCookie,
  SESSION_TTL_MS,
  vaultRequestAllowed,
  type BrowserSession,
} from './session.js';
import {
  bundleMatchesAccount,
  commit,
  createPersonalVault,
  expectedBundleFields,
  findMember,
  getBundle,
  getHead,
  listRecords,
  orgVaultId,
  readableCollections,
  resolveScope,
  rewrapBundle,
  scopeStats,
  type Member,
} from './store.js';

import type { BrowserSyncConfig } from './config.js';
import type { VaultConfig } from '../config.js';
import type { Database } from '../db.js';

interface SyncRequest extends AuthenticatedRequest {
  syncCaller?:  'bearer' | 'browser';
  syncMember?:  Member;
  syncSession?: BrowserSession;
}

type Handler = (request: SyncRequest, response: Response) => Promise<unknown>;

class SyncError extends Error {
  constructor(public readonly status: number, public readonly code: string) {
    super(code);
  }
}

const ORG_LABEL = /^[^\u0000-\u001f\u007f]{1,120}$/;
const DEVICE_ONLINE_MS = 2 * 60 * 1000;

/**
 * A small fixed-window limiter per route, enough to blunt code guessing. Keyed by
 * the signed-in member where there is one: behind the gateway every request
 * shares one client address, so an address key would throttle the whole server.
 */
function rateLimit(limit: number, windowMs: number) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (request: Request, response: Response, next: NextFunction): void => {
    const caller = (request as SyncRequest).syncMember?.userId;
    const key = caller ?? `ip:${ request.ip ?? 'unknown' }`;
    const now = Date.now();
    if (hits.size > 10_000) {
      for (const [entry, window] of hits) {
        if (window.resetAt <= now) hits.delete(entry);
      }
    }
    const current = hits.get(key);
    if (!current || current.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }
    if (current.count >= limit) {
      response.status(429).json({ error: 'rate_limited' });
      return;
    }
    current.count += 1;
    next();
  };
}

function route(handler: Handler) {
  return (request: Request, response: Response, next: NextFunction): void => {
    handler(request as SyncRequest, response).catch(next);
  };
}

function member(request: SyncRequest): Member {
  if (!request.syncMember) throw new SyncError(401, 'unauthorized');
  return request.syncMember;
}

function browserOnly(request: SyncRequest): BrowserSession {
  if (request.syncCaller !== 'browser' || !request.syncSession) throw new SyncError(401, 'unauthorized');
  return request.syncSession;
}

/** The org vault in the URL must be the caller's own org vault; anything else is 404. */
async function ownVault(db: Database, request: SyncRequest): Promise<string> {
  const vaultId = request.params.vaultId;
  const vault = await orgVaultId(db, member(request).orgId);
  if (!isUuid(vaultId) || vaultId !== vault) throw new SyncError(404, 'not_found');
  return vault;
}

function initials(label: string | null): string | null {
  const words = (label ?? '').match(/[\p{L}\p{N}]+/gu) ?? [];
  const letters = words.slice(0, 2).map(word => word[0]).join('');
  return letters ? letters.toUpperCase() : null;
}

/** Organization for a bearer call: the Accounts token's org, else an explicit header checked against membership. */
function bearerOrg(request: SyncRequest): string {
  const fromAccounts = request.auth?.source === 'accounts' ? request.auth.organizationId : undefined;
  const requested = request.header('x-sulla-organization-id') ?? undefined;
  if (fromAccounts && requested && requested !== fromAccounts) throw new SyncError(403, 'organization_mismatch');
  const orgId = fromAccounts ?? requested;
  if (!isUuid(orgId)) throw new SyncError(400, 'organization_required');
  return orgId;
}

export function createBrowserSyncRouter(db: Database, config: VaultConfig, sync: BrowserSyncConfig): express.Router {
  const router = express.Router();
  const bearerAuth = authenticate(config, db);
  const audit = (
    request: SyncRequest,
    event: BrowserSyncEvent,
    detail: Record<string, string | number | boolean | null> = {},
    collectionId: string | null = null,
  ) => {
    const caller = member(request);
    return recordAudit(db, { userId: caller.userId, orgId: caller.orgId, event, detail, collectionId });
  };

  // Every response is no-store: ciphertext and session state must never sit in a cache.
  router.use((_request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  // Auth: a bearer (the Console API with the user's UI-session token) or the vault-origin cookie.
  router.use((request: SyncRequest, response, next) => {
    if (request.header('authorization')) {
      bearerAuth(request, response, () => {
        let orgId: string;
        try {
          orgId = bearerOrg(request);
        } catch (error) {
          next(error);
          return;
        }
        findMember(db, request.auth!.userId, orgId).then((found) => {
          if (!found) throw new SyncError(404, 'not_found');
          request.syncCaller = 'bearer';
          request.syncMember = found;
          next();
        }).catch(next);
      });
      return;
    }
    if (request.method === 'POST' && request.path === '/browser/session') {
      next();
      return;
    }
    const token = readSessionToken(request.header('cookie'));
    if (!token || !onVaultHost(sync, request)) {
      response.status(401).json({ error: 'unauthorized' });
      return;
    }
    if (!vaultRequestAllowed(sync, request)) {
      response.status(403).json({ error: 'forbidden_origin' });
      return;
    }
    loadSession(db, token).then(async(session) => {
      if (!session) {
        response.status(401).json({ error: 'session_expired' });
        return;
      }
      // Membership is re-checked on every request: removing someone from the org ends their vault session.
      const found = await findMember(db, session.userId, session.orgId);
      if (!found) {
        await revokeSession(db, session.id);
        response.status(401).json({ error: 'session_expired' });
        return;
      }
      request.syncCaller = 'browser';
      request.syncSession = session;
      request.syncMember = found;
      next();
    }).catch(next);
  });

  // ── Status ──────────────────────────────────────────────────────────
  router.get('/status', route(async(request, response) => {
    const caller = member(request);
    const vaultId = await orgVaultId(db, caller.orgId);
    const bundle = await getBundle(db, vaultId, caller.userId);
    const collections = await readableCollections(db, caller);
    if (!bundle) {
      return response.json({
        enabled:     false,
        orgId:       caller.orgId,
        vaultId,
        setup:       'enroll',
        collections: collections.length,
      });
    }
    const expected = await expectedBundleFields(db, caller, vaultId, bundle.bundle_generation, bundle.epoch);
    if (!expected || !bundleMatchesAccount(bundle.bundle, expected)) {
      return response.json({
        enabled:          false,
        orgId:            caller.orgId,
        vaultId,
        setup:            'rewrap',
        bundleGeneration: bundle.bundle_generation,
      });
    }
    const head = await getHead(db, vaultId, caller.userId);
    const stats = await scopeStats(db, vaultId, caller.userId);
    return response.json({
      enabled:                true,
      orgId:                  caller.orgId,
      vaultId,
      headSeq:                head?.seq ?? 0,
      recordCount:            stats.itemCount,
      itemCount:              stats.itemCount,
      bytes:                  stats.bytes,
      collections:            collections.length,
      syncPaused:             false,
      epoch:                  bundle.epoch,
      bundleGeneration:       bundle.bundle_generation,
      sourceDeviceId:         null,
      sourceDeviceName:       'Sulla Server',
      sourceDeviceLastSeenAt: null,
      lastPushAt:             stats.lastWriteAt,
      updatedAt:              bundle.updated_at,
    });
  }));

  // ── Handoff and browser session ─────────────────────────────────────
  router.post('/browser/handoff', rateLimit(30, 60_000), route(async(request, response) => {
    if (request.syncCaller !== 'bearer') throw new SyncError(401, 'unauthorized');
    if (!sync.vaultHost) throw new SyncError(404, 'vault_origin_not_configured');
    const caller = member(request);
    const label = request.body?.organizationName;
    const orgLabel = typeof label === 'string' && ORG_LABEL.test(label.trim()) ? label.trim() : null;
    response.status(201).json(await createHandoff(db, caller.userId, caller.orgId, orgLabel));
  }));

  router.post('/browser/session', rateLimit(300, 60_000), route(async(request, response) => {
    if (!vaultRequestAllowed(sync, request)) throw new SyncError(403, 'forbidden_origin');
    const exchanged = await exchangeHandoff(db, request.body?.code, {
      ipHash: keyedHash(config.jwtSecret, 'ip', request.ip),
      uaHash: keyedHash(config.jwtSecret, 'ua', request.header('user-agent')),
    });
    if (!exchanged) throw new SyncError(401, 'handoff_invalid');
    const found = await findMember(db, exchanged.session.userId, exchanged.session.orgId);
    if (!found) {
      await revokeSession(db, exchanged.session.id);
      throw new SyncError(401, 'handoff_invalid');
    }
    request.syncMember = found;
    await audit(request, 'browser_session_started', { ipHash: keyedHash(config.jwtSecret, 'ip', request.ip) });
    response.setHeader('Set-Cookie', sessionCookie(exchanged.token, Math.floor(SESSION_TTL_MS / 1000)));
    response.status(201).json({ expiresAt: exchanged.session.expiresAt });
  }));

  router.get('/browser/session', route(async(request, response) => {
    const session = browserOnly(request);
    const caller = member(request);
    const user = await db.query<{ id: string; email: string; display_name: string | null }>(
      'SELECT id, email, display_name FROM users WHERE id = $1',
      [caller.userId],
    );
    const row = user.rows[0];
    // Accounts-onboarded members carry an opaque placeholder address; never show it as an email.
    const email = row && !row.email.endsWith('@identity.invalid') ? row.email : null;
    const orgName = session.orgLabel ?? 'Organization';
    response.json({
      session: { expiresAt: session.expiresAt, createdAt: session.createdAt, reauthAt: null },
      user:    row ? { id: row.id, name: row.display_name, email, businessName: orgName } : null,
      org:     { id: caller.orgId, name: orgName, role: caller.role, initials: initials(orgName) },
    });
  }));

  router.delete('/browser/session', route(async(request, response) => {
    const session = browserOnly(request);
    await revokeSession(db, session.id);
    await audit(request, 'browser_session_ended');
    response.setHeader('Set-Cookie', sessionCookie('', 0));
    response.json({ ok: true });
  }));

  router.get('/browser/devices', route(async(request, response) => {
    browserOnly(request);
    const devices = await db.query<{ id: string; name: string; last_seen_at: Date }>(
      'SELECT id, name, last_seen_at FROM devices WHERE user_id = $1 ORDER BY last_seen_at DESC LIMIT 50',
      [member(request).userId],
    );
    response.json({
      devices: devices.rows.map(device => ({
        id:         device.id,
        name:       device.name,
        deviceType: 'desktop',
        platform:   'desktop',
        online:     Date.now() - device.last_seen_at.getTime() < DEVICE_ONLINE_MS,
        lastSeenAt: device.last_seen_at.toISOString(),
      })),
    });
  }));

  // Step-up email codes and deleting the vault copy are Cloud features with no server equivalent yet.
  router.post('/browser/stepup/:step', (_request, response) => {
    response.status(404).json({ error: 'not_available' });
  });

  router.get('/audit', route(async(request, response) => {
    const before = request.query.before;
    if (before !== undefined && (typeof before !== 'string' || !/^\d{1,18}$/.test(before))) {
      throw new SyncError(400, 'invalid_query');
    }
    response.json(await listAudit(db, member(request), before === undefined ? null : Number(before)));
  }));

  // ── Enrollment and bundle (vault origin only) ───────────────────────
  router.get('/vaults/:vaultId/enrollment', route(async(request, response) => {
    browserOnly(request);
    const vaultId = await ownVault(db, request);
    const caller = member(request);
    const current = await getBundle(db, vaultId, caller.userId);
    const generation = current ? current.bundle_generation + 1 : 1;
    const fields = await expectedBundleFields(db, caller, vaultId, generation, current?.epoch ?? 1);
    if (!fields) throw new SyncError(404, 'not_found');
    response.json({
      op:                       current ? 'rewrap' : 'create',
      fields,
      expectedBundleGeneration: current?.bundle_generation ?? 0,
    });
  }));

  router.put('/vaults/:vaultId', route(async(request, response) => {
    browserOnly(request);
    const vaultId = await ownVault(db, request);
    const caller = member(request);
    const op = request.query.op;
    if (op === 'create') {
      const body = validateCreateBody(request.body, vaultId, caller.userId);
      const expected = await expectedBundleFields(db, caller, vaultId, body.bundle.bundleGeneration, body.bundle.epoch);
      if (!expected || !bundleMatchesAccount(body.bundle, expected)) throw new InvalidBody('bundle_mismatch', 409);
      const created = await createPersonalVault(db, caller, vaultId, body);
      if (!created.ok) throw new SyncError(409, created.error);
      const detail = { records: body.records.length, epoch: body.bundle.epoch, seq: body.head.seq };
      await audit(request, 'bundle_created', detail);
      return response.status(201).json({ ok: true, vaultId, headSeq: body.head.seq });
    }
    if (op === 'rewrap') {
      const body = validateRewrapBody(request.body, vaultId, caller.userId);
      const expected = await expectedBundleFields(db, caller, vaultId, body.bundle.bundleGeneration, body.bundle.epoch);
      if (!expected || !bundleMatchesAccount(body.bundle, expected)) throw new InvalidBody('bundle_mismatch', 409);
      if (!await rewrapBundle(db, caller, vaultId, body.bundle, body.expectedBundleGeneration)) {
        throw new SyncError(409, 'bundle_stale');
      }
      await audit(request, 'bundle_rewrapped', { bundleGeneration: body.bundle.bundleGeneration });
      return response.json({ ok: true, bundleGeneration: body.bundle.bundleGeneration });
    }
    throw new SyncError(404, 'not_found');
  }));

  router.get('/vaults/:vaultId/bundle', route(async(request, response) => {
    const session = browserOnly(request);
    const vaultId = await ownVault(db, request);
    const caller = member(request);
    // Fresh-auth window: a bundle is only handed out within 12 hours of the console sign-in handoff.
    if (Date.now() - Date.parse(session.createdAt) > SESSION_TTL_MS) throw new SyncError(401, 'session_expired');
    const stored = await getBundle(db, vaultId, caller.userId);
    if (!stored) throw new SyncError(404, 'not_found');
    // After a password change the stored bundle would still open with the old password: refuse it.
    const expected = await expectedBundleFields(db, caller, vaultId, stored.bundle_generation, stored.epoch);
    if (!expected || !bundleMatchesAccount(stored.bundle, expected)) throw new SyncError(409, 'bundle_stale');
    await audit(request, 'bundle_downloaded', { ipHash: keyedHash(config.jwtSecret, 'ip', request.ip) });
    if (request.query.include !== 'collections') return response.json(stored.bundle);
    const memberKey = await db.query<{ wrapped_org_key: unknown }>(
      'SELECT wrapped_org_key FROM org_members WHERE org_id = $1 AND user_id = $2',
      [caller.orgId, caller.userId],
    );
    const collections = [];
    for (const collection of await readableCollections(db, caller)) {
      const head = await getHead(db, vaultId, collection.collectionId);
      collections.push({
        collectionId:         collection.collectionId,
        encryptedName:        collection.encryptedName,
        wrappedCollectionKey: collection.wrappedCollectionKey,
        rights:               { view: collection.canView, edit: collection.canEdit, manage: collection.canManage },
        headSeq:              head?.seq ?? 0,
      });
    }
    const wrappedOrgKey = memberKey.rows[0]?.wrapped_org_key ?? null;
    return response.json({ bundle: stored.bundle, wrappedOrgKey, collections });
  }));

  // ── Ciphertext reads and writes ─────────────────────────────────────
  router.get('/vaults/:vaultId/records', route(async(request, response) => {
    browserOnly(request);
    const vaultId = await ownVault(db, request);
    const caller = member(request);
    const scope = request.query.scope ?? 'personal';
    const since = Number(request.query.since ?? '0');
    const limit = Number(request.query.limit ?? '500');
    const validSince = Number.isSafeInteger(since) && since >= 0;
    const validLimit = Number.isSafeInteger(limit) && limit >= 1 && limit <= 500;
    const validPage = validSince && validLimit;
    if (!isScope(scope) || !validPage) throw new SyncError(400, 'invalid_query');
    let cursor: { seq: number; id: string } | null = null;
    if (request.query.cursor !== undefined) {
      const raw = request.query.cursor;
      const match = typeof raw === 'string' ? /^(\d{1,15}):([0-9a-f-]{36})$/.exec(raw) : null;
      if (!match || !isUuid(match[2])) throw new SyncError(400, 'invalid_query');
      cursor = { seq: Number(match[1]), id: match[2] };
    }
    const ref = await resolveScope(db, caller, scope);
    if (!ref) throw new SyncError(404, 'not_found');
    const page = await listRecords(db, vaultId, ref.scopeOwner, since, cursor, limit);
    if (!cursor) {
      const kind = scope === 'personal' ? 'personal' : 'collection';
      const collectionId = scope === 'personal' ? null : scope;
      await audit(request, 'records_downloaded', { scope: kind, since, count: page.records.length }, collectionId);
    }
    const bundle = await getBundle(db, vaultId, caller.userId);
    response.json({
      ...page,
      syncPaused:       false,
      bundleGeneration: bundle?.bundle_generation ?? 0,
      epoch:            bundle?.epoch ?? 1,
    });
  }));

  router.post('/vaults/:vaultId/commit', rateLimit(120, 60_000), route(async(request, response) => {
    browserOnly(request);
    const vaultId = await ownVault(db, request);
    const caller = member(request);
    let body;
    try {
      body = validateCommitBody(request.body, vaultId);
    } catch (error) {
      if (error instanceof InvalidBody) {
        await audit(request, 'validator_rejected', { reason: error.reason.slice(0, 80) });
      }
      throw error;
    }
    const ref = await resolveScope(db, caller, body.scope);
    if (!ref) throw new SyncError(404, 'not_found');
    if (!ref.writable) throw new SyncError(403, 'edit_required');
    if (body.scope === 'personal' && !await getBundle(db, vaultId, caller.userId)) {
      throw new SyncError(404, 'not_found');
    }
    const collectionId = body.scope === 'personal' ? null : body.scope;
    const result = await commit(db, vaultId, ref, body);
    if (result.ok) {
      await audit(request, 'commit_accepted', { count: result.written, seq: result.seq }, collectionId);
      return response.json({ ok: true, headSeq: result.seq });
    }
    await audit(request, 'commit_conflict', { kind: result.error }, collectionId);
    if (result.error === 'too_many_records') return response.status(413).json({ error: result.error });
    return response.status(409).json(result);
  }));

  // Deleting a member's vault copy needs a step-up the server can't offer yet.
  router.delete('/vaults/:vaultId', (_request, response) => {
    response.status(404).json({ error: 'not_available' });
  });

  router.use((_request, response) => {
    response.status(404).json({ error: 'not_found' });
  });

  router.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (error instanceof SyncError) {
      response.status(error.status).json({ error: error.code });
      return;
    }
    if (error instanceof InvalidBody) {
      const code = error.status === 413 ? 'too_large' : 'invalid_body';
      response.status(error.status).json({ error: code, reason: error.reason });
      return;
    }
    const status = (error as { status?: number })?.status;
    if (status === 413 || status === 400) {
      response.status(status).json({ error: status === 413 ? 'too_large' : 'invalid_json' });
      return;
    }
    console.error('sulla-vault: browser sync request failed', (error as { code?: string })?.code ?? 'unknown');
    response.status(500).json({ error: 'internal_error' });
  });

  return router;
}
