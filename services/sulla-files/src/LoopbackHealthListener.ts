// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import http, { type RequestListener, type Server } from 'node:http';

/**
 * Plain-HTTP /healthz on the container's loopback only, for the Docker healthcheck.
 *
 * The TLS port needed a `node -e` https client per tick (a whole Node runtime every 5 s, about a
 * third of a CPU on a busy 3-vCPU VM, and slow enough under load to miss its timeout and get
 * Files restarted). BusyBox `wget` against this port costs a few milliseconds and no TLS. It
 * answers /healthz only, from the same handler as the public port, and is unreachable from
 * outside the container.
 */
export class LoopbackHealthListener {
  private server?:Server;

  constructor(private readonly handler:() => RequestListener, private readonly port:number, private readonly host = '127.0.0.1') {}

  listen():Server {
    this.server = http.createServer((request, response) => {
      if (request.method !== 'GET' || (request.url ?? '').split('?', 1)[0] !== '/healthz') {
        response.writeHead(404, { 'content-type': 'application/json' }); response.end('{"error":"not found"}'); return;
      }
      this.handler()(request, response);
    });
    this.server.on('error', error => console.warn('[SullaFiles] loopback health listener unavailable:', error.message));
    return this.server.listen(this.port, this.host);
  }

  close():void { this.server?.close() }
}
