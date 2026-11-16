// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// E10 S3: every sulla-vault service-identity route accepts only "Bearer <token>". On 22f0e63 the
// optional prefix strip let a bare token through, so the bare-token cases below fail on main.
// Synthetic tokens only.

import type { Request } from 'express';
import { describe, expect, it } from 'vitest';

import { createApp } from '../../../../../../services/sulla-vault/src/app';
import { VaultRequestInput } from '../../../../../../services/sulla-vault/src/http/VaultRequestInput';
import type { LocalAuthorityHost } from '../../../../../../services/sulla-vault/src/localAuthority/LocalAuthorityHost';
import { ServiceIdentityGuard } from '../../../../../../services/sulla-vault/src/localAuthority/ServiceIdentityGuard';
import {
  AuthorityDouble, DatabaseDouble, VaultAppConfigFactory, VaultAppProbe, type HttpOutcome,
} from '../../Support/Vault/E9VaultAppHarness';

const config = new VaultAppConfigFactory().create();
const CONTROL_TOKEN = config.controlServiceToken!;
const APPROVAL_TOKEN = config.approvalServiceToken!;
const BROKER_TOKEN = config.brokerServiceToken!;

class HeaderRequest {
  static of(headers: Record<string, string | undefined>): Request {
    const lower = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
    return { header: (name: string) => lower[name.toLowerCase()] } as unknown as Request;
  }
}

describe('VaultRequestInput.serviceIdentity requires the Bearer scheme', () => {
  const input = new VaultRequestInput(config);
  const tokenFor = (authorization: string | undefined) =>
    input.serviceIdentity(HeaderRequest.of({ 'x-sulla-service-id': 'sulla-tools', authorization })).token;

  it('yields the token for "Bearer <token>", scheme case-insensitive', () => { // risk: every service caller keeps working
    expect(tokenFor(`Bearer ${ BROKER_TOKEN }`)).toBe(BROKER_TOKEN);
    expect(tokenFor(`bearer ${ BROKER_TOKEN }`)).toBe(BROKER_TOKEN);
    expect(tokenFor(`BEARER  ${ BROKER_TOKEN }`)).toBe(BROKER_TOKEN);
  });

  it('yields no token for a bare token', () => { // risk: authentication — scheme-less credential accepted (fails on main)
    expect(tokenFor(BROKER_TOKEN)).toBeUndefined();
  });

  it('yields no token for empty, whitespace, a lone scheme, or a different scheme', () => { // risk: authentication bypass via malformed header
    for (const value of [undefined, '', '   ', 'Bearer', 'Bearer ', 'Bearer    ', `Basic ${ BROKER_TOKEN }`, `Bearer:${ BROKER_TOKEN }`, `Bearer${ BROKER_TOKEN }`, `Bearer ${ BROKER_TOKEN } extra`]) {
      expect(tokenFor(value), JSON.stringify(value)).toBeUndefined();
    }
  });

  it('keeps the service id header unchanged', () => { // risk: identity confusion between services
    expect(input.serviceIdentity(HeaderRequest.of({ 'x-sulla-service-id': 'sulla-files', authorization: 'Bearer t' })).serviceId).toBe('sulla-files');
    expect(input.serviceIdentity(HeaderRequest.of({})).serviceId).toBe('');
  });
});

/** Runs the real vault app with the real ServiceIdentityGuard deciding every service identity. */
class GuardedVaultApp {
  private readonly probe = new VaultAppProbe();

  async send(method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<HttpOutcome> {
    const authority = new AuthorityDouble();
    const host = { config, requireDesktopIdentity: (id: string, token?: string) => guard.requireDesktopIdentity(id, token) } as unknown as LocalAuthorityHost;
    const guard = new ServiceIdentityGuard(host);
    authority
      .on('requireControlIdentity', (id, token) => guard.requireControlIdentity(id, token))
      .on('requireApprovalIdentity', (id, token) => guard.requireApprovalIdentity(id, token))
      .on('brokerStatus', (id, token) => { guard.requireBrokerIdentity(id, token); return { ok: true } })
      .on('status', () => ({ state: 'unlocked', unlocked: true }))
      .on('backupCredentials', () => ({ ok: true }));
    const app = createApp(new DatabaseDouble().db, config, { localAuthority: authority.authority });
    return this.probe.send(app, { method, path, headers, body });
  }
}

describe('service-identity routes refuse a bare token over HTTP', () => {
  const app = new GuardedVaultApp();
  const routes = [
    { name: 'control GET /v1/desktop/status', method: 'GET', path: '/v1/desktop/status', serviceId: config.controlServiceId!, token: CONTROL_TOKEN },
    { name: 'broker GET /v1/broker/status', method: 'GET', path: '/v1/broker/status', serviceId: config.brokerServiceId!, token: BROKER_TOKEN },
    { name: 'approval POST /v1/desktop/backup-credentials', method: 'POST', path: '/v1/desktop/backup-credentials', serviceId: config.approvalServiceId!, token: APPROVAL_TOKEN, body: { itemId: 'item-1', target: 'nas-1' } },
  ];

  for (const route of routes) {
    it(`${ route.name }: Bearer token is accepted`, async() => { // risk: legitimate Desktop/broker callers locked out
      const outcome = await app.send(route.method, route.path, { 'x-sulla-service-id': route.serviceId, authorization: `Bearer ${ route.token }` }, route.body);
      expect(outcome.status).toBe(200);
    });

    it(`${ route.name }: bare correct token is 401`, async() => { // risk: authentication — fails on main (bare token accepted)
      const outcome = await app.send(route.method, route.path, { 'x-sulla-service-id': route.serviceId, authorization: route.token }, route.body);
      expect(outcome.status).toBe(401);
    });

    it(`${ route.name }: empty, whitespace-only and lone "Bearer" are 401`, async() => { // risk: authentication bypass via malformed header
      for (const authorization of ['', 'Bearer', 'Bearer   ']) {
        const outcome = await app.send(route.method, route.path, { 'x-sulla-service-id': route.serviceId, authorization }, route.body);
        expect(outcome.status, JSON.stringify(authorization)).toBe(401);
      }
    });

    it(`${ route.name }: wrong Bearer token is 401`, async() => { // risk: authentication — any token accepted
      const outcome = await app.send(route.method, route.path, { 'x-sulla-service-id': route.serviceId, authorization: `Bearer wrong_${ 'f'.repeat(64) }` }, route.body);
      expect(outcome.status).toBe(401);
    });
  }
});
