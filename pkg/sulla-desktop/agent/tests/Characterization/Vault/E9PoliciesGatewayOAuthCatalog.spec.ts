// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

// E9 policies: decision-table equivalence for gatewayPolicy.ts, oauthPolicy.ts and catalogPolicy.ts
// between the verbatim pre-refactor copies (Support/E9Legacy) and the live module paths.
// risk: authorization / credential exfiltration — a credential must only ever be injected toward
// the exact provider-owned destination the policy allowed before the OOP move.

import { describe, expect, it } from 'vitest';

import type { VaultItemPlaintext } from '@sulla/vault-crypto';
import type { BrokerExecuteRequest, BrokerInjection } from '../../../../../../services/sulla-vault/src/contracts';
import type { Database } from '../../../../../../services/sulla-vault/src/db';
import * as liveCatalog from '../../../../../../services/sulla-vault/src/catalogPolicy';
import * as liveGateway from '../../../../../../services/sulla-vault/src/gatewayPolicy';
import * as liveOAuth from '../../../../../../services/sulla-vault/src/oauthPolicy';
import * as legacyCatalog from '../../Support/E9Legacy/catalogPolicy.legacy';
import * as legacyGateway from '../../Support/E9Legacy/gatewayPolicy.legacy';
import * as legacyOAuth from '../../Support/E9Legacy/oauthPolicy.legacy';

type Files = unknown;

class Outcome {
  static sync(run: () => unknown): string {
    try {
      return `ok:${ Outcome.render(run()) }`;
    } catch (error) {
      return Outcome.error(error);
    }
  }

  static async async(run: () => Promise<unknown>): Promise<string> {
    try {
      return `ok:${ Outcome.render(await run()) }`;
    } catch (error) {
      return Outcome.error(error);
    }
  }

  private static render(value: unknown): string {
    return value instanceof URL ? `URL(${ value.href })` : value === undefined ? 'void' : JSON.stringify(value, (_key, v) => v instanceof URL ? `URL(${ v.href })` : v);
  }

  private static error(error: unknown): string {
    const e = error as Error & { code?: unknown };
    // Invalid-URL TypeErrors are compared by class and code (the message embeds engine detail).
    return e instanceof TypeError && e.code ? `throw:TypeError:${ String(e.code) }` : `throw:${ e.constructor.name }:${ e.message }`;
  }
}

/** Stands in for the vault pg pool: serves integration_definitions rows and records every query. */
class RecordingDatabase {
  readonly calls: string[] = [];

  constructor(private readonly definitions: Readonly<Record<string, Files>>) {}

  async query(sql: string, params: unknown[]): Promise<{ rows: { files: Files }[]; rowCount: number }> {
    this.calls.push(JSON.stringify([sql, params]));
    const slug = String(params[0]);
    if (!Object.prototype.hasOwnProperty.call(this.definitions, slug)) return { rows: [], rowCount: 0 };
    return { rows: [{ files: this.definitions[slug] }], rowCount: 1 };
  }

  asDatabase(): Database {
    return this as unknown as Database;
  }
}

class Requests {
  static build(operation: string, ref: BrokerExecuteRequest['ref'], url: string, method: string,
    injections: BrokerInjection[], body?: unknown): BrokerExecuteRequest {
    return { claims: { sub: 'u', agent_id: 'a', pod_id: 'p' }, operation, ref, url, method, injections, ...(body === undefined ? {} : { body }) };
  }
}

const bearer = (field: string): BrokerInjection => ({ field, target: 'header', name: 'authorization', scheme: 'Bearer' });

