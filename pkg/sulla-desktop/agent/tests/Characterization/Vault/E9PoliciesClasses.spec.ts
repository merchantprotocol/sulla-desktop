// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

// E9 policies: the new policy classes used directly (constructor-injected collaborators), compared
// with the verbatim pre-refactor modules, plus the integration_definitions repository on PGlite.
// risk: authorization / credential exfiltration / data loss — see the per-test notes.

import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { VaultItemPlaintext } from '@sulla/vault-crypto';
import type { BrokerExecuteRequest, BrokerInjection } from '../../../../../../services/sulla-vault/src/contracts';
import type { Database } from '../../../../../../services/sulla-vault/src/db';
import { CatalogPolicy } from '../../../../../../services/sulla-vault/src/catalogPolicy';
import { EnterpriseGatewayPolicy } from '../../../../../../services/sulla-vault/src/gatewayPolicy';
import { MemorySyncKeyWrap } from '../../../../../../services/sulla-vault/src/memorySyncKeyWrap';
import { OAuthPolicy, OAuthRegistrationPolicy } from '../../../../../../services/sulla-vault/src/oauthPolicy';
import { BROKER_OPERATION_POLICIES, OperationPolicy, TrustedIntegrationOrigins } from '../../../../../../services/sulla-vault/src/operationPolicy';
import {
  PostgresIntegrationDefinitionRepository,
  type IntegrationDefinitionLookup,
  type StoredIntegrationFiles,
} from '../../../../../../services/sulla-vault/src/repositories/PostgresIntegrationDefinitionRepository';
import * as legacyCatalog from '../../Support/E9Legacy/catalogPolicy.legacy';
import * as legacyOAuth from '../../Support/E9Legacy/oauthPolicy.legacy';
import * as legacyOperation from '../../Support/E9Legacy/operationPolicy.legacy';

class InMemoryDefinitions implements IntegrationDefinitionLookup {
  readonly lookups: string[] = [];

  constructor(private readonly rows: Readonly<Record<string, unknown>>) {}

  async findFilesBySlug(slug: string): Promise<StoredIntegrationFiles | undefined> {
    this.lookups.push(slug);
    return Object.prototype.hasOwnProperty.call(this.rows, slug) ? this.rows[slug] as StoredIntegrationFiles : undefined;
  }
}

/** pg-pool shaped adapter over PGlite (same shape the VaultPostgresRepositories spec uses). */
class EmbeddedDatabase {
  constructor(private readonly db: PGlite) {}

  async query<T>(sql: string, values?: unknown[]) {
    const r = await this.db.query<T>(sql, values) as { rows: T[]; affectedRows?: number };
    return { rows: r.rows, rowCount: r.rows.length > 0 ? r.rows.length : r.affectedRows ?? 0 };
  }

  asDatabase(): Database {
    return this as unknown as Database;
  }
}

const outcome = async(run: () => unknown): Promise<string> => {
  try {
    const value = await run();
    return `ok:${ value === undefined ? 'void' : JSON.stringify(value) }`;
  } catch (error) {
    const e = error as Error & { code?: unknown };
    return e instanceof TypeError && e.code ? `throw:TypeError:${ String(e.code) }` : `throw:${ e.constructor.name }:${ e.message }`;
  }
};
const request = (operation: string, ref: BrokerExecuteRequest['ref'], url: string, method: string, injections: BrokerInjection[], body?: unknown): BrokerExecuteRequest =>
  ({ claims: { sub: 'u', agent_id: 'a', pod_id: 'p' }, operation, ref, url, method, injections, ...(body === undefined ? {} : { body }) });
const bearer = (field: string): BrokerInjection => ({ field, target: 'header', name: 'authorization', scheme: 'Bearer' });

const definitions: Record<string, unknown> = {
  stripe: {
    'stripe.v1-auth.yaml': 'api:\n  base_url: https://api.stripe.com/v1\nauth:\n  type: bearer\n',
    'endpoints/get.yml': 'endpoint:\n  path: /v1/customers/{id}\n  method: GET\n',
    'endpoints/public.yaml': { content: 'endpoint:\n  path: /v1/public\n  method: GET\n  auth: none\n' },
  },
  acme: { 'acme.v1-auth.yaml': 'auth:\n  token_url: https://login.acme.test/oauth/token\n  revoke_url: https://login.acme.test/oauth/revoke\n' },
  // A manifest endpoint carrying a query string must be refused even when the caller repeats it exactly.
  acme7: { 'acme7.v1-auth.yaml': 'auth:\n  token_url: https://acme7.test/token?tenant=x\n  revoke_url: https://u:p@acme7.test/revoke\n' },
  'mcp-tools': { 'm.v1-auth.yaml': 'api:\n  base_url: https://mcp.tools.test/mcp\n', 'e.yaml': 'endpoint:\n  path: /mcp\n  method: POST\n  auth: none\n' },
};

