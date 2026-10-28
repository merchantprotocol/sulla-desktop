// Copyright © 2026 Merchant Protocol, LLC. All rights reserved.
// Licensed under the Sulla Fair-Code License 1.0. See LICENSES/Sulla-Fair-Code-1.0.txt.

import { Router, type NextFunction, type Request, type Response } from 'express';

import { registerAdminRoutes } from './admin/index.js';
import { UpstreamError } from './clients/upstream.js';
import { LicenseError } from './license.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerChatRoutes } from './routes/chat.js';
import { registerDashboardRoutes } from './routes/dashboard.js';
import { registerFilesRoutes } from './routes/files.js';
import type { RouteContext } from './routes/helpers.js';
import { registerLicenseRoutes } from './routes/license.js';
import { registerRuntimeRoutes } from './routes/runtime.js';
import { registerTeamRoutes } from './routes/teams.js';
import { registerUsageRoutes } from './routes/usage.js';
import { registerUseCaseRoutes } from './routes/usecases.js';
import { registerVaultRoutes } from './routes/vault.js';

export type { RouteContext } from './routes/helpers.js';

/** Route modules register here without changing the app or auth boundary. */
export function createRouteRegistry(context: RouteContext): Router {
  const router = Router();
  registerAdminRoutes(router, context);
  registerAuthRoutes(router, context);
  registerTeamRoutes(router, context);
  registerDashboardRoutes(router, context);
  registerFilesRoutes(router, context);
  registerRuntimeRoutes(router, context);
  registerChatRoutes(router, context);
  registerVaultRoutes(router, context);
  registerUsageRoutes(router, context);
  registerUseCaseRoutes(router, context);
  registerLicenseRoutes(router, context);
  return router;
}

function errorStatus(error: unknown): number {
  if (error instanceof UpstreamError) return error.status;
  if (typeof error === 'object' && error && 'status' in error) return Number((error as { status: unknown }).status);
  return 500;
}

export function consoleError(error: unknown, _request: Request, response: Response, _next: NextFunction): void {
  if (error instanceof LicenseError) {
    response.status(422).json({ error: error.code, message: error.message });
    return;
  }
  const status = errorStatus(error);
  if (!(status >= 400 && status < 500)) {
    console.error('[console] request failed', error);
    response.status(status >= 500 && status < 600 ? status : 500).json({ error: 'internal_error' });
    return;
  }
  response.status(status).json({ error: errorCode(error) });
}

function errorCode(error: unknown): string {
  if (error instanceof UpstreamError) {
    const body = error.body as { error?: unknown } | undefined;
    return typeof body?.error === 'string' ? body.error : 'upstream_request_failed';
  }
  return error instanceof Error ? error.message : 'request_failed';
}
