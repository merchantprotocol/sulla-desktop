import { createServer } from 'node:http';

import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { connectDatabase, migrate } from './db.js';
import { ensureHostedAuthority } from './oidc.js';

const config = await loadConfig();
const db = await connectDatabase(config.databaseUrl);
await migrate(db);
await ensureHostedAuthority(db, config);

const server = createServer(createApp(db, config));
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
