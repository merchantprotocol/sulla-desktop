// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { randomUUID } from 'node:crypto';
import { Router, type NextFunction, type Request, type Response } from 'express';
import {
  authenticateOwner, authenticateService, authenticateStatic, getBearer, issueOwnerSession,
  type OwnerRequest, type ServiceRequest, verifyOidcToken, verifyOwnerSession,
} from './auth.js';
import { base64url, digest } from './crypto.js';
import { fetchJson, object, string, stringArray } from './http.js';
import { authorityAccessToken, beginAuthorization, completeAuthorization, createAuthority, revokeAuthoritySession, type Authority } from './oidc.js';
import type { AccountsConfig } from './config.js';
import type { Database } from './db.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const USER_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const MEMBERSHIP_ROLES = new Set(['owner', 'admin', 'editor', 'member', 'viewer']);

class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type AsyncRoute<T extends Request> = (request: T, response: Response, next: NextFunction) => Promise<void>;
const route =
  <T extends Request = Request>(handler: AsyncRoute<T>) =>
  (request: Request, response: Response, next: NextFunction): void => {
    void handler(request as T, response, next).catch(next);
  };

function uuid(value: unknown, name: string): string {
  const result = string(value, name, 36);
  if (!UUID.test(result)) throw new HttpError(400, `${name} is invalid`);
  return result;
}

function requestBody(request: Request): Record<string, unknown> {
  try {
    return object(request.body);
  } catch {
    throw new HttpError(400, 'JSON object body is required');
  }
}

function membershipRoles(input: unknown): string[] {
  const roles = stringArray(input ?? [], 'roles', 10);
  if (roles.some((role) => !MEMBERSHIP_ROLES.has(role))) throw new HttpError(400, 'roles contain an unsupported value');
  return roles;
}

function profileText(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || value.length > max) throw new HttpError(400, `${name} is invalid`);
  return value.trim();
}


function publicAuthority(authority: Record<string, unknown>): Record<string, unknown> {
  return {
    id: authority.id,
    type: 'oidc',
    issuer: authority.issuer,
    remoteAuthorityId: authority.remote_authority_id ?? null,
    clientId: authority.client_id,
    resourceAudiences: authority.resource_audiences,
    scopes: authority.scopes,
    membershipEndpoint: authority.membership_endpoint ?? null,
    membershipAudience: authority.membership_audience ?? null,
    subject: authority.subject ?? null,
    connectedAt: authority.connected_at ?? null,
    createdAt: authority.created_at,
    updatedAt: authority.updated_at,
  };
}

async function authorityById(db: Database, id: string): Promise<Authority> {
  const found = await db.query<Authority>('SELECT * FROM accounts.authorities WHERE id=$1 OR remote_authority_id=$1', [
    id,
  ]);
  if (!found.rows[0]) throw new HttpError(404, 'authority not found');
  return found.rows[0];
}

interface MembershipContext {
  issuer: string;
  subject: string;
  organizationId: string;
  roles: string[];
  groups: string[];
}

