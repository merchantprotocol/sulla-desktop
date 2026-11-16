// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// E9 app.ts equivalence harness: drives the frozen legacy vault app and the current one with
// identical doubles and identical HTTP requests, and normalises what each returns so the two
// can be compared field by field. Delete with the E9 legacy copies in the final cleanup.

import http from 'node:http';

import type express from 'express';

import type { VaultConfig } from '../../../../../../services/sulla-vault/src/config';
import type { Database } from '../../../../../../services/sulla-vault/src/db';
import type { LocalVaultAuthority } from '../../../../../../services/sulla-vault/src/localAuthority';
import type { AuditFileEvent } from '../../../../../../services/sulla-vault/src/auditFileSink';

export type VaultAppFactory = (db: Database, config: VaultConfig, options: { localAuthority?: LocalVaultAuthority }) => express.Express;

export interface RecordedCall { method: string; args: unknown[] }

/** Plain-data view of call arguments: functions, signals and class instances become stable labels. */
export class CallArgumentNormaliser {
  normalise(value: unknown): unknown {
    if (typeof value === 'function') return '[function]';
    if (value instanceof AbortSignal) return '[AbortSignal]';
    if (Array.isArray(value)) return value.map(entry => this.normalise(entry));
    if (value && typeof value === 'object') {
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) return `[${ (value as object).constructor?.name ?? 'object' }]`;
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, this.normalise(entry)]));
    }
    return value;
  }
}

/** LocalVaultAuthority double: records every method call; scenarios override individual methods. */
export class AuthorityDouble {
  readonly calls: RecordedCall[] = [];
  readonly authority: LocalVaultAuthority;
  private readonly overrides = new Map<string, (...args: any[]) => unknown>();
  private readonly normaliser = new CallArgumentNormaliser();

  constructor(private readonly fileEvents: AuditFileEvent[] = []) {
    const outboundAuditSink = {
      readRecent: async(accept: (event: AuditFileEvent) => boolean, max: number) => {
        this.calls.push({ method: 'outboundAuditSink.readRecent', args: [max] });
        return this.fileEvents.filter(accept).slice(0, max);
      },
    };
    this.authority = new Proxy({}, {
      get: (_target, property) => {
        if (typeof property !== 'string' || property === 'then') return undefined;
        if (property === 'outboundAuditSink') return outboundAuditSink;
        return (...args: unknown[]) => {
          this.calls.push({ method: property, args: this.normaliser.normalise(args) as unknown[] });
          const override = this.overrides.get(property);
          return override ? override(...args) : { called: property };
        };
      },
    }) as unknown as LocalVaultAuthority;
  }

  on(method: string, implementation: (...args: any[]) => unknown): this {
    this.overrides.set(method, implementation);
    return this;
  }
}

/** Database double for routes that only probe Postgres; records every query. */
export class DatabaseDouble {
  readonly queries: Array<{ sql: string; params?: unknown[] }> = [];
  failure: unknown = null;
  readonly db: Database;

  constructor() {
    this.db = {
      query: async(sql: string, params?: unknown[]) => {
        this.queries.push({ sql, params });
        if (this.failure) throw this.failure;
        return { rows: [{ '?column?': 1 }], rowCount: 1 };
      },
    } as unknown as Database;
  }
}

export interface HttpRequestSpec {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
  rawBody?: string;
}

export interface HttpOutcome {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  maxAge?: number;
}

/** Starts one app on an ephemeral port, sends one request and returns a comparable outcome. */
export class VaultAppProbe {
  private static readonly volatileHeaders = new Set(['date', 'etag', 'last-modified', 'connection', 'keep-alive']);

  async send(app: express.Express, spec: HttpRequestSpec): Promise<HttpOutcome> {
    const server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('test server did not bind');
      return await this.request(`http://127.0.0.1:${ address.port }`, spec);
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }

