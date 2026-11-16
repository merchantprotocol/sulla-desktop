// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import http from 'node:http';

import { loadConfig } from './config.js';
import { ProcessGuard } from './ProcessGuard.js';
import { RelayService } from './relay.js';

// Crash -> non-zero exit -> Docker's restart policy; a Redis that is down at boot fails start the same way.
const guard = new ProcessGuard({ name: 'sulla-relay' }).catchCrashes();
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

// relay.stop() tolerates an already-closed Redis (#2250); the guard's deadline covers anything else that hangs.
guard.handleSignals(async() => {
  server.close();
  await relay.stop();
});