async function freshRemoteMembership(
  db: Database,
  authority: Authority,
  bearerToken: string,
  organizationId: string,
  expectedSubject: string,
): Promise<MembershipContext> {
  if (!authority.membership_endpoint || !authority.remote_authority_id)
    throw new HttpError(403, 'authority has no remote membership contract');
  let remote: Record<string, unknown>;
  try {
    remote = object(
      await fetchJson(
        authority.membership_endpoint,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${bearerToken}`, 'content-type': 'application/json' },
          body: JSON.stringify({ organizationId }),
        },
        256 * 1024,
      ),
    );
  } catch {
    throw new HttpError(403, 'current membership could not be confirmed');
  }
  let context: MembershipContext;
  let remoteAuthorityId: string;
  try {
    context = {
      issuer: string(remote.issuer, 'membership issuer'),
      subject: string(remote.subject, 'membership subject'),
      organizationId: uuid(remote.organizationId, 'membership organizationId'),
      roles: stringArray(remote.roles, 'membership roles'),
      groups: stringArray(remote.groups, 'membership groups'),
    };
    remoteAuthorityId = uuid(remote.authorityId, 'membership authorityId');
  } catch {
    throw new HttpError(403, 'membership response is invalid');
  }
  if (
    context.issuer !== authority.issuer ||
    remoteAuthorityId !== authority.remote_authority_id ||
    context.subject !== expectedSubject ||
    context.organizationId !== organizationId
  ) {
    throw new HttpError(403, 'membership identity mismatch');
  }
  await db.query(
    `INSERT INTO accounts.membership_cache(authority_id,organization_id,subject,roles,groups,source_updated_at,expires_at)
     VALUES ($1,$2,$3,$4,$5,now(),now()+interval '5 minutes')
     ON CONFLICT (authority_id,organization_id) DO UPDATE SET
       subject=EXCLUDED.subject,roles=EXCLUDED.roles,groups=EXCLUDED.groups,source_updated_at=EXCLUDED.source_updated_at,expires_at=EXCLUDED.expires_at`,
    [authority.id, organizationId, context.subject, context.roles, context.groups],
  );
  return context;
}

// Organization roles are ranked: an owner or admin also holds member access.
const ROLE_RANK = ['viewer', 'member', 'editor', 'admin', 'owner'];

function holdsRole(held: string[], required: string): boolean {
  const needed = ROLE_RANK.indexOf(required);
  if (needed < 0) return held.includes(required);
  return held.some((role) => ROLE_RANK.indexOf(role) >= needed);
}

function requireRoles(context: MembershipContext, required: string[]): void {
  if (required.some((role) => !holdsRole(context.roles, role)))
    throw new HttpError(403, 'required membership role is missing');
}

async function verifiedIdentity(
  token: string | undefined,
  authority: Authority,
  audience: string,
): Promise<{ issuer: string; subject: string }> {
  if (!token) throw new HttpError(401, 'authentication_required');
  try {
    return await verifyOidcToken(token, authority.issuer, audience, authority.jwks_uri);
  } catch {
    throw new HttpError(401, 'invalid_token');
  }
}

async function currentMembership(
  db: Database,
  _config: AccountsConfig,
  authority: Authority,
  identity: { issuer: string; subject: string },
  organizationId: string,
  bearerToken?: string,
): Promise<MembershipContext> {
  if (!bearerToken) throw new HttpError(403, 'current membership could not be confirmed');
  const context = await freshRemoteMembership(db, authority, bearerToken, organizationId, identity.subject);
  if (context.subject !== identity.subject) throw new HttpError(403, 'membership subject mismatch');
  return context;
}

function grantExpiry(value: unknown): Date {
  const expiresAt = new Date(string(value, 'expiresAt', 64));
  if (
    !Number.isFinite(expiresAt.getTime()) ||
    expiresAt.getTime() <= Date.now() ||
    expiresAt.getTime() > Date.now() + 90 * 24 * 60 * 60_000
  ) {
    throw new HttpError(400, 'expiresAt must be in the future and no more than 90 days away');
  }
  return expiresAt;
}

export function bootstrapRoutes(db: Database, config: AccountsConfig): Router {
  const router = Router();
  router.post(
    '/bootstrap/session',
    authenticateStatic(config.bootstrapSecret),
    route(async (request, response) => {
      const input =
        request.body && typeof request.body === 'object' && !Array.isArray(request.body)
          ? (request.body as Record<string, unknown>)
          : {};
      const displayName =
        input.displayName === undefined ? 'Local owner' : string(input.displayName, 'displayName', 120);
      const id = randomUUID();
      const created = await db.query(
        `INSERT INTO accounts.local_profile(singleton,id,display_name) VALUES (true,$1,$2)
       ON CONFLICT (singleton) DO UPDATE SET singleton=EXCLUDED.singleton
       RETURNING id,display_name,created_at,updated_at`,
        [id, displayName],
      );
      const profile = created.rows[0];
      const session = await issueOwnerSession(db, config, profile.id);
      response
        .status(201)
        .json({
          ...session,
          profile: {
            id: profile.id,
            displayName: profile.display_name,
            createdAt: profile.created_at,
            updatedAt: profile.updated_at,
          },
        });
    }),
  );
  return router;
}


export function ownerRoutes(db: Database, config: AccountsConfig): Router {
  const router = Router();

  router.get(
    '/oidc/callback',
    route(async (request, response) => {
      const result = await completeAuthorization(
        db,
        config,
        string(request.query.code, 'code', 16 * 1024),
        string(request.query.state, 'state', 1024),
      );
      if (result.returnTo) {
        const destination = new URL(result.returnTo);
        destination.searchParams.set('sullaAccounts', 'connected');
        destination.searchParams.set('authorityId', result.authorityId);
        response.redirect(303, destination.href);
        return;
      }
      response.json({ connected: true, authorityId: result.authorityId });
    }),
  );

  router.use(authenticateOwner(db, config));

  router.post(
    '/sessions/refresh',
    route(async (request: OwnerRequest, response) => {
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT set_config('sulla.seat_allocation_authorized','1',true)");
        await client.query(
          'UPDATE accounts.broker_sessions SET revoked_at=now() WHERE jti_digest=$1 AND revoked_at IS NULL',
          [digest(request.owner!.jti)],
        );
        const session = await issueOwnerSession(client, config, request.owner!.profileId);
        await client.query('COMMIT');
        response.json(session);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }),
  );

  router.get(
    '/profile',
    route(async (request: OwnerRequest, response) => {
      const found = await db.query(
        'SELECT id,display_name,created_at,updated_at FROM accounts.local_profile WHERE id=$1',
        [request.owner!.profileId],
      );
      const profile = found.rows[0];
      if (!profile) throw new HttpError(404, 'profile not found');
      response.json({
        id: profile.id,
        displayName: profile.display_name,
        createdAt: profile.created_at,
        updatedAt: profile.updated_at,
      });
    }),
  );

  router.patch(
    '/profile',
    route(async (request: OwnerRequest, response) => {
      const displayName = string(requestBody(request).displayName, 'displayName', 120);
      const changed = await db.query(
        'UPDATE accounts.local_profile SET display_name=$2,updated_at=now() WHERE id=$1 RETURNING id,display_name,created_at,updated_at',
        [request.owner!.profileId, displayName],
      );
      const profile = changed.rows[0];
      response.json({
        id: profile.id,
        displayName: profile.display_name,
        createdAt: profile.created_at,
        updatedAt: profile.updated_at,
      });
    }),
  );

  router.get(
    '/connections',
    route(async (_request, response) => {
      const found = await db.query('SELECT * FROM accounts.authorities ORDER BY created_at,id');
      response.json({ connections: found.rows.map(publicAuthority), legacyCloudConnections: [] });
    }),
  );

  router.post(
    '/connections',
    route(async (request, response) => {
      const created = await createAuthority(db, requestBody(request));
      response.status(201).json(publicAuthority(created as unknown as Record<string, unknown>));
    }),
  );

  router.delete(
    '/connections/:id',
    route(async (request, response) => {
      const authority = await authorityById(db, uuid(request.params.id, 'authority id'));
      await revokeAuthoritySession(db, config, authority);
      response.status(204).end();
    }),
  );

  router.post(
    '/connections/:id/authorize',
    route(async (request, response) => {
      const authority = await authorityById(db, uuid(request.params.id, 'authority id'));
      const input = requestBody(request);
      response
        .status(201)
        .json(await beginAuthorization(db, config, authority, input.returnTo, input.resourceAudience));
    }),
  );

  router.get(
    '/memberships',
    route(async (_request, response) => {
      const local = await db.query(
        `SELECT m.id,m.issuer,m.subject,m.organization_id,m.roles,m.groups,m.updated_at,a.id AS authority_id
         FROM accounts.memberships m JOIN accounts.authorities a ON a.issuer=m.issuer AND a.subject=m.subject
        WHERE m.revoked_at IS NULL ORDER BY m.issuer,m.organization_id`,
      );
      const remote = await db.query(
        `SELECT c.authority_id,a.issuer,c.subject,c.organization_id,c.roles,c.groups,c.source_updated_at,c.expires_at
         FROM accounts.membership_cache c JOIN accounts.authorities a ON a.id=c.authority_id
        WHERE a.subject IS NOT NULL AND c.subject=a.subject ORDER BY a.issuer,c.organization_id`,
      );
      response.json({ local: local.rows, remoteDisplayHints: remote.rows });
    }),
  );

  return router;
}

export function privateRoutes(db: Database, config: AccountsConfig): Router {
  const router = Router();
  router.use(authenticateService(config));

  router.post(
    '/resolve-context',
    route(async (request: ServiceRequest, response) => {
      const input = requestBody(request);
      const authorityId = uuid(input.authorityId, 'authorityId');
      const authority = await authorityById(db, authorityId);
      if (!request.service!.issuers.has(authority.issuer))
        throw new HttpError(403, 'service is not allowed to use this authority');
      const bearerToken = string(input.bearerToken, 'bearerToken', 64 * 1024);
      const audience = string(input.audience, 'audience', 300);
      if (!request.service!.allowedAudiences.has(audience) || !authority.resource_audiences.includes(audience)) {
        throw new HttpError(403, 'service audience is not allowed for this authority');
      }
      const organizationId = uuid(input.organizationId, 'organizationId');
      const requiredRoles = stringArray(input.requiredRoles ?? [], 'requiredRoles');
      const identity = await verifiedIdentity(bearerToken, authority, audience);
      const context = await currentMembership(db, config, authority, identity, organizationId, bearerToken);
      requireRoles(context, requiredRoles);
      response.json({ ...context, authorityId, audience });
    }),
  );

  router.post(
    '/ui-sessions/resolve',
    route(async (request: ServiceRequest, response) => {
      const input = requestBody(request);
      const token = string(input.token, 'token', 1024);
      const audience = string(input.audience, 'audience', 300);
      if (!request.service!.allowedAudiences.has(audience)) throw new HttpError(403, 'service audience is not allowed');
      const found = await db.query(
        `SELECT u.* FROM accounts.ui_sessions u
         JOIN accounts.web_sessions w ON w.id=u.web_session_id
        WHERE u.token_digest=$1 AND u.service_id=$2 AND u.audience=$3
          AND u.revoked_at IS NULL AND u.expires_at>now()
          AND w.revoked_at IS NULL AND w.expires_at>now()`,
        [digest(token), request.service!.id, audience],
      );
      const session = found.rows[0];
      if (!session) throw new HttpError(401, 'invalid_or_expired_ui_session');
      if (!request.service!.issuers.has(session.issuer)) throw new HttpError(403, 'service issuer is not allowed');
      const authority = await authorityById(db, session.authority_id);
      if (authority.issuer !== session.issuer || !authority.resource_audiences.includes(audience))
        throw new HttpError(403, 'UI session authority is no longer allowed');
      const membership = await currentMembership(
        db,
        config,
        authority,
        { issuer: session.issuer, subject: session.subject },
        session.organization_id,
      );
      const requiredRoles = membershipRoles(input.requiredRoles ?? []);
      requireRoles(membership, requiredRoles);
      response.json({
        ...membership,
        authorityId: authority.remote_authority_id ?? authority.id,
        audience,
        expiresAt: new Date(session.expires_at).toISOString(),
      });
    }),
  );

  router.post(
    '/schedule-grants/resolve',
    route(async (request: ServiceRequest, response) => {
      const grantToken = string(requestBody(request).grantToken, 'grantToken', 1024);
      const found = await db.query(
        `SELECT * FROM accounts.delegated_schedule_grants
        WHERE token_digest=$1 AND service_id=$2 AND revoked_at IS NULL AND expires_at>now()`,
        [digest(grantToken), request.service!.id],
      );
      const grant = found.rows[0];
      if (!grant) throw new HttpError(403, 'schedule grant is invalid or expired');
      const authority = await authorityById(db, grant.authority_id);
      if (
        authority.issuer !== grant.issuer ||
        !request.service!.issuers.has(grant.issuer) ||
        !request.service!.allowedAudiences.has(grant.audience) ||
        !authority.resource_audiences.includes(grant.audience)
      ) {
        throw new HttpError(403, 'schedule grant is no longer allowed for this service');
      }
      let membership: MembershipContext;
      try {
        const accessToken = await authorityAccessToken(db, config, authority);
        const identity = await verifyOidcToken(accessToken, authority.issuer, grant.audience, authority.jwks_uri);
        if (identity.subject !== grant.subject || authority.subject !== grant.subject)
          throw new Error('schedule authority subject has changed');
        membership = await currentMembership(db, config, authority, identity, grant.organization_id, accessToken);
      } catch (error) {
        if (error instanceof HttpError && error.status === 403) throw error;
        throw new HttpError(403, 'schedule authority membership could not be confirmed');
      }
      requireRoles(membership, grant.required_roles);
      response.json({
        issuer: grant.issuer,
        subject: grant.subject,
        authorityId: authority.remote_authority_id ?? authority.id,
        organizationId: grant.organization_id,
        roles: membership.roles,
        groups: membership.groups,
        audience: grant.audience,
        workflowId: grant.workflow_id,
        scheduleNodeId: grant.schedule_node_id,
        expiresAt: new Date(grant.expires_at).toISOString(),
      });
    }),
  );

  router.post(
    '/schedule-grants/revoke',
    route(async (request: ServiceRequest, response) => {
      const grantToken = string(requestBody(request).grantToken, 'grantToken', 1024);
      await db.query(
        `UPDATE accounts.delegated_schedule_grants SET revoked_at=COALESCE(revoked_at,now()),updated_at=now()
        WHERE token_digest=$1 AND service_id=$2`,
        [digest(grantToken), request.service!.id],
      );
      response.status(204).end();
    }),
  );

  router.post(
    '/authorities/:id/fetch',
    route(async (request: ServiceRequest, response) => {
      const input = requestBody(request);
      const authority = await authorityById(db, uuid(request.params.id, 'authority id'));
      if (!request.service!.issuers.has(authority.issuer))
        throw new HttpError(403, 'service is not allowed to use this authority');
      const ownerHeader = request.header('x-sulla-owner-authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
      await verifyOwnerSession(db, config, ownerHeader);
      const method = string(input.method ?? 'GET', 'method', 8).toUpperCase();
      if (!request.service!.methods.has(method)) throw new HttpError(403, 'service is not allowed to use this method');
      const path = string(input.path, 'path', 2048);
      if (!path.startsWith('/') || path.startsWith('//')) {
        throw new HttpError(403, 'service is not allowed to use this path');
      }
      const target = new URL(path, authority.issuer);
      if (target.origin !== new URL(authority.issuer).origin)
        throw new HttpError(403, 'cross-origin fetch is not allowed');
      if (
        !request.service!.pathPrefixes.some(
          (prefix) =>
            target.pathname === prefix || target.pathname.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`),
        )
      ) {
        throw new HttpError(403, 'service is not allowed to use this path');
      }
      const organizationId = uuid(input.organizationId, 'organizationId');
      const requiredRoles = stringArray(input.requiredRoles ?? [], 'requiredRoles');
      const accessToken = await authorityAccessToken(db, config, authority);
      const audience = string(input.audience, 'audience', 300);
      if (!request.service!.allowedAudiences.has(audience) || !authority.resource_audiences.includes(audience)) {
        throw new HttpError(403, 'service audience is not allowed for this authority');
      }
      const accessIdentity = await verifiedIdentity(accessToken, authority, audience);
      if (!authority.subject || accessIdentity.subject !== authority.subject)
        throw new HttpError(403, 'stored authority identity mismatch');
      const membership = await freshRemoteMembership(
        db,
        authority,
        accessToken,
        organizationId,
        accessIdentity.subject,
      );
      if (!authority.subject || membership.subject !== authority.subject)
        throw new HttpError(403, 'owner membership subject mismatch');
      requireRoles(membership, requiredRoles);
      if (target.searchParams.has('organizationId') && target.searchParams.get('organizationId') !== organizationId) {
        throw new HttpError(403, 'outbound organization mismatch');
      }
      if (input.body && typeof input.body === 'object' && !Array.isArray(input.body)) {
        const bodyOrganization = (input.body as Record<string, unknown>).organizationId;
        if (bodyOrganization !== undefined && bodyOrganization !== organizationId)
          throw new HttpError(403, 'outbound organization mismatch');
      }
      const data = await fetchJson(target.href, {
        method,
        headers: {
          authorization: `Bearer ${accessToken}`,
          'x-sulla-authority-id': authority.remote_authority_id!,
          'x-sulla-organization-id': organizationId,
          ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
        },
        body: method === 'POST' ? JSON.stringify(input.body ?? {}) : undefined,
      });
      response.json({ data });
    }),
  );

  return router;
}


export function errorHandler(error: unknown, _request: Request, response: Response, _next: NextFunction): void {
  if (error instanceof HttpError) {
    response.status(error.status).json({ error: error.message });
    return;
  }
  const message = error instanceof Error ? error.message : '';
  if (/invalid|required|mismatch|not allowed|expired|consumed|superseded/.test(message)) {
    response.status(400).json({ error: 'invalid_request' });
    return;
  }
  console.error('accounts request failed', error);
  response.status(500).json({ error: 'internal_error' });
}
