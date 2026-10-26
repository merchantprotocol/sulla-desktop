// Copyright © 2026 Merchant Protocol, LLC. All rights reserved.
// Licensed under the Sulla Fair-Code License. See LICENSE.

import type { Router } from 'express';

import { adminRoute } from './common.js';
import { containerLogs } from './docker.js';
import type { RouteContext } from '../routes/helpers.js';
import { param } from '../routes/helpers.js';

export function registerLogRoutes(router: Router, _context: RouteContext): void {
  router.get('/server/v1/services/:id/logs', adminRoute(async(request, response) => {
    const requested = Number(request.query.tail ?? 200);
    const tail = Number.isInteger(requested) ? Math.min(Math.max(requested, 1), 500) : 200;
    response.json({ lines: await containerLogs(param(request, 'id'), tail) });
  }));
}