describe('E9 policies: gatewayPolicy (legacy == live)', () => {
  const raws = ['https://gw.example.com', 'https://gw.example.com/', 'https://gw.example.com:8443', 'http://gw.example.com',
    'https://gw.example.com/path', 'https://u:p@gw.example.com', 'https://gw.example.com?x=1', 'https://gw.example.com#h',
    'https://GW.EXAMPLE.COM', 'not a url', '', 'https://gw.example.com/?'];

  it('enterpriseGatewayOrigin accepts and rejects the same gateway URLs', () => {
    for (const raw of raws) {
      expect(Outcome.sync(() => liveGateway.enterpriseGatewayOrigin(raw)), raw).toBe(Outcome.sync(() => legacyGateway.enterpriseGatewayOrigin(raw)));
    }
    expect(liveGateway.enterpriseGatewayOrigin('https://gw.example.com/').href).toBe('https://gw.example.com/');
    expect(() => liveGateway.enterpriseGatewayOrigin('https://gw.example.com/path')).toThrow('destination_denied');
  });

  it('keeps the gateway injection constant', () => {
    expect(liveGateway.ENTERPRISE_GATEWAY_INJECTION).toEqual(legacyGateway.ENTERPRISE_GATEWAY_INJECTION);
    expect(liveGateway.ENTERPRISE_GATEWAY_INJECTION).toEqual({ field: 'api_key', target: 'header', name: 'authorization', scheme: 'Bearer' });
  });

  it('validateEnterpriseGatewayHttp decides identically across the full request matrix', () => {
    const targets = ['https://gw.example.com/api/desktop/sessions', 'https://gw.example.com/api/desktop/sessions/abc_1-2',
      'https://gw.example.com/api/desktop/sessions/a%2Fb', 'https://gw.example.com/api/desktop/sessions/a.b',
      `https://gw.example.com/api/desktop/sessions/${ 'a'.repeat(129) }`, `https://gw.example.com/api/desktop/sessions/${ 'a'.repeat(128) }`,
      'https://gw.example.com/api/desktop/sessions/', 'https://gw.example.com/api/desktop/other', 'https://evil.example/api/desktop/sessions',
      'http://gw.example.com/api/desktop/sessions', 'https://gw.example.com/api/desktop/sessions?x=1', 'https://u:p@gw.example.com/api/desktop/sessions',
      'https://gw.example.com/api/desktop/sessions#f', 'https://gw.example.com/api/desktop/sessions/%E0%A4%A', 'garbage'];
    const injections: BrokerInjection[][] = [[liveGateway.ENTERPRISE_GATEWAY_INJECTION], [], [{ ...bearer('api_key'), name: 'Authorization' }],
      [bearer('api_token')], [{ field: 'api_key', target: 'header', name: 'authorization' }], [liveGateway.ENTERPRISE_GATEWAY_INJECTION, liveGateway.ENTERPRISE_GATEWAY_INJECTION]];
    const bodies: unknown[] = [undefined, null, { a: 1 }, [], 'text', { big: 'x'.repeat(64 * 1024) }, { ok: 'x'.repeat(64 * 1024 - 20) }];
    const mismatches: string[] = [];
    let allowed = 0;
    for (const operation of ['enterprise.gateway.http', 'catalog.http']) {
      for (const integrationId of ['enterprise_gateway', 'other', undefined]) {
        for (const configured of ['https://gw.example.com', 'https://gw.example.com/', 'https://gw.example.com/x', 'http://gw.example.com']) {
          for (const url of targets) {
            for (const method of ['POST', 'DELETE', 'delete', 'GET', 'PUT']) {
              for (const inj of injections) {
                for (const body of bodies) {
                  const input = Requests.build(operation, integrationId === undefined ? {} : { integrationId }, url, method, inj, body);
                  const before = Outcome.sync(() => legacyGateway.validateEnterpriseGatewayHttp(input, configured));
                  const after = Outcome.sync(() => liveGateway.validateEnterpriseGatewayHttp(input, configured));
                  if (before.startsWith('ok')) allowed++;
                  if (before !== after && mismatches.length < 20) mismatches.push(`${ JSON.stringify([operation, integrationId, configured, url, method, inj, body === undefined ? 'undef' : typeof body]) }: ${ before } vs ${ after }`);
                }
              }
            }
          }
        }
      }
    }
    expect(mismatches).toEqual([]);
    expect(allowed).toBeGreaterThan(0);
  });
});

