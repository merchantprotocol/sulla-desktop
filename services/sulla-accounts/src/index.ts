// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { createServer } from 'node:http';

import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { connectDatabase, migrate } from './db.js';

const config = await loadConfig();
const db = await connectDatabase(config.databaseUrl, config.mode);
await migrate(db);

const server = createServer(await createApp(db, config));
server.listen(config.port, '0.0.0.0', () => {
  console.log(`sulla-accounts listening on :${config.port} (${config.mode} mode)`);
});

async function shutdown(): Promise<void> {
  server.closeIdleConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await db.end();
}

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
