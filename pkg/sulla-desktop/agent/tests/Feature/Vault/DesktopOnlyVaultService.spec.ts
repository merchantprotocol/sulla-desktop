// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

// The Desktop vault runs only in desktop mode; the hosted vault moved to
// merchantprotocol/sulla-server (M8). These tests drive the real config loader,
// the real Express app and the real broker switch.

import http from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import { usesContainerVaultAuthority } from '@pkg/vault-broker';

import { createApp } from '../../../../../../services/sulla-vault/src/app';
import { loadConfig } from '../../../../../../services/sulla-vault/src/config';

import type { VaultConfig } from '../../../../../../services/sulla-vault/src/config';
import type { Database } from '../../../../../../services/sulla-vault/src/db';
import type { LocalVaultAuthority } from '../../../../../../services/sulla-vault/src/localAuthority';

class VaultEnvironment {
  private readonly saved = new Map<string, string | undefined>();

  set(name: string, value: string | undefined): void {
    if (!this.saved.has(name)) this.saved.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  restore(): void {
    for (const [name, value] of this.saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    this.saved.clear();
  }
}

class DesktopVaultServer {
  private server: http.Server | null = null;
  private baseUrl = '';

  async start(): Promise<void> {
    const database = { query: async() => ({ rows: [{ '?column?': 1 }], rowCount: 1 }) } as unknown as Database;
    const authority = {} as unknown as LocalVaultAuthority;
    const config: VaultConfig = {
      mode:                  'desktop',
      port:                  0,
      databaseUrl:           'postgresql://synthetic/unused',
      extensionOrigins:      [],
      bootstrapServiceToken: 'bootstrap_' + 'a'.repeat(64),
      controlServiceToken:   'control_' + 'b'.repeat(64),
      approvalServiceToken:  'approval_' + 'c'.repeat(64),
      brokerServiceToken:    'broker_' + 'd'.repeat(64),
      filesServiceId:        'sulla-files',
      filesServiceToken:     'files_' + 'e'.repeat(64),
    };
    this.server = http.createServer(createApp(database, config, { localAuthority: authority }));
    await new Promise<void>(resolve => this.server!.listen(0, '127.0.0.1', resolve));
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');
    this.baseUrl = `http://127.0.0.1:${ address.port }`;
  }

  async request(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    const response = await fetch(new URL(path, this.baseUrl), {
      method,
      redirect: 'manual',
      headers:  body === undefined ? {} : { 'content-type': 'application/json' },
      body:     body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let json: unknown = text;
    try { json = JSON.parse(text); } catch { /* non-JSON body */ }
    return { status: response.status, json };
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve, reject) => this.server!.close(error => error ? reject(error) : resolve()));
    this.server = null;
  }
}

describe('Desktop-only vault service', () => {
  const environment = new VaultEnvironment();
  let server: DesktopVaultServer | undefined;

  afterEach(async() => {
    environment.restore();
    await server?.stop();
    server = undefined;
  });

  it('refuses to start in the removed hosted server mode', () => { // risk: Desktop silently booting a hosted vault
    environment.set('SULLA_VAULT_DATABASE_URL', 'postgresql://synthetic/unused');
    environment.set('SULLA_VAULT_MODE', 'server');

    expect(() => loadConfig()).toThrow(/SULLA_VAULT_MODE must be desktop/);
  });

  it('loads desktop mode when the app sets it and when it is unset', () => { // risk: Desktop vault fails to boot
    environment.set('SULLA_VAULT_DATABASE_URL', 'postgresql://synthetic/unused');

    environment.set('SULLA_VAULT_MODE', 'desktop');
    expect(loadConfig().mode).toBe('desktop');

    environment.set('SULLA_VAULT_MODE', undefined);
    expect(loadConfig().mode).toBe('desktop');
  });

  it('never exposes hosted registration, bootstrap, org or console routes', async() => { // risk: unauthenticated account/org creation on the local vault
    server = new DesktopVaultServer();
    await server.start();

    for (const [method, path, body] of [
      ['POST', '/v1/accounts', { email: 'x@example.test', loginHash: 'h', orgId: '00000000-0000-4000-8000-000000000000', joinHash: 'j' }],
      ['POST', '/v1/session', { loginHash: 'h' }],
      ['POST', '/v1/server/bootstrap', { email: 'x@example.test' }],
      ['GET', '/v1/orgs', undefined],
      ['GET', '/v1/accounts/onboarding', undefined],
    ] as const) {
      const result = await server.request(method, path, body);
      expect({ path, status: result.status, json: result.json })
        .toEqual({ path, status: 404, json: { error: 'not_found', message: 'This API is unavailable in local vault mode' } });
    }
    for (const path of ['/', '/ui/', '/ui/vault/', '/console']) {
      expect({ path, status: (await server.request('GET', path)).status }).toEqual({ path, status: 404 });
    }
  });

  it('still reports a healthy desktop vault', async() => { // risk: Desktop health check reports the wrong mode
    server = new DesktopVaultServer();
    await server.start();

    await expect(server.request('GET', '/healthz')).resolves.toEqual({ status: 200, json: { ok: true, mode: 'desktop' } });
  });

  it('keeps the Desktop broker on the local vault authority even if server mode leaks into the environment', () => { // risk: credentials routed away from the local vault
    environment.set('SULLA_VAULT_MODE', 'server');

    expect(usesContainerVaultAuthority()).toBe(true);
  });
});
