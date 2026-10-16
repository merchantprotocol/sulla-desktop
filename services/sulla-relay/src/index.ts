import http from 'node:http';

import { loadConfig } from './config.js';
import { RelayService } from './relay.js';

const config = loadConfig();
const relay = new RelayService(config);
await relay.start();

const server = http.createServer((request, response) => {
  relay.handleHttp(request, response).catch((error) => {
    console.error('[sulla-relay] request failed:', error);
    if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'application/json' });
    if (!response.writableEnded) response.end(JSON.stringify({ error: { code: 'INTERNAL', message: 'Relay request failed' } }));
  });
});
server.on('upgrade', (request, socket, head) => relay.upgrade(request, socket, head));
server.listen(config.port, '0.0.0.0', () => console.log(`[sulla-relay] ${ config.replicaId } listening on :${ config.port }`));

async function shutdown(): Promise<void> {
  server.close();
  await relay.stop();
  process.exit(0);
}
process.once('SIGTERM', () => { shutdown().catch(error => console.error('[sulla-relay] shutdown failed:', error)) });
process.once('SIGINT', () => { shutdown().catch(error => console.error('[sulla-relay] shutdown failed:', error)) });
