// Copyright © 2026 Merchant Protocol, LLC. All rights reserved.
// Licensed under the Sulla Fair-Code License 1.0. See LICENSES/Sulla-Fair-Code-1.0.txt.

import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express from 'express';

import type { AccountsSession } from './clients/accounts.js';
import type { UpstreamClients } from './clients/index.js';
import { requireOrganization } from './orgScope.js';
import { type RouteContext, consoleError, createRouteRegistry } from './routes.js';

function sessionIn(roles: string[]): AccountsSession {
  return {
    authenticated: true,
    identity: { issuer: 'test', subject: 'user-x' },
    serverAdmin: false,
    organizations: [{ id: 'org-x', name: 'X', slug: 'x', roles, groups: [] }],
    expiresAt: new Date().toISOString(),
  };
}

const devices = [
  { id: 'device-x', organization_id: 'org-x', subject: 'user-x', device_id: 'dx', status: 'active' },
  { id: 'device-y', organization_id: 'org-y', subject: 'user-y', device_id: 'dy', status: 'active' },
];

/** The real Console routes over a fake Accounts admin API that holds devices for two orgs. */
async function consoleApi(current: AccountsSession) {
  const adminCalls: string[] = [];
  const clients = {
    accounts: {
      admin: async(path: string) => {
        adminCalls.push(path);
        return { devices };
      },
    },
  } as unknown as UpstreamClients;
  const app = express();
  app.use((request, _response, next) => {
    request.consoleSession = current;
    next();
  });
  app.use(createRouteRegistry({ clients } as RouteContext));
  app.use(consoleError);
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    adminCalls,
    call: (method: string, path: string) => fetch(`${base}${path}`, { method }),
    close: () => server.close(),
  };
}

test('a member of org X cannot access org Y', () => {
  const session = sessionIn(['member']);
  const forbidden = (error: Error & { status?: number }) => error.status === 403;
  assert.throws(() => requireOrganization(session, 'org-y'), forbidden);
});

test('a member of org X cannot list or revoke org Y devices', async() => {
  const api = await consoleApi(sessionIn(['owner', 'admin']));
  try {
    assert.equal((await api.call('GET', '/devices?team=org-y')).status, 403);
    assert.equal((await api.call('DELETE', '/devices/device-y?team=org-y')).status, 403);

    const listed = await (await api.call('GET', '/cloud-dashboard/v1/devices?team=org-x')).json();
    assert.deepEqual(listed.data.devices.map((device: { id: string }) => device.id), ['device-x']);

    // Naming org X but a device from org Y must not reach the revoke route.
    assert.equal((await api.call('DELETE', '/devices/device-y?team=org-x')).status, 404);
    assert.ok(!api.adminCalls.some(path => path.includes('/revoke')));
  } finally {
    api.close();
  }
});

test('only owners and admins can revoke a device in their own org', async() => {
  const member = await consoleApi(sessionIn(['member']));
  try {
    assert.equal((await member.call('DELETE', '/devices/device-x?team=org-x')).status, 403);
    assert.ok(!member.adminCalls.some(path => path.includes('/revoke')));
  } finally {
    member.close();
  }
  const admin = await consoleApi(sessionIn(['admin']));
  try {
    assert.equal((await admin.call('DELETE', '/devices/device-x?team=org-x')).status, 204);
    assert.deepEqual(admin.adminCalls.at(-1), '/devices/device-x/revoke');
  } finally {
    admin.close();
  }
});
