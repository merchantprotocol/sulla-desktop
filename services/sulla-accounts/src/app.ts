import express from 'express';

import { adminRoutes, errorHandler, ownerRoutes, privateRoutes } from './routes.js';

import type { AccountsConfig } from './config.js';
import type { Database } from './db.js';

export function createApp(db: Database, config: AccountsConfig) {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustedProxy) app.set('trust proxy', 1);
  app.use(express.json({ limit: '1mb', type: 'application/json' }));

  app.get('/healthz', (_request, response) => response.json({ ok: true }));
  app.get('/readyz', async(_request, response) => {
    try {
      await db.query('SELECT 1');
      response.json({ ready: true });
    } catch {
      response.status(503).json({ ready: false });
    }
  });

  app.use('/v1/private', privateRoutes(db, config));
  if (config.mode === 'server') app.use('/v1/admin', adminRoutes(db, config));
  app.use('/v1', ownerRoutes(db, config));
  app.use((_request, response) => response.status(404).json({ error: 'not_found' }));
  app.use(errorHandler);
  return app;
}
