// Copyright © 2026 Merchant Protocol, LLC. All rights reserved.
// Licensed under the Sulla Fair-Code License 1.0. See LICENSES/Sulla-Fair-Code-1.0.txt.

import type { Router } from 'express';

import { registerAuditRoutes } from './audit.js';
import { registerDesktopsRoutes } from './desktops.js';
import { registerDomainsRoutes } from './domains.js';
import { registerLogRoutes } from './logs.js';
import { registerOverviewRoutes } from './overview.js';
import { registerProvidersRoutes } from './providers.js';
import { registerSigninRoutes } from './signin.js';
import { registerStorageRoutes } from './storage.js';
import { registerUpdatesRoutes } from './updates.js';
import { registerUsersRoutes } from './users.js';
import type { RouteContext } from '../routes/helpers.js';

export function registerAdminRoutes(router: Router, context: RouteContext): void {
  registerOverviewRoutes(router, context);
  registerUsersRoutes(router, context);
  registerDomainsRoutes(router, context);
  registerSigninRoutes(router, context);
  registerProvidersRoutes(router, context);
  registerDesktopsRoutes(router, context);
  registerStorageRoutes(router, context);
  registerUpdatesRoutes(router, context);
  registerAuditRoutes(router, context);
  registerLogRoutes(router, context);
}
