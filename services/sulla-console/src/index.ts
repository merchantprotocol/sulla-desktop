// Copyright © 2026 Merchant Protocol, LLC. All rights reserved.
// Licensed under the Sulla Fair-Code License 1.0. See LICENSES/Sulla-Fair-Code-1.0.txt.

import { createServer } from 'node:http';

import { createApp } from './app.js';
import { createUpstreamClients } from './clients/index.js';
import { loadConfig } from './config.js';
import { connectDatabase, migrate } from './db.js';
import { ServerLicenseManager } from './license.js';

const config = await loadConfig();
const db = await connectDatabase(config.databaseUrl);
await migrate(db);
const clients = createUpstreamClients(config);
const license = new ServerLicenseManager({
  stateFile: config.licenseStateFile,
  publicKey: config.licensePublicKey,
  cloudUrl: config.cloudUrl,
  // Accounts counts active members and pending invitations, the same number it enforces seats on.
  seatCount: async() => {
    const limits = await clients.accounts.admin<{ seatsUsed: number }>('/limits');
    return limits.seatsUsed;
  },
});
await license.init();
function checkIn(): void {
  license.checkIn().catch(error => console.error('[license] check-in failed', error));
}
const checkInTimer = setInterval(checkIn, 60_000);
checkInTimer.unref();
checkIn();
const server = createServer(createApp(db, config, clients, license));
server.listen(config.port, '0.0.0.0', () => console.log(`sulla-console listening on :${config.port}`));

async function shutdown(): Promise<void> {
  server.closeIdleConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await db.end();
}
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
