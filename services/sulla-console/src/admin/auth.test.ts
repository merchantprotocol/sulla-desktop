// Copyright © 2026 Merchant Protocol, LLC. All rights reserved.
// Licensed under the Sulla Fair-Code License. See LICENSE.

import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express, { Router } from 'express';

import type { AccountsSession } from '../clients/accounts.js';
import { consoleError } from '../routes.js';
import { registerLicenseRoutes } from '../routes/license.js';
import type { RouteContext } from '../routes/helpers.js';
import { registerAdminRoutes } from './index.js';

const NON_ADMIN: AccountsSession = {
  authenticated: true,
  identity: { issuer: 'test', subject: 'member-x' },
  serverAdmin: false,
  organizations: [{ id: 'org-x', name: 'X', slug: 'x', roles: ['owner'], groups: [] }],
  expiresAt: new Date().toISOString(),
};

const ROUTES = [
  ['GET', '/server/v1/overview'],
  ['GET', '/server/v1/users'],
  ['POST', '/server/v1/users/user-x/disable'],
  ['POST', '/server/v1/users/user-x/enable'],
  ['GET', '/server/v1/license'],
  ['POST', '/server/v1/license'],
  ['GET', '/server/v1/domains'],
  ['GET', '/server/v1/signin'],
  ['PUT', '/server/v1/signin'],
  ['POST', '/server/v1/signin/test-email'],
  ['GET', '/server/v1/providers'],
  ['PUT', '/server/v1/providers/defaults'],
  ['PUT', '/server/v1/providers/anthropic'],
  ['GET', '/server/v1/desktops'],
  ['POST', '/server/v1/desktops/device-x/approve'],
  ['POST', '/server/v1/desktops/device-x/revoke'],
  ['PUT', '/server/v1/desktops/rules'],
  ['GET', '/server/v1/storage'],
  ['GET', '/server/v1/backups'],
  ['PUT', '/server/v1/backups'],
  ['POST', '/server/v1/backups/run'],
  ['GET', '/server/v1/updates'],
  ['GET', '/server/v1/audit'],
  ['GET', '/server/v1/services/console/logs'],
] as const;

test('a non-server-admin gets 403 from every server administration route', async() => {
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    request.consoleSession = NON_ADMIN;
    next();
  });
  const router = Router();
  const context = {} as RouteContext;
  registerAdminRoutes(router, context);
  registerLicenseRoutes(router, context);
  app.use(router);
  app.use(consoleError);
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    for (const [method, path] of ROUTES) {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: method === 'GET' ? undefined : '{}',
      });
      assert.equal(response.status, 403, `${method} ${path}`);
      assert.deepEqual(await response.json(), { error: 'server_admin_required' });
    }
  } finally {
    server.close();
  }
});
