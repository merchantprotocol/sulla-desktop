// Copyright © 2026 Merchant Protocol, LLC. All rights reserved.
// Licensed under the Sulla Fair-Code License. See LICENSE.

import { Router } from 'express';

import type { Database } from './db.js';
import type { UpstreamClients } from './clients/index.js';

export interface RouteContext { db: Database; clients: UpstreamClients }

/** Route modules register here without changing the app or auth boundary. */
export function createRouteRegistry(_context: RouteContext): Router {
  return Router();
}
