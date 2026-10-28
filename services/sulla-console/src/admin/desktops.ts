// Copyright © 2026 Merchant Protocol, LLC. All rights reserved.
// Licensed under the Sulla Fair-Code License 1.0. See LICENSES/Sulla-Fair-Code-1.0.txt.

import type { Router } from 'express';

import { adminRoute, adminWrite, array, record, text } from './common.js';
import type { RouteContext } from '../routes/helpers.js';
import { param } from '../routes/helpers.js';

async function deviceData(context: RouteContext) {
  return context.clients.accounts.admin<{ pending?: unknown; devices?: unknown }>('/devices');
}

function metadata(item: Record<string, unknown>): Record<string, unknown> {
  return record(item.metadata);
}

function person(item: Record<string, unknown>): string {
  return text(metadata(item).userName) || text(metadata(item).email) || text(item.subject);
}

async function rules(context: RouteContext): Promise<Record<string, unknown>> {
  const result = await context.db.query<{ details: Record<string, unknown> }>(
    `SELECT details FROM sulla_console.audit_events
      WHERE kind='admin.desktops.rules' ORDER BY created_at DESC LIMIT 1`,
  );
  return { requireApproval: true, runWorkflows: false, ...result.rows[0]?.details };
}

export function registerDesktopsRoutes(router: Router, context: RouteContext): void {
  router.get('/server/v1/desktops', adminRoute(async(_request, response) => {
    const data = await deviceData(context);
    response.json({
      pending: array(data.pending).map(item => ({
        id: text(item.id),
        name: text(metadata(item).name) || text(metadata(item).deviceName) || text(item.device_id, 'Desktop'),
        user: person(item),
        requestedAt: item.created_at ?? null,
      })),
      desktops: array(data.devices).filter(item => item.status === 'active').map(item => ({
        id: text(item.id),
        name: text(item.name) || text(metadata(item).name) || text(item.device_id, 'Desktop'),
        user: person(item),
        syncs: text(metadata(item).syncs, '—'),
        lastSeenAt: item.last_heartbeat_at ?? item.updated_at ?? null,
      })),
      rules: await rules(context),
    });
  }));

  router.post('/server/v1/desktops/:id/approve', adminWrite(context, 'admin.desktop.approve', async(request, response) => {
    await context.clients.accounts.admin(`/devices/enrollments/${encodeURIComponent(param(request, 'id'))}/approve`, {
      method: 'POST',
      body: '{}',
    });
    response.json({ ok: true });
  }));

  router.post('/server/v1/desktops/:id/revoke', adminWrite(context, 'admin.desktop.revoke', async(request, response) => {
    const id = param(request, 'id');
    const data = await deviceData(context);
    const pending = array(data.pending).some(item => text(item.id) === id);
    const path = pending
      ? `/devices/enrollments/${encodeURIComponent(id)}/deny`
      : `/devices/${encodeURIComponent(id)}/revoke`;
    await context.clients.accounts.admin(path, { method: 'POST', body: '{}' });
    response.json({ ok: true });
  }));

  router.put('/server/v1/desktops/rules', adminWrite(context, 'admin.desktops.rules', async(request, response) => {
    response.json({ ok: true, rules: request.body });
  }));
}
