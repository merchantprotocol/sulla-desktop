// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Desktop-only control surface for Passwords sync v3. The routes live in
// CloudSyncRoutes; this module keeps the pre-E9 entry point.

import type express from 'express';

import { CloudSyncRoutes } from './CloudSyncRoutes.js';
import type { CloudVaultSyncRunner } from './syncRunner.js';

export { CloudSyncRoutes };

/** @deprecated use CloudSyncRoutes — E9 alias, removed in final cleanup */
export function registerCloudSyncRoutes(
  app: express.Express,
  runner: CloudVaultSyncRunner,
  requireDesktopIdentity: (request: express.Request) => void,
): void {
  new CloudSyncRoutes(runner, requireDesktopIdentity).register(app);
}
