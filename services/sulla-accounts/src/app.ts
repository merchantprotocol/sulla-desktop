// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import express from 'express';
import { bootstrapRoutes, errorHandler, ownerRoutes, privateRoutes } from './routes.js';
import type { AccountsAdapter } from './adapter.js';
import type { AccountsConfig } from './config.js';
import type { Database } from './db.js';

export async function createApp(db: Database, config: AccountsConfig, adapter?: AccountsAdapter) {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustedProxy) app.set('trust proxy', 1);
  app.use(express.json({ limit: '1mb', type: 'application/json' }));
  app.get('/healthz', (_request, response) => response.json({ ok: true }));
  app.get('/readyz', async (_request, response) => {
    try { await db.query('SELECT 1'); response.json({ ready: true }); }
    catch { response.status(503).json({ ready: false }); }
  });
  if (adapter) await adapter.register(app, { db, config });
  app.use('/v1/private', bootstrapRoutes(db, config));
  app.use('/v1/private', privateRoutes(db, config));
  app.use('/v1', ownerRoutes(db, config));
  app.use((_request, response) => response.status(404).json({ error: 'not_found' }));
  app.use(errorHandler);
  return app;
}