const nativeUrls = [
  'https://dash.cloudflare.com/oauth2/token', 'https://dash.cloudflare.com/oauth2/revoke', 'https://auth.openai.com/oauth/token',
  'https://oauth2.googleapis.com/token', 'https://oauth2.googleapis.com/revoke', 'https://auth.x.ai/oauth2/token', 'https://auth.x.ai/oauth2/revoke',
  'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke',
  'https://api.robinhood.com/oauth2/token/', 'https://agent.robinhood.com/oauth/trading/register',
];
const oauthDefinitions: Record<string, Files> = {
  acme: { 'acme.v1-auth.yaml': 'auth:\n  token_url: https://login.acme.test/oauth/token\n  revoke_url: https://login.acme.test/oauth/revoke\n' },
  acme2: { 'acme2.v2-auth.yml': { content: 'auth:\n  token_url: https://id.acme2.test/token\n  revocation_url: https://id.acme2.test/revocation\n' } },
  acme3: { 'readme.yaml': 'auth:\n  token_url: https://nope.test/token\n', 'acme3.v1-auth.yaml': 'auth:\n  type: oauth2\n' },
  acme4: { 'acme4.v1-auth.yaml': { content: 7 }, 'acme4.v9-AUTH.YAML': 'auth:\n  token_url: https://acme4.test/t\n' },
  acme5: { 'acme5.v1-auth.yaml': 'auth: [unclosed' },
  acme6: { 'acme6.v1-auth.yaml': 'auth:\n  token_url: http://insecure.acme6.test/token\n' },
  gmail: { 'gmail.v1-auth.yaml': 'auth:\n  token_url: https://manifest-should-not-win.test/token\n' },
  empty: {},
};

