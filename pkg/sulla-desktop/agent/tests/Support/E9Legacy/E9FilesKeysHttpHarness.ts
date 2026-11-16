// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Ephemeral express server for the E9 route equivalence specs (listen(0) on
// loopback, same approach as Feature/Vault/VaultEnrollmentRoutes.spec.ts).
// Unhandled errors end in a deterministic 599 so stack traces never differ.
// Delete in final cleanup.

import http from 'node:http';

import express from 'express';

export interface E9HttpRequest {
  method:   'GET' | 'POST' | 'PUT' | 'DELETE';
  path:     string;
  headers?: Record<string, string>;
  body?:    unknown;
  rawBody?: string;
}

export interface E9HttpResponse {
  status:       number;
  cacheControl: string | null;
  contentType:  string | null;
  body:         string;
}

export class E9HttpHarness {
  private server: http.Server | null = null;
  private baseUrl = '';

  constructor(private readonly mount: (app: express.Express) => void) {}

  async start(): Promise<void> {
    const app = express();
    app.use(express.json({ limit: '36mb' }));
    this.mount(app);
    app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
      response.status(599).json({ unhandled: error instanceof Error ? error.message : String(error) });
    });
    this.server = http.createServer(app);
    await new Promise<void>(resolve => this.server!.listen(0, '127.0.0.1', resolve));
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');
    this.baseUrl = `http://127.0.0.1:${ address.port }`;
  }

  async send(request: E9HttpRequest): Promise<E9HttpResponse> {
    const headers: Record<string, string> = { ...(request.headers ?? {}) };
    let body: string | undefined;
    if (request.rawBody !== undefined) body = request.rawBody;
    else if (request.body !== undefined) body = JSON.stringify(request.body);
    if (body !== undefined && !Object.keys(headers).some(name => name.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json';
    const response = await fetch(`${ this.baseUrl }${ request.path }`, { method: request.method, headers, body });
    return {
      status:       response.status,
      cacheControl: response.headers.get('cache-control'),
      contentType:  response.headers.get('content-type'),
      body:         await response.text(),
    };
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  }
}