describe('E9 policies: OperationPolicy and TrustedIntegrationOrigins classes', () => {
  it('decides with the injected policy table instead of the global one', () => { // risk: authorization
    const injection: BrokerInjection = { field: 'api_key', target: 'header', name: 'x-api-key', scheme: 'raw' };
    const table = { 'demo.op': { integrations: ['demo'], hosts: ['api.demo.test'], methods: ['GET'], injections: [injection] } };
    const policy = new OperationPolicy(table);
    const input = request('demo.op', { integrationId: 'demo' }, 'https://api.demo.test/x', 'GET', [injection]);
    const sites = { mode: 'agents', level: 'full', agents: [], sites: [], expiresAt: null, askFirst: false, allowServerAgents: false } as never;
    expect(policy.validate(input, 'api.demo.test', sites)).toBe(table['demo.op']);
    expect(() => new OperationPolicy().validate(input, 'api.demo.test', sites)).toThrow('unknown_operation');
    expect(() => policy.validate({ ...input, injections: [bearer('api_key')] }, 'api.demo.test', sites)).toThrow('injection_denied');
  });

  it('the default instance matches the legacy module for helpers and the table', () => {
    const policy = new OperationPolicy();
    expect(BROKER_OPERATION_POLICIES).toEqual(legacyOperation.BROKER_OPERATION_POLICIES);
    for (const operation of [...Object.keys(legacyOperation.BROKER_OPERATION_POLICIES), 'nope']) {
      expect(policy.transferLimits(operation)).toEqual(legacyOperation.brokerTransferLimits(operation));
    }
  });

  it('returns trusted origins from the injected map as fresh copies', () => {
    const origins = new TrustedIntegrationOrigins({ demo: ['a.test'] });
    const copy = origins.originsFor('demo');
    copy.push('evil.test');
    expect(origins.originsFor('demo')).toEqual(['a.test']);
    expect(origins.originsFor('github')).toEqual([]);
    expect(new TrustedIntegrationOrigins().originsFor('github')).toEqual(legacyOperation.trustedOriginsForIntegration('github'));
  });
});

