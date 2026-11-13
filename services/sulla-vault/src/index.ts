// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { createApp } from './app.js';
import { readFile } from 'node:fs/promises';
import https from 'node:https';
import { ensureDesktopAccount } from './auth.js';
import { loadConfig } from './config.js';
import { connectDatabase, migrate, untilDatabaseReady } from './db.js';
import { ProcessGuard } from './ProcessGuard.js';

// Crash -> non-zero exit -> Docker's restart policy. Postgres outages are waited out
// (untilDatabaseReady) and /healthz reports them; they never crash the vault.
const guard = new ProcessGuard({ name: 'sulla-vault' }).catchCrashes();
const config = loadConfig();
const db = await connectDatabase(config);
await untilDatabaseReady('migrations', () => migrate(db));
await untilDatabaseReady('desktop account', () => ensureDesktopAccount(db, config));

const app = createApp(db, config);
if (!config.tlsCertificatePath || !config.tlsPrivateKeyPath) {
  throw new Error('Desktop vault TLS identity is required');
}
const server = https.createServer({
  cert: await readFile(config.tlsCertificatePath),
  key:  await readFile(config.tlsPrivateKeyPath),
}, app);
server.listen(config.port, '0.0.0.0', () => {
  console.log(`sulla-vault listening on :${ config.port } (${ config.mode } mode)`);
});

// Always exits: before, an open keep-alive connection kept the process up until Docker killed it.
guard.handleSignals(async() => {
  server.closeIdleConnections();
  server.close();
  await db.end();
});
