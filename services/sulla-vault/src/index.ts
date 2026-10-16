import { createApp } from './app.js';
import { ensureDesktopAccount } from './auth.js';
import { loadConfig } from './config.js';
import { connectDatabase, migrate } from './db.js';

const config = loadConfig();
const db = await connectDatabase(config);
await migrate(db);
await ensureDesktopAccount(db, config);

const server = createApp(db, config).listen(config.port, '0.0.0.0', () => {
  console.log(`sulla-vault listening on :${ config.port } (${ config.mode } mode)`);
});

async function shutdown(): Promise<void> {
  server.close();
  await db.end();
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
