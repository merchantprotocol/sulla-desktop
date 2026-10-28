// Copyright © 2026 Merchant Protocol, LLC. All rights reserved.
// Licensed under the Sulla Fair-Code License 1.0. See LICENSES/Sulla-Fair-Code-1.0.txt.

import type { Request, Router } from 'express';

import { adminRoute, array, record, text } from './common.js';
import type { RouteContext } from '../routes/helpers.js';

function requestedKind(request: Request): string | null {
  return typeof request.query.kind === 'string' && request.query.kind !== 'all' ? request.query.kind : null;
}

function displayKind(kind: string): string {
  if (kind.startsWith('admin.')) return 'admin';
  if (kind.startsWith('agent')) return 'agents';
  if (kind.startsWith('vault')) return 'vault';
  if (kind.startsWith('signin')) return 'signin';
  return 'admin';
}

export function registerAuditRoutes(router: Router, context: RouteContext): void {
  router.get('/server/v1/audit', adminRoute(async(request, response) => {
    const kind = requestedKind(request);
    const local = await context.db.query<{
      id: string;
      subject: string;
      kind: string;
      details: Record<string, unknown>;
      created_at: Date;
    }>(
      `SELECT id,subject,kind,details,created_at FROM sulla_console.audit_events
       ORDER BY created_at DESC LIMIT 250`,
    );
    let accountEvents: Record<string, unknown>[] = [];
    try {
      const accounts = record(await context.clients.accounts.admin('/events?max=250'));
      accountEvents = array(accounts.events);
    } catch {
      // Local administrative audit remains available when Keycloak events are unavailable.
    }
    const localEvents = local.rows.map(event => ({
      id: event.id,
      at: event.created_at.toISOString(),
      who: event.subject,
      kind: displayKind(event.kind),
      what: event.kind,
      from: text(event.details.from) || text(event.details.ip) || 'Console',
    }));
    const signins = accountEvents.map((event, index) => ({
      id: text(event.id, `signin-${index}`),
      at: event.time ? new Date(Number(event.time)).toISOString() : text(event.at),
      who: text(event.userId) || text(event.username) || 'Unknown user',
      kind: 'signin',
      what: text(event.type, 'SIGN_IN').toLowerCase().replaceAll('_', ' '),
      from: text(event.ipAddress) || 'Unknown address',
    }));
    const events = [...localEvents, ...signins]
      .filter(event => !kind || event.kind === kind)
      .sort((left, right) => right.at.localeCompare(left.at))
      .slice(0, 250);
    response.json({ events, nextBefore: null });
  }));
}
