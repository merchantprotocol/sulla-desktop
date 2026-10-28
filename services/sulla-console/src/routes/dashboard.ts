// Copyright © 2026 Merchant Protocol, LLC. All rights reserved.
// Licensed under the Sulla Fair-Code License 1.0. See LICENSES/Sulla-Fair-Code-1.0.txt.

import type { Request, Router } from 'express';

import type { UpstreamClients } from '../clients/index.js';
import { envelope } from '../envelope.js';
import { requireOrganizationAdmin } from '../orgScope.js';
import { type RouteContext, httpError, param, requestedOrg, route, serviceJson, session } from './helpers.js';

interface AccountsDevice {
  id: string;
  organization_id: string;
  subject: string;
  device_id: string;
  name?: string | null;
  metadata?: Record<string, unknown> | null;
  status: string;
  last_heartbeat_at?: string | null;
  created_at?: string;
}

const ONLINE_WINDOW_MS = 5 * 60_000;

function deviceView(device: AccountsDevice) {
  const metadata = device.metadata ?? {};
  const lastSeen = device.last_heartbeat_at ? Date.parse(device.last_heartbeat_at) : NaN;
  return {
    id: device.id,
    deviceId: device.device_id,
    name: device.name ?? (typeof metadata.name === 'string' ? metadata.name : null),
    platform: typeof metadata.platform === 'string' ? metadata.platform : null,
    version: typeof metadata.version === 'string' ? metadata.version : null,
    status: device.status,
    online: device.status === 'active' && Date.now() - lastSeen < ONLINE_WINDOW_MS,
    lastSeenAt: device.last_heartbeat_at ?? null,
    createdAt: device.created_at ?? null,
    ownerId: device.subject,
  };
}

/**
 * Accounts' device inventory is an admin route that returns every organization's
 * devices, so the organization filter has to happen here.
 */
async function organizationDevices(clients: UpstreamClients, organizationId: string): Promise<AccountsDevice[]> {
  const result = await clients.accounts.admin<{ devices?: AccountsDevice[] }>('/devices');
  return (result.devices ?? []).filter(device => device.organization_id === organizationId);
}

/** The device, only if it belongs to an organization the caller administers. */
async function administeredDevice(request: Request, clients: UpstreamClients): Promise<AccountsDevice> {
  const org = requestedOrg(request);
  requireOrganizationAdmin(session(request), org);
  const devices = await organizationDevices(clients, org);
  const device = devices.find(candidate => candidate.id === param(request, 'deviceId'));
  if (!device) throw httpError(404, 'device_not_found');
  return device;
}

export function registerDashboardRoutes(router: Router, { clients }: RouteContext): void {
  router.get('/cloud-dashboard/v1/organizations', route(async(request, response) => {
    const org = requestedOrg(request);
    response.json(envelope(org, { organizations: session(request).organizations }));
  }));

  router.get('/cloud-dashboard/v1/summary', route(async(request, response) => {
    const org = requestedOrg(request);
    const [files, agents, workflows] = await Promise.all([
      serviceJson(request, clients, 'files', org, '/v1/files', 'GET').catch(() => []),
      serviceJson(request, clients, 'agents', org, '/v1/runs', 'GET').catch(() => []),
      serviceJson(request, clients, 'workflows', org, '/v1/workflows', 'GET').catch(() => []),
    ]);
    response.json(envelope(org, { files, agents, workflows }));
  }));

  const listDevices = route(async(request, response) => {
    const org = requestedOrg(request);
    const devices = await organizationDevices(clients, org);
    response.json(envelope(org, { devices: devices.map(deviceView) }));
  });
  router.get('/cloud-dashboard/v1/devices', listDevices);
  router.get('/devices', listDevices);

  router.patch('/devices/:deviceId', route(async(request) => {
    await administeredDevice(request, clients);
    // Accounts has no device rename route yet; refuse after the access check.
    throw httpError(501, 'device_rename_unavailable');
  }));

  router.delete('/devices/:deviceId', route(async(request, response) => {
    const device = await administeredDevice(request, clients);
    await clients.accounts.admin(`/devices/${encodeURIComponent(device.id)}/revoke`, { method: 'POST' });
    response.status(204).end();
  }));
}
