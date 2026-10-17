import { createApp } from './app.js';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { ensureDesktopAccount } from './auth.js';
import { loadConfig } from './config.js';
import { connectDatabase, migrate } from './db.js';

const config = loadConfig();
const db = await connectDatabase(config);
await migrate(db);
await ensureDesktopAccount(db, config);

const app = createApp(db, config);
if (config.mode === 'desktop' && (!config.tlsCertificatePath || !config.tlsPrivateKeyPath)) {
  throw new Error('Desktop vault TLS identity is required');
}
const server = config.tlsCertificatePath && config.tlsPrivateKeyPath
  ? https.createServer({
    cert: await readFile(config.tlsCertificatePath),
    key:  await readFile(config.tlsPrivateKeyPath),
  }, app)
  : http.createServer(app);
server.listen(config.port, '0.0.0.0', () => {
  console.log(`sulla-vault listening on :${ config.port } (${ config.mode } mode)`);
});

async function shutdown(): Promise<void> {
  server.close();
  await db.end();
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