describe('E9 policies: CatalogPolicy and OAuthPolicy over an injected definition lookup', () => {
  it('CatalogPolicy matches the legacy module and looks up exactly the same slug', async() => { // risk: credential exfiltration
    const cases: [string, BrokerExecuteRequest['ref'], string, string, BrokerInjection[]][] = [
      ['catalog.http', { integrationId: 'stripe' }, 'https://api.stripe.com/v1/customers/c1', 'GET', [bearer('bearer_token')]],
      ['catalog.http', { integrationId: 'stripe' }, 'https://api.stripe.com/v1/public', 'GET', []],
      ['catalog.http', { integrationId: 'stripe' }, 'https://api.stripe.com/v1/customers/c1', 'GET', []],
      ['catalog.http', { integrationId: 'stripe' }, 'https://evil.example/v1/public', 'GET', []],
      ['catalog.http', { integrationId: 'nope' }, 'https://api.stripe.com/v1/public', 'GET', []],
      ['catalog.http', { integrationId: 'google_drive' }, 'https://www.googleapis.com/drive/v3/files', 'GET', [bearer('access_token')]],
      ['mcp.http', { accountId: 'Tools' }, 'https://mcp.tools.test/mcp', 'POST', []],
      ['mcp.http', { accountId: 'Tools' }, 'https://mcp.tools.test/mcp', 'POST', [bearer('auth_token')]],
      ['mcp.http', { accountId: 'Tools' }, 'https://mcp.tools.test/other', 'POST', []],
    ];
    for (const [operation, ref, url, method, injections] of cases) {
      const input = request(operation, ref, url, method, injections);
      const lookup = new InMemoryDefinitions(definitions);
      const legacyDb = new InMemoryDefinitions(definitions);
      const db = { query: async(_sql: string, params: unknown[]) => { const files = await legacyDb.findFilesBySlug(String(params[0])); return { rows: files === undefined ? [] : [{ files }] }; } };
      const after = await outcome(() => new CatalogPolicy(lookup).validate(input, new URL(url)));
      const before = await outcome(() => legacyCatalog.validateCatalogRequest(db as unknown as Database, input, new URL(url)));
      expect(after, JSON.stringify([operation, ref, url, injections])).toBe(before);
      expect(lookup.lookups).toEqual(legacyDb.lookups);
    }
  });

  it('OAuthPolicy refuses manifest endpoints with a query or credentials, like the legacy module', async() => { // risk: credential exfiltration
    const plain = { integration: { properties: {} } } as unknown as VaultItemPlaintext;
    const cases: [string, string, string][] = [
      ['oauth.refresh', 'acme7', 'https://acme7.test/token?tenant=x'],
      ['oauth.revoke', 'acme7', 'https://u:p@acme7.test/revoke'],
      ['oauth.revoke', 'acme7', 'https://acme7.test/revoke'],
      ['oauth.refresh', 'acme', 'https://login.acme.test/oauth/token'],
      ['oauth.revoke', 'acme', 'https://login.acme.test/oauth/revoke'],
      ['oauth.register', 'acme', 'https://login.acme.test/oauth/token'],
      ['oauth.refresh', 'gmail', 'https://oauth2.googleapis.com/token'],
      ['oauth.exchange', 'nope', 'https://oauth2.googleapis.com/token'],
    ];
    for (const [operation, integrationId, url] of cases) {
      const input = request(operation, { integrationId }, url, 'POST', []);
      const lookup = new InMemoryDefinitions(definitions);
      const legacyDb = new InMemoryDefinitions(definitions);
      const db = { query: async(_sql: string, params: unknown[]) => { const files = await legacyDb.findFilesBySlug(String(params[0])); return { rows: files === undefined ? [] : [{ files }] }; } };
      const after = await outcome(() => new OAuthPolicy(lookup).validateDestination(input, plain));
      const before = await outcome(() => legacyOAuth.validateOAuthDestination(db as unknown as Database, input, plain));
      expect(after, JSON.stringify([operation, integrationId, url])).toBe(before);
      expect(lookup.lookups).toEqual(legacyDb.lookups);
    }
    await expect(new OAuthPolicy(new InMemoryDefinitions(definitions)).validateDestination(request('oauth.refresh', { integrationId: 'acme7' }, 'https://acme7.test/token?tenant=x', 'POST', []), plain)).rejects.toThrow('destination_denied');
  });

  it('OAuthPolicy runs the injected registration policy for oauth.register only', async() => {
    const seen: unknown[] = [];
    class RecordingRegistration extends OAuthRegistrationPolicy {
      override validate(body: unknown): void { seen.push(body); }
    }
    const policy = new OAuthPolicy(new InMemoryDefinitions({}), new RecordingRegistration());
    const plain = { integration: { properties: {} } } as unknown as VaultItemPlaintext;
    await policy.validateDestination(request('oauth.register', { integrationId: 'robinhood' }, 'https://agent.robinhood.com/oauth/trading/register', 'POST', [], { any: 1 }), plain);
    await policy.validateDestination(request('oauth.refresh', { integrationId: 'robinhood' }, 'https://api.robinhood.com/oauth2/token/', 'POST', [], { other: 2 }), plain);
    expect(seen).toEqual([{ any: 1 }]);
    expect(OAuthPolicy.isNativeIntegration('quickbooks')).toBe(true);
    expect(OAuthPolicy.isNativeIntegration('toString')).toBe(false);
  });
});