describe('E9 policies: oauthPolicy (legacy == live)', () => {
  const ids = ['gmail', 'google_drive', 'cloudflare', 'codex', 'grok', 'openai', 'robinhood', 'quickbooks', 'google', 'intuit',
    'acme', 'acme2', 'acme3', 'acme4', 'acme5', 'acme6', 'empty', 'missing', '', 'constructor', '__proto__', 'toString', 'hasOwnProperty'];

  it('isNativeOAuthIntegration answers the same for every id', () => {
    for (const id of ids) expect(liveOAuth.isNativeOAuthIntegration(id), id).toBe(legacyOAuth.isNativeOAuthIntegration(id));
    expect(liveOAuth.isNativeOAuthIntegration('quickbooks')).toBe(true);
    expect(liveOAuth.isNativeOAuthIntegration('constructor')).toBe(false);
  });

  it('keeps the native endpoint table exposed to tests', () => {
    expect(liveOAuth.oauthPolicyTestHooks.NATIVE_OAUTH_ENDPOINTS).toEqual(legacyOAuth.oauthPolicyTestHooks.NATIVE_OAUTH_ENDPOINTS);
  });

  const validRegistration = () => ({ client_name: 'Sulla', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
    token_endpoint_auth_method: 'none', redirect_uris: ['http://127.0.0.1:43123/callback'] });
  const registrationBodies: unknown[] = [
    validRegistration(), undefined, null, [], 'x', 5,
    { ...validRegistration(), extra: 1 }, { ...validRegistration(), client_name: '' }, { ...validRegistration(), client_name: 'x'.repeat(128) },
    { ...validRegistration(), client_name: 'x'.repeat(129) }, { ...validRegistration(), client_name: 5 },
    { ...validRegistration(), token_endpoint_auth_method: 'client_secret_basic' }, { ...validRegistration(), grant_types: [] },
    { ...validRegistration(), grant_types: ['authorization_code'] }, { ...validRegistration(), grant_types: ['authorization_code', 'refresh_token', 'refresh_token'] },
    { ...validRegistration(), grant_types: ['implicit'] }, { ...validRegistration(), grant_types: 'authorization_code' },
    { ...validRegistration(), response_types: ['token'] }, { ...validRegistration(), response_types: ['code', 'code'] },
    { ...validRegistration(), redirect_uris: [] }, { ...validRegistration(), redirect_uris: ['http://127.0.0.1:1/a', 'http://127.0.0.1:2/b'] },
    { ...validRegistration(), redirect_uris: [`http://127.0.0.1:1/${ 'a'.repeat(520) }`] }, { ...validRegistration(), redirect_uris: [5] },
    { ...validRegistration(), redirect_uris: ['https://127.0.0.1:43123/cb'] }, { ...validRegistration(), redirect_uris: ['http://localhost:43123/cb'] },
    { ...validRegistration(), redirect_uris: ['http://[::1]:43123/cb'] }, { ...validRegistration(), redirect_uris: ['http://127.0.0.1/cb'] },
    { ...validRegistration(), redirect_uris: ['http://evil.example:43123/cb'] }, { ...validRegistration(), redirect_uris: ['http://u:p@127.0.0.1:43123/cb'] },
    { ...validRegistration(), redirect_uris: ['http://127.0.0.1:43123/cb?x=1'] }, { ...validRegistration(), redirect_uris: ['http://127.0.0.1:43123/cb#f'] },
    { ...validRegistration(), redirect_uris: ['not a url'] }, { client_name: 'Sulla', token_endpoint_auth_method: 'none' },
    { ...validRegistration(), client_name: 'x'.repeat(100), grant_types: ['refresh_token'], pad: undefined },
  ];

  it('validateOAuthRegistrationRequest accepts and rejects the same metadata', () => {
    let accepted = 0;
    for (const body of registrationBodies) {
      const before = Outcome.sync(() => legacyOAuth.validateOAuthRegistrationRequest(body));
      expect(Outcome.sync(() => liveOAuth.validateOAuthRegistrationRequest(body)), JSON.stringify(body)).toBe(before);
      if (before === 'ok:void') accepted++;
    }
    expect(accepted).toBeGreaterThan(1);
    expect(() => liveOAuth.validateOAuthRegistrationRequest({ ...validRegistration(), extra: 1 })).toThrow('invalid_registration_metadata');
  });

  it('validateOAuthDestination binds every operation/provider/url combination to the same endpoint, with the same queries', async() => {
    const operations = ['oauth.exchange', 'oauth.adopt', 'oauth.refresh', 'oauth.revoke', 'oauth.register', 'oauth.other', 'catalog.http'];
    const properties: Record<string, string>[] = [{}, { provider_id: 'google' }, { provider: 'intuit' }, { provider_id: 'unknown' },
      { provider_id: 'constructor' }, { provider_id: '', provider: 'grok' }, { provider: 'acme' }];
    const urls = [...nativeUrls, 'https://login.acme.test/oauth/token', 'https://login.acme.test/oauth/revoke', 'https://id.acme2.test/token',
      'https://id.acme2.test/revocation', 'https://acme4.test/t', 'http://insecure.acme6.test/token', 'https://nope.test/token',
      'https://oauth2.googleapis.com/token?x=1', 'https://oauth2.googleapis.com/token#f', 'http://oauth2.googleapis.com/token',
      'https://u:p@oauth2.googleapis.com/token', 'https://OAUTH2.googleapis.com/token', 'https://oauth2.googleapis.com/token/',
      'https://oauth2.googleapis.com:443/token', 'https://api.robinhood.com/oauth2/token', 'not a url'];
    const mismatches: string[] = [];
    const seen = new Set<string>();
    for (const operation of operations) {
      for (const integrationId of ids) {
        for (const props of properties) {
          for (const url of urls) {
            const body = operation === 'oauth.register' ? registrationBodies[url.length % 3 === 0 ? 0 : 6] : undefined;
            const input = Requests.build(operation, { integrationId }, url, 'POST', [], body);
            const plaintext = { integration: { properties: props } } as unknown as VaultItemPlaintext;
            const legacyDb = new RecordingDatabase(oauthDefinitions);
            const liveDb = new RecordingDatabase(oauthDefinitions);
            const before = await Outcome.async(() => legacyOAuth.validateOAuthDestination(legacyDb.asDatabase(), input, plaintext));
            const after = await Outcome.async(() => liveOAuth.validateOAuthDestination(liveDb.asDatabase(), input, plaintext));
            seen.add(before);
            const label = JSON.stringify([operation, integrationId, props, url]);
            if (before !== after) mismatches.push(`${ label }: ${ before } vs ${ after }`);
            if (JSON.stringify(legacyDb.calls) !== JSON.stringify(liveDb.calls)) mismatches.push(`${ label }: queries ${ legacyDb.calls } vs ${ liveDb.calls }`);
            if (mismatches.length >= 20) break;
          }
        }
      }
    }
    expect(mismatches).toEqual([]);
    for (const expected of ['ok:void', 'throw:Error:destination_denied', 'throw:Error:invalid_registration_metadata']) expect([...seen]).toContain(expected);
  });

  it('pins the native and manifest destinations independently of the legacy copy', async() => {
    const db = new RecordingDatabase(oauthDefinitions);
    const plain = { integration: { properties: {} } } as unknown as VaultItemPlaintext;
    await expect(liveOAuth.validateOAuthDestination(db.asDatabase(), Requests.build('oauth.refresh', { integrationId: 'gmail' }, 'https://oauth2.googleapis.com/token', 'POST', []), plain)).resolves.toBeUndefined();
    expect(db.calls).toEqual([]);
    await expect(liveOAuth.validateOAuthDestination(db.asDatabase(), Requests.build('oauth.refresh', { integrationId: 'gmail' }, 'https://evil.example/token', 'POST', []), plain)).rejects.toThrow('destination_denied');
    await expect(liveOAuth.validateOAuthDestination(db.asDatabase(), Requests.build('oauth.revoke', { integrationId: 'acme' }, 'https://login.acme.test/oauth/revoke', 'POST', []), plain)).resolves.toBeUndefined();
    expect(db.calls).toEqual([JSON.stringify(['SELECT files FROM integration_definitions WHERE slug=$1 LIMIT 1', ['acme']])]);
  });
});

