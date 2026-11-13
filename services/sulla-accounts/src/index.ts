// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { createServer } from 'node:http';

import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { connectDatabase, migrate } from './db.js';
import { ProcessGuard } from './ProcessGuard.js';

// Crash or failed start (Postgres unreachable, migration error) -> non-zero exit -> Docker's restart policy.
const guard = new ProcessGuard({ name: 'sulla-accounts' }).catchCrashes();
const config = await loadConfig();
const db = await connectDatabase(config.databaseUrl, config.mode);
await migrate(db);

const server = createServer(await createApp(db, config));
server.listen(config.port, '0.0.0.0', () => {
  console.log(`sulla-accounts listening on :${config.port} (${config.mode} mode)`);
});

// Always exits, within the guard's deadline.
guard.handleSignals(async() => {
  server.closeIdleConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await db.end();
});
