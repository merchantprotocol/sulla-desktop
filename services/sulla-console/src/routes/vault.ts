// Copyright © 2026 Merchant Protocol, LLC. All rights reserved.
// Licensed under the Sulla Fair-Code License. See LICENSE.

import type { Router } from 'express';

import { type RouteContext, requestedOrg, route, serviceJson } from './helpers.js';

export function registerVaultRoutes(router: Router, { clients }: RouteContext): void {
  router.get('/cloud-vault-sync/status', route(async(request, response) => {
    const org = requestedOrg(request);
    response.json(await serviceJson(request, clients, 'vault', org, '/cloud-vault-sync/status'));
  }));

  router.post('/cloud-vault-sync/browser/handoff', route(async(request, response) => {
    const org = requestedOrg(request);
    response.json(await serviceJson(request, clients, 'vault', org, '/cloud-vault-sync/browser/handoff', 'POST'));
  }));
}