const catalogDefinitions: Record<string, Files> = {
  stripe: {
    'stripe.v1-auth.yaml': 'api:\n  base_url: https://api.stripe.com/v1\nauth:\n  type: bearer\n',
    'endpoints/list.yaml': 'endpoint:\n  path: /v1/customers\n  method: GET\n',
    'endpoints/get.yml': 'endpoint:\n  path: /v1/customers/{id}\n  method: get\n',
    'endpoints/public.yaml': 'endpoint:\n  path: /v1/public\n  method: GET\n  auth: none\n',
    'endpoints/optional.yaml': { content: 'endpoint:\n  path: /v1/optional.json\n  method: POST\n  auth: optional\n' },
    'notes.md': 'endpoint:\n  path: /v1/hidden\n  method: GET\n',
  },
  oauthint: { 'o.v1-auth.yaml': 'api:\n  base_url: https://api.oauth.test\nauth:\n  type: oauth2\n', 'e.yaml': 'endpoint:\n  path: /items\n  method: POST\n' },
  apikeyint: { 'k.v2-auth.yml': 'api:\n  base_url: https://api.key.test/\nauth:\n  type: apiKey\n  header: X-Api-Key\n', 'e.yaml': 'endpoint:\n  path: /items/{a}/{b}\n  method: DELETE\n' },
  apikeynoheader: { 'k.v1-auth.yaml': 'api:\n  base_url: https://api.key2.test\nauth:\n  type: apiKey\n', 'e.yaml': 'endpoint:\n  path: /items\n  method: GET\n' },
  fallback: { 'f.v1-auth.yaml': 'api:\n  base_url: https://api.fb.test\napi_key_fallback:\n  enabled: true\n  param_name: key\n', 'e.yaml': 'endpoint:\n  path: /search\n  method: GET\n' },
  noauth: { 'n.v1-auth.yaml': 'api:\n  base_url: https://api.none.test\n', 'e.yaml': 'endpoint:\n  path: /a\n  method: GET\n', 'p.yaml': 'endpoint:\n  path: /p\n  method: GET\n  auth: none\n' },
  httpbase: { 'h.v1-auth.yaml': 'api:\n  base_url: http://api.http.test\nauth:\n  type: bearer\n', 'e.yaml': 'endpoint:\n  path: /a\n  method: GET\n' },
  noauthfile: { 'e.yaml': 'endpoint:\n  path: /a\n  method: GET\n' },
  nobase: { 'x.v1-auth.yaml': 'auth:\n  type: bearer\n' },
  emptyauth: { 'x.v1-auth.yaml': '' },
  numberauth: { 'x.v1-auth.yaml': { content: 3 } },
  badyaml: { 'x.v1-auth.yaml': 'api:\n  base_url: https://api.bad.test\nauth:\n  type: bearer\n', 'e.yaml': 'endpoint: [unclosed' },
  badbase: { 'x.v1-auth.yaml': 'api:\n  base_url: not a url\n' },
  nullfiles: null,
  stringfiles: 'abc',
  google_drive: { 'g.v1-auth.yaml': 'api:\n  base_url: https://evil.example\n' },
  'mcp-my-server': {
    'm.v1-auth.yaml': 'api:\n  base_url: https://mcp.example.com/mcp/\nauth:\n  type: bearer\n',
    'e.yaml': 'endpoint:\n  path: /mcp\n  method: POST\n  auth: optional\n',
    'g.yaml': 'endpoint:\n  path: /mcp/sse\n  method: GET\n',
  },
  'mcp-plain': { 'm.v1-auth.yaml': 'api:\n  base_url: https://plain.example.com\n' },
};

