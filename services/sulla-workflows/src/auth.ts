// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import crypto from 'node:crypto';

import { config } from './config.js';
import { pool } from './db.js';

import type { NextFunction, Request, Response as ExpressResponse } from 'express';

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

function equalSecret(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
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

async function ownerIdentity(token: string): Promise<RequestIdentity> {
  if (!equalSecret(token, config.localToken)) throw new Error('invalid local credential');
  return {
    kind: 'owner', issuer: 'urn:sulla:desktop', subject: 'local-owner',
    authorityId: null, organizationId: null, roles: ['owner'], groups: [],
  };
}

export function authenticateRequest(request: AuthenticatedRequest, response: ExpressResponse, next: NextFunction): void {
  const token = request.header('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1] ?? '';
  (async() => {
    request.identity = await runnerIdentity(token) ?? await ownerIdentity(token);
    next();
  })().catch(error => {
    const status = Number(error?.status) === 403 ? 403 : 401;
    response.status(status).json({ error: status === 403 ? 'authorization_denied' : 'authentication_required' });
  });
}

export function requireOwner(request: AuthenticatedRequest, response: ExpressResponse, next: NextFunction): void {
  if (request.identity?.kind !== 'owner') { response.status(403).json({ error: 'owner_context_required' }); return }
  next();
}

export function requireMutationRole(request: AuthenticatedRequest, response: ExpressResponse, next: NextFunction): void {
  if (request.identity?.kind === 'runner' || request.identity?.roles.some(role => ['owner', 'admin', 'editor'].includes(role))) {
    next(); return;
  }
  response.status(403).json({ error: 'editor_role_required' });
}

export function identityParams(identity: RequestIdentity): [string, string, string | null, string | null] {
  return [identity.issuer, identity.subject, identity.authorityId, identity.organizationId];
}

export const identitySql = `owner_issuer=$1 AND owner_subject=$2
  AND authority_id IS NOT DISTINCT FROM $3::uuid
  AND organization_id IS NOT DISTINCT FROM $4::uuid`;
