// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import http from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import { createApp } from '../../../../../../services/sulla-vault/src/app';

import type { VaultConfig } from '../../../../../../services/sulla-vault/src/config';
import type { Database } from '../../../../../../services/sulla-vault/src/db';
import { LocalVaultError } from '../../../../../../services/sulla-vault/src/localAuthority';
import type { LocalVaultAuthority } from '../../../../../../services/sulla-vault/src/localAuthority';

class EnrollmentRouteFixture {
  private server: http.Server | null = null;
  readonly commitCalls: unknown[] = [];
  readonly approvalServiceId = 'sulla-desktop-approval';
  readonly approvalServiceToken = 'approval_' + 'c'.repeat(64);

  async start(): Promise<string> {
    const database = { query: async() => ({ rows: [], rowCount: 0 }) } as unknown as Database;
    const authority = {
      commitVaultEnrollment: async(...args: unknown[]) => {
        if (args[0] !== this.approvalServiceId || args[1] !== this.approvalServiceToken) {
          throw new LocalVaultError('invalid_service_identity', 401, 'Desktop service identity is invalid');
        }
        this.commitCalls.push(args);
        return { committed: true };
      },
    } as unknown as LocalVaultAuthority;
    const config: VaultConfig = {
      mode: 'desktop',
      port: 0,
      databaseUrl: 'postgresql://synthetic/unused',
      jwtSecret: 'j'.repeat(64),
      extensionOrigins: [],
      bootstrapServiceId: 'sulla-desktop-bootstrap',
      bootstrapServiceToken: 'bootstrap_' + 'a'.repeat(64),
      controlServiceId: 'sulla-desktop-control',
      controlServiceToken: 'control_' + 'b'.repeat(64),
      approvalServiceId: this.approvalServiceId,
      approvalServiceToken: this.approvalServiceToken,
      brokerServiceId: 'sulla-tools',
      brokerServiceToken: 'broker_' + 'd'.repeat(64),
      filesServiceId: 'sulla-files',
      filesServiceToken: 'files_' + 'e'.repeat(64),
    };
    this.server = http.createServer(createApp(database, config, { localAuthority: authority }));
    await new Promise<void>(resolve => this.server!.listen(0, '127.0.0.1', resolve));
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');
    return `http://127.0.0.1:${ address.port }`;
  }

  async request(baseUrl: string, headers: Record<string, string>): Promise<{ status: number; body: unknown }> {
    const url = new URL('/v1/broker/sulla-cloud/enrollment-commit', baseUrl);
    return await new Promise((resolve, reject) => {
      const request = http.request(url, { method: 'POST', headers }, response => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { body += chunk; });
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body: JSON.parse(body) }));
      });
      request.on('error', reject);
      request.end('{}');
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve, reject) => this.server!.close(error => error ? reject(error) : resolve()));
    this.server = null;
  }
}

describe('Vault enrollment routes', () => {
  let fixture: EnrollmentRouteFixture | undefined;
  afterEach(async() => fixture?.stop());

  it('rejects unauthenticated enrollment commits with 401', async() => {
    // risk: unauthenticated enrollment requests must not reach vault mutation logic
    fixture = new EnrollmentRouteFixture();
    const baseUrl = await fixture.start();

    const response = await fixture.request(baseUrl, { 'content-type': 'application/json' });

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ error: 'invalid_service_identity' });
    expect(fixture.commitCalls).toEqual([]);
  });

  it('rejects an authenticated empty enrollment commit body with 400', async() => {
    // risk: malformed enrollment input must not become an internal error or mutate encrypted state
    fixture = new EnrollmentRouteFixture();
    const baseUrl = await fixture.start();

    const response = await fixture.request(baseUrl, {
      'authorization': `Bearer ${ fixture.approvalServiceToken }`,
      'content-type': 'application/json',
      'x-sulla-service-id': fixture.approvalServiceId,
    });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'requestId is required' });
    expect(fixture.commitCalls).toEqual([]);
  });
});