describe('E9 policies: catalogPolicy (legacy == live)', () => {
  const injections: BrokerInjection[][] = [[], [bearer('access_token')], [bearer('bearer_token')], [bearer('auth_token')],
    [{ field: 'api_key', target: 'header', name: 'X-Api-Key', scheme: 'raw' }], [{ field: 'api_key', target: 'header', name: 'x-api-key' }],
    [{ field: 'api_key', target: 'query', name: 'key', scheme: 'raw' }], [{ ...bearer('access_token'), name: 'Authorization' }],
    [bearer('bearer_token'), bearer('bearer_token')], [{ ...bearer('bearer_token'), scheme: 'raw' }]];
  const methods = ['GET', 'POST', 'DELETE', 'patch', 'PUT'];
  const urlsFor: Record<string, string[]> = {
    stripe: ['https://api.stripe.com/v1/customers', 'https://api.stripe.com/v1/customers/cus_1', 'https://api.stripe.com/v1/customers/a/b',
      'https://api.stripe.com/v1/public', 'https://api.stripe.com/v1/optional.json', 'https://api.stripe.com/v1/optionalXjson',
      'https://api.stripe.com/v1/hidden', 'https://evil.example/v1/customers', 'http://api.stripe.com/v1/customers'],
    oauthint: ['https://api.oauth.test/items', 'https://api.oauth.test/other'],
    apikeyint: ['https://api.key.test/items/1/2', 'https://api.key.test/items/1'],
    apikeynoheader: ['https://api.key2.test/items'],
    fallback: ['https://api.fb.test/search', 'https://api.fb.test/search?key=x'],
    noauth: ['https://api.none.test/a', 'https://api.none.test/p'],
    google_drive: ['https://www.googleapis.com/drive/v3/files', 'https://www.googleapis.com/upload/drive/v3/files', 'https://www.googleapis.com/drive/v2/files',
      'https://evil.example/drive/v3/files', 'https://evil.example/x'],
    'mcp-my-server': ['https://mcp.example.com/mcp', 'https://mcp.example.com/mcp/sse', 'https://mcp.example.com/mcpx', 'https://mcp.example.com/other'],
    'mcp-plain': ['https://plain.example.com/', 'https://plain.example.com/anything'],
  };
  const genericUrls = ['https://api.http.test/a', 'https://api.bad.test/a', 'https://example.test/a'];
  const refs: BrokerExecuteRequest['ref'][] = [
    ...Object.keys(catalogDefinitions).map(integrationId => ({ integrationId })),
    { integrationId: 'missing' }, {}, { accountId: 'My Server!!' }, { accountId: '--MY__server--' }, { accountId: 'plain' }, { accountId: 'unknown' },
    { integrationId: 'stripe', accountId: 'My Server!!' },
  ];

  const compare = async(mismatches: string[], seen: Set<string>, operation: string, ref: BrokerExecuteRequest['ref'], url: string, method: string, inj: BrokerInjection[]) => {
    const input = Requests.build(operation, ref, url, method, inj);
    const target = new URL(url);
    const legacyDb = new RecordingDatabase(catalogDefinitions);
    const liveDb = new RecordingDatabase(catalogDefinitions);
    const before = await Outcome.async(() => legacyCatalog.validateCatalogRequest(legacyDb.asDatabase(), input, target));
    const after = await Outcome.async(() => liveCatalog.validateCatalogRequest(liveDb.asDatabase(), input, target));
    seen.add(before);
    const label = JSON.stringify([operation, ref, url, method, inj]);
    if (before !== after) mismatches.push(`${ label }: ${ before } vs ${ after }`);
    if (JSON.stringify(legacyDb.calls) !== JSON.stringify(liveDb.calls)) mismatches.push(`${ label }: queries ${ legacyDb.calls } vs ${ liveDb.calls }`);
  };

  it('validateCatalogRequest decides identically for every manifest/ref/url/method/injection combination', async() => {
    const mismatches: string[] = [];
    const seen = new Set<string>();
    const allUrls = [...Object.values(urlsFor).flat(), ...genericUrls];
    for (const operation of ['catalog.http', 'mcp.http', 'other.http']) {
      for (const ref of refs) {
        // Full matrix on each fixture's own URLs (account refs exercise the MCP manifests); every ref also sees every URL once.
        const urls = urlsFor[ref.integrationId ?? ''] ?? (ref.accountId ? [...urlsFor['mcp-my-server'], ...urlsFor['mcp-plain']] : []);
        for (const url of urls) {
          for (const method of methods) {
            for (const inj of injections) await compare(mismatches, seen, operation, ref, url, method, inj);
          }
        }
        for (const url of allUrls) await compare(mismatches, seen, operation, ref, url, 'GET', injections[2]);
        if (mismatches.length >= 20) break;
      }
    }
    expect(mismatches.slice(0, 20)).toEqual([]);
    for (const expected of ['ok:{"credentialFree":false}', 'ok:{"credentialFree":true}', 'throw:Error:destination_denied', 'throw:Error:injection_denied',
      'throw:Error:manifest_not_found', 'throw:Error:manifest_invalid', 'throw:Error:endpoint_denied']) {
      expect([...seen]).toContain(expected);
    }
  });

  it('pins representative catalog decisions independently of the legacy copy', async() => {
    const db = new RecordingDatabase(catalogDefinitions);
    const run = (ref: BrokerExecuteRequest['ref'], url: string, method: string, inj: BrokerInjection[], operation = 'catalog.http') =>
      liveCatalog.validateCatalogRequest(db.asDatabase(), Requests.build(operation, ref, url, method, inj), new URL(url));
    await expect(run({ integrationId: 'stripe' }, 'https://api.stripe.com/v1/customers/cus_1', 'GET', [bearer('bearer_token')])).resolves.toEqual({ credentialFree: false });
    await expect(run({ integrationId: 'stripe' }, 'https://api.stripe.com/v1/public', 'GET', [])).resolves.toEqual({ credentialFree: true });
    await expect(run({ integrationId: 'stripe' }, 'https://api.stripe.com/v1/customers', 'GET', [])).rejects.toThrow('injection_denied');
    await expect(run({ integrationId: 'stripe' }, 'https://api.stripe.com/v1/hidden', 'GET', [bearer('bearer_token')])).rejects.toThrow('endpoint_denied');
    await expect(run({ integrationId: 'missing' }, 'https://api.stripe.com/v1/customers', 'GET', [])).rejects.toThrow('manifest_not_found');
    await expect(run({ integrationId: 'google_drive' }, 'https://www.googleapis.com/drive/v3/files', 'GET', [bearer('access_token')])).resolves.toEqual({ credentialFree: false });
    await expect(run({ accountId: 'My Server!!' }, 'https://mcp.example.com/mcp', 'POST', [], 'mcp.http')).resolves.toEqual({ credentialFree: true });
    expect(db.calls).toContain(JSON.stringify(['SELECT files FROM integration_definitions WHERE slug=$1 LIMIT 1', ['mcp-my-server']]));
  });
});
