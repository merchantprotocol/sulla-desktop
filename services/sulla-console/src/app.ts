// Copyright © 2026 Merchant Protocol, LLC. All rights reserved.
// Licensed under the Sulla Fair-Code License. See LICENSE.

import express from 'express';

import { requireWebSession } from './auth.js';
import type { ConsoleConfig } from './config.js';
import type { Database } from './db.js';
import type { UpstreamClients } from './clients/index.js';
import { createRouteRegistry } from './routes.js';

export function createApp(db: Database, config: ConsoleConfig, clients: UpstreamClients) {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustedProxy) app.set('trust proxy', 1);
  app.use((_request, response, next) => {
    response.set({
      'Content-Security-Policy': "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
    });
    next();
  });
  app.use(express.json({ limit: '1mb', type: 'application/json' }));
  app.get('/healthz', (_request, response) => response.json({ ok: true }));
  app.get('/readyz', async(_request, response) => {
    try { await db.query('SELECT 1'); response.json({ ready: true }); }
    catch { response.status(503).json({ ready: false }); }
  });
  app.use('/api', requireWebSession(clients), createRouteRegistry({ db, clients }));
  if (config.publicDirectory) app.use('/console', express.static(config.publicDirectory, { fallthrough: false, index: 'index.html' }));
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    console.error(error);
    response.status(500).json({ error: 'internal_error' });
  });
  return app;
}
