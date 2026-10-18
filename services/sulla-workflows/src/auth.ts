import crypto from 'node:crypto';

import { config } from './config.js';
import { pool } from './db.js';

import type { NextFunction, Request, Response as ExpressResponse } from 'express';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_ACCOUNTS_RESPONSE_BYTES = 64 * 1024;
const MAX_IDENTITY_VALUE_LENGTH = 2_048;
const MAX_AUTHORIZATION_VALUES = 100;

export interface RequestIdentity {
  kind:           'owner' | 'runner';
  issuer:         string;
  subject:        string;
  authorityId:    string | null;
  organizationId: string | null;
  roles:          string[];
  groups:         string[];
  executionId?:   string;
  allowedTools?:  string[];
}

export interface AuthenticatedRequest extends Request {
  identity?: RequestIdentity;
}

export function requestBearer(request: Request): string {
  return request.header('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1] ?? '';
}

function equalSecret(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

export async function boundedJson(response: Response, maxBytes = MAX_ACCOUNTS_RESPONSE_BYTES): Promise<Record<string, unknown>> {
  const declaredLength = Number(response.headers.get('content-length') ?? 0);
  if (declaredLength > maxBytes) throw new Error('Accounts response is too large');
  if (!response.body) throw new Error('Accounts response has no body');

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error('Accounts response is too large');
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Accounts returned an invalid context');
  return parsed as Record<string, unknown>;
}

function identityString(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_IDENTITY_VALUE_LENGTH || value.trim() !== value) return null;
  return value;
}

function authorizationValues(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_AUTHORIZATION_VALUES ||
      value.some(item => typeof item !== 'string' || item.length === 0 || item.length > 120 || item.trim() !== item)) return null;
  return [...new Set(value as string[])];
}

async function runnerIdentity(token: string): Promise<RequestIdentity | null> {
  if (!token) return null;
  const found = await pool.query(
    `SELECT e.execution_id,e.owner_issuer,e.owner_subject,e.authority_id,e.organization_id,t.allowed_tools
       FROM workflow_run_tokens t
       JOIN workflow_executions e ON e.execution_id=t.execution_id
      WHERE t.token_hash=$1 AND t.expires_at > NOW() AND e.status='running'`,
    [crypto.createHash('sha256').update(token).digest('hex')],
  );
  const row = found.rows[0];
  if (!row?.owner_issuer || !row?.owner_subject || !Array.isArray(row.allowed_tools) ||
      row.allowed_tools.some((scope: unknown) => typeof scope !== 'string' || !scope)) return null;
  return {
    kind:           'runner',
    issuer:         row.owner_issuer,
    subject:        row.owner_subject,
    authorityId:    row.authority_id ?? null,
    organizationId: row.organization_id ?? null,
    roles:          [],
    groups:         [],
    executionId:    row.execution_id,
    allowedTools:   row.allowed_tools,
  };
}

async function ownerIdentity(request: Request, token: string): Promise<RequestIdentity> {
  if (config.mode === 'desktop') {
    if (!equalSecret(token, config.localToken)) throw new Error('invalid local credential');
    return {
      kind:           'owner',
      issuer:         'urn:sulla:desktop',
      subject:        'local-owner',
      authorityId:    null,
      organizationId: null,
      roles:          ['owner'],
      groups:         [],
    };
  }

  const authorityId = request.header('x-sulla-authority-id') ?? '';
  const organizationId = request.header('x-sulla-organization-id') ?? '';
  if (!token || !UUID.test(authorityId) || !UUID.test(organizationId)) throw new Error('server identity headers are required');
  const response = await fetch(`${ config.accountsUrl }/v1/private/resolve-context`, {
    method:  'POST',
    headers: {
      'Content-Type':          'application/json',
      'X-Sulla-Service-Id':    config.accountsServiceId,
      'X-Sulla-Service-Token': config.accountsServiceToken,
    },
    body:     JSON.stringify({ bearerToken: token, authorityId, audience: config.audience, organizationId, requiredRoles: config.requiredRoles }),
    redirect: 'error',
    signal:   AbortSignal.timeout(5_000),
  });
  const context = await boundedJson(response, MAX_ACCOUNTS_RESPONSE_BYTES);
  const issuer = identityString(context.issuer);
  const subject = identityString(context.subject);
  const roles = authorizationValues(context.roles);
  const groups = authorizationValues(context.groups);
  if (!response.ok || context.authorityId !== authorityId || context.organizationId !== organizationId ||
      context.audience !== config.audience || !issuer || !subject || !roles || !groups ||
      config.requiredRoles.some(role => !roles.includes(role))) {
    throw new Error('Accounts denied workflow context');
  }
  return {
    kind: 'owner', issuer, subject, authorityId, organizationId, roles, groups,
  };
}

export function authenticateRequest(request: AuthenticatedRequest, response: ExpressResponse, next: NextFunction): void {
  const token = requestBearer(request);
  (async() => {
    request.identity = await runnerIdentity(token) ?? await ownerIdentity(request, token);
    next();
  })().catch(() => response.status(401).json({ error: 'authentication_required' }));
}

export function requireOwner(request: AuthenticatedRequest, response: ExpressResponse, next: NextFunction): void {
  if (request.identity?.kind !== 'owner') { response.status(403).json({ error: 'owner_context_required' }); return }
  next();
}

export function identityParams(identity: RequestIdentity): [string, string, string | null, string | null] {
  return [identity.issuer, identity.subject, identity.authorityId, identity.organizationId];
}

export const identitySql = `owner_issuer=$1 AND owner_subject=$2
  AND authority_id IS NOT DISTINCT FROM $3::uuid
  AND organization_id IS NOT DISTINCT FROM $4::uuid`;
