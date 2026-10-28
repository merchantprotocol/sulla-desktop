// Copyright © 2026 Merchant Protocol, LLC. All rights reserved.
// Licensed under the Sulla Fair-Code License 1.0. See LICENSES/Sulla-Fair-Code-1.0.txt.

import express from 'express';

import { requireWebSession } from './auth.js';
import type { ConsoleConfig } from './config.js';
import type { Database } from './db.js';
import type { UpstreamClients } from './clients/index.js';
import type { ServerLicenseManager } from './license.js';
import { consoleError, createRouteRegistry } from './routes.js';

const API_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "connect-src 'self'",
  "frame-src 'self'",
  "img-src 'self' data:",
  "style-src 'self'",
  "script-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
  "form-action 'none'",
].join('; ');

const CONSOLE_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

export function createApp(
  db: Database,
  config: ConsoleConfig,
  clients: UpstreamClients,
  license: ServerLicenseManager,
) {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustedProxy) app.set('trust proxy', 1);
  app.use((request, response, next) => {
    response.set({
      'Cache-Control': 'no-store',
      'Content-Security-Policy': request.path === '/console' || request.path.startsWith('/console/')
        ? CONSOLE_CONTENT_SECURITY_POLICY
        : API_CONTENT_SECURITY_POLICY,
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'SAMEORIGIN',
    });
    next();
  });
  app.use(express.json({ limit: '1mb', type: 'application/json' }));
  app.get('/healthz', (_request, response) => response.json({ status: 'ok', service: 'sulla-console' }));
  app.get('/readyz', async(_request, response) => {
    try {
      await db.query('SELECT 1');
      response.json({ ready: true });
    } catch {
      response.status(503).json({ ready: false });
    }
  });
  app.use('/api', requireWebSession(clients), createRouteRegistry({ db, clients, config, license }));
  if (config.publicDirectory) {
    app.use('/console', express.static(config.publicDirectory, { fallthrough: false, index: 'index.html' }));
  }
  app.use(consoleError);
  return app;
}
