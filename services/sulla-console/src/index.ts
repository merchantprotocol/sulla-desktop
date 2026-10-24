// Copyright © 2026 Merchant Protocol, LLC. All rights reserved.
// Licensed under the Sulla Fair-Code License. See LICENSE.

import { createServer } from 'node:http';

import { createApp } from './app.js';
import { createUpstreamClients } from './clients/index.js';
import { loadConfig } from './config.js';
import { connectDatabase, migrate } from './db.js';

const config = await loadConfig();
const db = await connectDatabase(config.databaseUrl);
await migrate(db);
const server = createServer(createApp(db, config, createUpstreamClients(config)));
server.listen(config.port, '0.0.0.0', () => console.log(`sulla-console listening on :${config.port}`));

async function shutdown(): Promise<void> {
  server.closeIdleConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await db.end();
}
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
