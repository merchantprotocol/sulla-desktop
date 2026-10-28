// Copyright © 2026 Merchant Protocol, LLC. All rights reserved.
// Licensed under the Sulla Fair-Code License 1.0. See LICENSES/Sulla-Fair-Code-1.0.txt.

import type { Request, Router } from 'express';

import { UpstreamClient, UpstreamError } from '../clients/upstream.js';
import type { RouteContext } from '../routes/helpers.js';
import { audit, httpError, route, session } from '../routes/helpers.js';

export const DOCKER_PROXY_URL = new URL(process.env.SULLA_CONSOLE_DOCKER_PROXY_URL
  ?? process.env.SULLA_DOCKER_PROXY_URL
  ?? 'http://docker-socket-proxy:2375');

export interface AdminRegistrar {
  (router: Router, context: RouteContext): void;
}

export function requireServerAdmin(request: Request): void {
  if (session(request).serverAdmin !== true) throw httpError(403, 'server_admin_required');
}

export function adminRoute(handler: Parameters<typeof route>[0]) {
  return route(async(request, response) => {
    requireServerAdmin(request);
    return handler(request, response);
  });
}

export function adminWrite(
  context: RouteContext,
  kind: string,
  handler: Parameters<typeof route>[0],
) {
  return adminRoute(async(request, response) => {
    await audit(context.db, request, null, kind, safeAuditDetails(request.body));
    return handler(request, response);
  });
}

function safeAuditDetails(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    if (/password|secret|token|key|credential/i.test(key)) {
      result[key] = '[redacted]';
      continue;
    }
    result[key] = field;
  }
  return result;
}

export function unavailable(reason: string): { available: false; reason: string } {
  return { available: false, reason };
}

export async function activeOrganization(context: RouteContext, request: Request): Promise<string> {
  const current = session(request);
  const saved = await context.db.query<{ active_org: string | null }>(
    'SELECT active_org FROM sulla_console.user_prefs WHERE issuer=$1 AND subject=$2',
    [current.identity.issuer, current.identity.subject],
  );
  const active = saved.rows[0]?.active_org;
  if (active && current.organizations.some(organization => organization.id === active)) return active;
  const first = current.organizations[0]?.id;
  if (!first) throw httpError(409, 'organization_required');
  return first;
}

export function vaultClient(context: RouteContext): UpstreamClient {
  return context.clients.vault;
}

export function isUnavailable(error: unknown): boolean {
  return error instanceof UpstreamError && [404, 501, 503].includes(error.status);
}

export function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function array(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(record) : [];
}

export function number(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