describe('E9 policies: EnterpriseGatewayPolicy and MemorySyncKeyWrap classes', () => {
  it('EnterpriseGatewayPolicy allows only session create/delete on the configured origin', () => { // risk: authorization
    const policy = new EnterpriseGatewayPolicy();
    const injection: BrokerInjection = { field: 'api_key', target: 'header', name: 'authorization', scheme: 'Bearer' };
    const create = request('enterprise.gateway.http', { integrationId: 'enterprise_gateway' }, 'https://gw.test/api/desktop/sessions', 'POST', [injection], { a: 1 });
    expect(policy.validateHttp(create, 'https://gw.test/').target.href).toBe('https://gw.test/api/desktop/sessions');
    expect(() => policy.validateHttp(create, 'https://other.test')).toThrow('destination_denied');
    expect(() => policy.validateHttp({ ...create, body: undefined }, 'https://gw.test')).toThrow('request_denied');
    expect(() => policy.origin('https://gw.test/path')).toThrow('destination_denied');
  });

  it('MemorySyncKeyWrap uses its injected crypto for the nonce and reproduces the recorded blob', async() => { // risk: data loss
    const deterministic = {
      subtle: globalThis.crypto.subtle,
      getRandomValues: <T extends ArrayBufferView | null>(array: T): T => {
        const view = array as unknown as Uint8Array;
        for (let i = 0; i < view.length; i++) view[i] = (0xa0 + i) & 0xff;
        return array;
      },
    } as unknown as ConstructorParameters<typeof MemorySyncKeyWrap>[0];
    const wrap = new MemorySyncKeyWrap(deterministic);
    const userKey = Uint8Array.from({ length: 32 }, (_, i) => i);
    const memoryKey = Uint8Array.from({ length: 32 }, (_, i) => 255 - i);
    const blob = await wrap.wrap(userKey, 'user-1', memoryKey);
    expect(blob).toBe('oKGio6SlpqeoqaqrGeaB0b4x+0eVk3In9IgxLp9CtPx5XauEe+jDYpxJlOH6RrlOTkLDNIHoGiqFklkR');
    expect(Buffer.from(await new MemorySyncKeyWrap().unwrap(userKey, 'user-1', blob))).toEqual(Buffer.from(memoryKey));
    await expect(new MemorySyncKeyWrap().unwrap(userKey, 'user-2', blob)).rejects.toThrow('memory_key_unwrap_failed');
  });
});

describe('E9 policies: PostgresIntegrationDefinitionRepository on PGlite', () => {
  const pglite = new PGlite();
  const database = new EmbeddedDatabase(pglite);

  beforeAll(async() => {
    await pglite.exec('CREATE TABLE integration_definitions (slug text PRIMARY KEY, files jsonb NOT NULL)');
    for (const [slug, files] of Object.entries(definitions)) {
      await pglite.query('INSERT INTO integration_definitions (slug, files) VALUES ($1, $2)', [slug, JSON.stringify(files)]);
    }
  });
  afterAll(() => pglite.close());

  it('returns the stored files for a slug and undefined for a missing one', async() => { // risk: data accuracy
    const repository = new PostgresIntegrationDefinitionRepository(database.asDatabase());
    await expect(repository.findFilesBySlug('stripe')).resolves.toEqual(definitions.stripe);
    await expect(repository.findFilesBySlug('missing')).resolves.toBeUndefined();
    await expect(repository.findFilesBySlug("stripe' OR '1'='1")).resolves.toBeUndefined();
  });

  it('drives the deprecated aliases and the legacy modules to the same decisions on a real table', async() => { // risk: authorization
    const { validateCatalogRequest } = await import('../../../../../../services/sulla-vault/src/catalogPolicy');
    const { validateOAuthDestination } = await import('../../../../../../services/sulla-vault/src/oauthPolicy');
    const db = database.asDatabase();
    const plain = { integration: { properties: {} } } as unknown as VaultItemPlaintext;
    const catalog = request('catalog.http', { integrationId: 'stripe' }, 'https://api.stripe.com/v1/public', 'GET', []);
    expect(await outcome(() => validateCatalogRequest(db, catalog, new URL(catalog.url))))
      .toBe(await outcome(() => legacyCatalog.validateCatalogRequest(db, catalog, new URL(catalog.url))));
    expect(await outcome(() => validateCatalogRequest(db, catalog, new URL(catalog.url)))).toBe('ok:{"credentialFree":true}');
    const oauth = request('oauth.revoke', { integrationId: 'acme' }, 'https://login.acme.test/oauth/revoke', 'POST', []);
    expect(await outcome(() => validateOAuthDestination(db, oauth, plain))).toBe(await outcome(() => legacyOAuth.validateOAuthDestination(db, oauth, plain)));
    expect(await outcome(() => validateOAuthDestination(db, oauth, plain))).toBe('ok:void');
  });
});
