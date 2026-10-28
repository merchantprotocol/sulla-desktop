// Copyright © 2026 Merchant Protocol, LLC. All rights reserved.
// Licensed under the Sulla Fair-Code License 1.0. See LICENSES/Sulla-Fair-Code-1.0.txt.

import { randomUUID } from 'node:crypto';

import type { NextFunction, Request, Response } from 'express';

import { forwardedWebHeaders } from '../clients/accounts.js';
import type { UpstreamClients } from '../clients/index.js';
import type { ConsoleConfig } from '../config.js';
import type { Database } from '../db.js';
import type { ServerLicenseManager } from '../license.js';
import { requireOrganization } from '../orgScope.js';

export interface RouteContext {
  db: Database;
  clients: UpstreamClients;
  config: ConsoleConfig;
  license: ServerLicenseManager;
}

export type ServiceName = keyof Omit<UpstreamClients, 'accounts'>;

type Handler = (request: Request, response: Response) => Promise<unknown>;

const BODYLESS_METHODS = new Set(['GET', 'HEAD']);

export function httpError(status: number, code: string): Error & { status: number } {
  return Object.assign(new Error(code), { status });
}

export function route(handler: Handler) {
  return (request: Request, response: Response, next: NextFunction): void => {
    handler(request, response).catch(next);
  };
}

export function session(request: Request) {
  if (!request.consoleSession) throw httpError(401, 'authentication_required');
  return request.consoleSession;
}

function bodyValue(request: Request, name: string): unknown {
  const body = request.body as Record<string, unknown> | undefined;
  return body && typeof body === 'object' ? body[name] : undefined;
}

/**
 * The organization a team-scoped request targets: `?team=` or the body's
 * `organizationId`/`teamId`. Route params are never read here, because on most
 * routes `:id` is something else (a conversation, a device, a template).
 */
export function requestedOrg(request: Request): string {
  const candidates = [request.query.team, bodyValue(request, 'organizationId'), bodyValue(request, 'teamId')]
    .filter(value => value !== undefined && value !== null && value !== '');
  const value = candidates[0];
  if (typeof value !== 'string') throw httpError(400, 'organization_required');
  if (candidates.some(other => other !== value)) throw httpError(400, 'organization_mismatch');
  requireOrganization(session(request), value);
  return value;
}

/** A single route parameter, rejecting the list form Express gives wildcard params. */
export function param(request: Request, name: string): string {
  const value = request.params[name];
  if (typeof value !== 'string' || !value) throw httpError(400, `${name}_required`);
  return value;
}

/** The organization on a `/teams/:id` route, checked against the caller's memberships. */
export function teamOrg(request: Request): string {
  const id = param(request, 'id');
  requireOrganization(session(request), id);
  return id;
}

function hasBody(method: string): boolean {
  return !BODYLESS_METHODS.has(method.toUpperCase());
}

/** Forward the browser's cookie and CSRF header to an Accounts `/v1/web` route. */
export function webInit(request: Request, method = request.method, body: unknown = request.body): RequestInit {
  const headers = forwardedWebHeaders(request);
  if (!hasBody(method)) return { method, headers };
  headers.set('content-type', 'application/json');
  return { method, headers, body: JSON.stringify(body ?? {}) };
}

async function uiToken(
  request: Request,
  clients: UpstreamClients,
  service: ServiceName,
  audience: string,
  organizationId: string,
): Promise<string> {
  const headers = forwardedWebHeaders(request);
  headers.set('content-type', 'application/json');
  const result = await clients.accounts.request<{ token: string }>('/v1/web/ui-sessions', {
    method: 'POST',
    headers,
    body: JSON.stringify({ service, audience, organizationId }),
  });
  return result.token;
}

export const AUDIENCES: Record<ServiceName, string> = {
  files: 'sulla-files',
  vault: 'sulla-vault',
  agents: 'sulla-agents',
  workflows: 'sulla-workflows',
};

/** Call Files, Vault, Agents or Workflows as the signed-in user, with a short-lived UI-session token. */
export async function serviceJson<T = unknown>(
  request: Request,
  clients: UpstreamClients,
  service: ServiceName,
  organizationId: string,
  path: string,
  method = request.method,
  body: unknown = request.body,
): Promise<T> {
  const token = await uiToken(request, clients, service, AUDIENCES[service], organizationId);
  const headers = new Headers({
    authorization: `Bearer ${token}`,
    'x-sulla-organization-id': organizationId,
  });
  if (!hasBody(method)) return clients[service].request<T>(path, { method, headers });
  headers.set('content-type', 'application/json');
  return clients[service].request<T>(path, { method, headers, body: JSON.stringify(body ?? {}) });
}

export async function audit(
  db: Database,
  request: Request,
  organizationId: string | null,
  kind: string,
  details: Record<string, unknown> = {},
): Promise<void> {
  const identity = session(request).identity;
  await db.query(
    `INSERT INTO sulla_console.audit_events(id,organization_id,issuer,subject,kind,details)
     VALUES($1,$2,$3,$4,$5,$6)`,
    [randomUUID(), organizationId, identity.issuer, identity.subject, kind, details],
  );
}

const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,199}$/;

/**
 * The path below a proxy mount, checked segment by segment. Rejects `..`, encoded
 * dots and slashes, backslashes and empty segments, so a suffix can never climb
 * out of the endpoints the caller is allowed to reach.
 */
export function proxySuffix(request: Request): string[] {
  const raw = request.path;
  if (/%2e|%2f|%5c|\\/i.test(raw)) throw httpError(400, 'invalid_path');
  const trimmed = raw.replace(/^\/+/, '').replace(/\/+$/, '');
  if (!trimmed) return [];
  const segments = trimmed.split('/');
  for (const segment of segments) {
    if (!SEGMENT.test(segment) || segment.includes('..')) throw httpError(400, 'invalid_path');
  }
  return segments;
}

/** The query string to forward upstream: string values only, without the Console's `team` parameter. */
export function forwardedQuery(request: Request): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(request.query)) {
    if (key === 'team') continue;
    if (typeof value === 'string') params.append(key, value);
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}
