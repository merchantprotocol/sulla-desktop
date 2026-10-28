// Copyright © 2026 Merchant Protocol, LLC. All rights reserved.
// Licensed under the Sulla Fair-Code License 1.0. See LICENSES/Sulla-Fair-Code-1.0.txt.

import type { Request, Router } from 'express';

import { isServerAdmin } from '../orgScope.js';
import { type RouteContext, audit, httpError, route, session } from './helpers.js';

function requireServerAdmin(request: Request): void {
  if (!isServerAdmin(session(request))) throw httpError(403, 'server_admin_required');
}

export function registerLicenseRoutes(router: Router, { db, clients, license }: RouteContext): void {
  router.get('/server/v1/license', route(async(request, response) => {
    requireServerAdmin(request);
    await license.evaluate();
    response.json(license.status());
  }));

  router.post('/server/v1/license', route(async(request, response) => {
    requireServerAdmin(request);
    const status = await license.activate(String(request.body?.licenseKey ?? ''));
    // An unlimited license (no seat claim) leaves the Accounts limit where it is.
    if (typeof status.seats === 'number') {
      await clients.accounts.admin('/limits', {
        method: 'PUT',
        body: JSON.stringify({ seatLimit: status.seats }),
      });
    }
    await audit(db, request, null, 'license.activate', {
      fingerprint: status.masked,
      edition: status.edition,
      seats: status.seats,
    });
    void license.checkIn({ force: true }).catch(error => console.error('[license] check-in failed', error));
    response.json(status);
  }));
}
