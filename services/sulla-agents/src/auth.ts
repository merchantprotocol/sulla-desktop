import crypto from 'node:crypto';

import { config } from './config.js';

import type { NextFunction, Request, Response } from 'express';

export interface RequestIdentity {
  issuer: string; subject: string; authorityId: string | null; organizationId: string | null; roles: string[];
}
export interface AuthenticatedRequest extends Request { identity?: RequestIdentity }

function equalSecret(left: string, right: string): boolean {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

async function boundedJson(response: globalThis.Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (Buffer.byteLength(text) > 64 * 1024) throw new Error('Accounts response is too large');
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Accounts response is invalid');
  return parsed;
}

async function identity(request: Request): Promise<RequestIdentity> {
  const token = request.header('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1] ?? '';
  if (config.mode === 'desktop') {
    if (!equalSecret(token, config.localToken)) throw new Error('invalid local credential');
    return { issuer: 'urn:sulla:desktop', subject: 'local-owner', authorityId: null, organizationId: null, roles: ['owner'] };
  }
  if (!token) throw Object.assign(new Error('UI session token is required'), { status: 401 });
  const response = await fetch(`${ config.accountsUrl }/v1/private/ui-sessions/resolve`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5_000),
    headers: { 'Content-Type': 'application/json', 'X-Sulla-Service-Id': config.accountsServiceId, 'X-Sulla-Service-Token': config.accountsServiceToken },
    body: JSON.stringify({ token, audience: config.audience, requiredRoles: config.requiredRoles }),
  });
  const context = await boundedJson(response);
  const roles = Array.isArray(context.roles) ? context.roles.filter(role => typeof role === 'string') as string[] : [];
  const expiresAt = typeof context.expiresAt === 'string' ? Date.parse(context.expiresAt) : Number.NaN;
  if (!response.ok || context.audience !== config.audience || !Number.isFinite(expiresAt) || expiresAt <= Date.now() ||
      typeof context.issuer !== 'string' || typeof context.subject !== 'string' ||
      typeof context.authorityId !== 'string' || typeof context.organizationId !== 'string' ||
      config.requiredRoles.some(role => !roles.includes(role))) {
    throw Object.assign(new Error('Accounts denied agent context'), { status: response.status === 401 ? 401 : 403 });
  }
  return { issuer: context.issuer, subject: context.subject, authorityId: context.authorityId, organizationId: context.organizationId, roles };
}

export function authenticateRequest(request: AuthenticatedRequest, response: Response, next: NextFunction): void {
  identity(request).then(value => { request.identity = value; next() }).catch(error => {
    const status = Number(error?.status) === 403 ? 403 : 401;
    response.status(status).json({ error: status === 403 ? 'authorization_denied' : 'authentication_required' });
  });
}

export function requireEditor(request: AuthenticatedRequest, response: Response, next: NextFunction): void {
  if (!request.identity?.roles.some(role => ['owner', 'admin', 'editor'].includes(role))) {
    response.status(403).json({ error: 'editor_role_required' }); return;
  }
  next();
}

export function identityParams(identity: RequestIdentity): [string, string, string | null, string | null] {
  return [identity.issuer, identity.subject, identity.authorityId, identity.organizationId];
}

export const identitySql = `owner_issuer=$1 AND owner_subject=$2
  AND authority_id IS NOT DISTINCT FROM $3::uuid AND organization_id IS NOT DISTINCT FROM $4::uuid`;

export function tenantParams(identity: RequestIdentity): [string | null, string | null] {
  return [identity.authorityId, identity.organizationId];
}
export const tenantSql = `authority_id IS NOT DISTINCT FROM $1::uuid AND organization_id IS NOT DISTINCT FROM $2::uuid`;