  private request(baseUrl: string, spec: HttpRequestSpec): Promise<HttpOutcome> {
    const payload = spec.rawBody ?? (spec.body === undefined ? undefined : JSON.stringify(spec.body));
    const headers: Record<string, string> = { ...(payload === undefined ? {} : { 'content-type': 'application/json' }), ...spec.headers };
    return new Promise((resolve, reject) => {
      const request = http.request(new URL(spec.path, baseUrl), { method: spec.method, headers }, response => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { text += chunk });
        response.on('end', () => resolve(this.outcome(response, text)));
        response.on('error', reject);
      });
      request.on('error', reject);
      if (payload !== undefined) request.write(payload);
      request.end();
    });
  }

  private outcome(response: http.IncomingMessage, text: string): HttpOutcome {
    const headers: Record<string, string | string[] | undefined> = {};
    let maxAge: number | undefined;
    for (const [name, value] of Object.entries(response.headers)) {
      if (VaultAppProbe.volatileHeaders.has(name)) continue;
      if (name === 'set-cookie' && Array.isArray(value)) {
        headers[name] = value.map(cookie => cookie.replace(/Max-Age=(\d+)/, (_match, seconds: string) => {
          maxAge = Number(seconds);
          return 'Max-Age=<n>';
        }));
        continue;
      }
      headers[name] = value;
    }
    let body: unknown = text;
    if (String(response.headers['content-type'] ?? '').includes('application/json')) {
      try { body = JSON.parse(text) } catch { /* keep the raw text */ }
    }
    return { status: response.statusCode ?? 0, headers, body, maxAge };
  }
}

/** One synthetic desktop config shared by both apps (no secrets: fixed fake tokens). */
export class VaultAppConfigFactory {
  static readonly humanUiOrigin = 'https://vault.sulla.test';
  static readonly approvalServiceId = 'sulla-desktop-approval';
  static readonly approvalServiceToken = 'approval_' + 'c'.repeat(64);

  create(): VaultConfig {
    return {
      mode: 'desktop',
      port: 0,
      databaseUrl: 'postgresql://synthetic/unused',
      extensionOrigins: ['https://ext.example.test'],
      humanUiOrigin: VaultAppConfigFactory.humanUiOrigin,
      bootstrapServiceId: 'sulla-desktop-bootstrap',
      bootstrapServiceToken: 'bootstrap_' + 'a'.repeat(64),
      controlServiceId: 'sulla-desktop-control',
      controlServiceToken: 'control_' + 'b'.repeat(64),
      approvalServiceId: VaultAppConfigFactory.approvalServiceId,
      approvalServiceToken: VaultAppConfigFactory.approvalServiceToken,
      brokerServiceId: 'sulla-tools',
      brokerServiceToken: 'broker_' + 'd'.repeat(64),
      filesServiceId: 'sulla-files',
      filesServiceToken: 'files_' + 'e'.repeat(64),
    } as VaultConfig;
  }
}

/** Express 5 router stack as plain data: kind, normalised handler name, route path/methods, probe matches. */
export class VaultRouteTable {
  static readonly probes = [
    '/', '/healthz', '/v1', '/v1/desktop/files', '/v1/desktop/files/key-bundles', '/v1/desktop/status', '/v1/human',
    '/v1/human/session', '/v1/human/items', '/v1/broker/execute', '/v1/memory-sync/wrap-key',
    '/v1/desktop/cloud-sync/status', '/vault', '/vault/', '/vault/index.html', '/v1/unknown', '/other',
  ];
  private static readonly knownNames = new Set(['jsonParser', 'serveStatic', 'router', 'handle']);

  describe(app: express.Express): unknown[] {
    const stack = (app as unknown as { router: { stack: any[] } }).router.stack;
    return stack.map(layer => ({
      kind: layer.route ? 'route' : 'middleware',
      name: VaultRouteTable.knownNames.has(layer.name) ? layer.name : '<fn>',
      path: layer.route ? String(layer.route.path) : undefined,
      methods: layer.route ? Object.keys(layer.route.methods).sort() : undefined,
      handlers: layer.route ? layer.route.stack.length : undefined,
      matches: VaultRouteTable.probes.filter(probe => layer.match(probe)),
    }));
  }
}
