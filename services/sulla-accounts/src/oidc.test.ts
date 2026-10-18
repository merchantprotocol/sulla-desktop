import assert from 'node:assert/strict';
import test from 'node:test';

import { beginAuthorization, createAuthority, type Authority } from './oidc.js';

import type { AccountsConfig } from './config.js';
import type { Database } from './db.js';

const config: AccountsConfig = {
  mode: 'desktop',
  port: 3020,
  databaseUrl: 'postgres://unused',
  publicUrl: 'http://127.0.0.1:3020',
  allowedReturnOrigins: new Set(),
  sessionSecret: Buffer.alloc(32),
  encryptionKey: Buffer.alloc(32),
  serviceTokens: new Map(),
  keycloakIssuer: 'https://authority.example/auth/realms/sulla',
  keycloakResourceAudiences: new Set(),
  trustedProxy: false,
};

function authority(overrides: Partial<Authority> = {}): Authority {
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    issuer: 'https://authority.example/auth/realms/sulla',
    client_id: 'sulla-desktop',
    resource_audiences: ['sulla-files'],
    scopes: ['openid', 'profile'],
    authorization_endpoint: 'https://authority.example/auth/realms/sulla/protocol/openid-connect/auth',
    token_endpoint: 'https://authority.example/auth/realms/sulla/protocol/openid-connect/token',
    jwks_uri: 'https://authority.example/auth/realms/sulla/protocol/openid-connect/certs',
    ...overrides,
  };
}

function database(): Database {
  const client = {
    query: async() => ({ rows: [], rowCount: 0 }),
    release: () => undefined,
  };
  return { connect: async() => client } as unknown as Database;
}

test('remote authority authorization requests pinned membership and resource scopes', async() => {
  const enrolled = authority({
    issuer: 'https://remote.example/auth/realms/sulla',
    authorization_endpoint: 'https://remote.example/auth/realms/sulla/protocol/openid-connect/auth',
    token_endpoint: 'https://remote.example/auth/realms/sulla/protocol/openid-connect/token',
    jwks_uri: 'https://remote.example/auth/realms/sulla/protocol/openid-connect/certs',
    remote_authority_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    membership_endpoint: 'https://remote.example/v1/authority/membership/resolve',
    scopes: ['openid', 'profile', 'sulla-audience-custom-membership'],
  });

  const result = await beginAuthorization(database(), config, enrolled, undefined, 'sulla-files');
  const scopes = new URL(result.authorizationUrl).searchParams.get('scope')?.split(' ');

  assert.deepEqual(scopes, [
    'openid',
    'profile',
    'sulla-audience-custom-membership',
    'sulla-audience-sulla-files',
  ]);
});

test('connection enrollment pins the advertised membership audience scope', async(t) => {
  t.mock.method(globalThis, 'fetch', async() => new Response(JSON.stringify({
    issuer: 'https://remote.example/auth/realms/sulla',
    authorization_endpoint: 'https://remote.example/auth/realms/sulla/protocol/openid-connect/auth',
    token_endpoint: 'https://remote.example/auth/realms/sulla/protocol/openid-connect/token',
    jwks_uri: 'https://remote.example/auth/realms/sulla/protocol/openid-connect/certs',
    authorityId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    nativeClientId: 'sulla-desktop',
    membershipResolver: 'https://remote.example/v1/authority/membership/resolve',
    membershipAudience: 'custom-membership',
    resourceAudiences: ['sulla-files'],
  }), { status: 200, headers: { 'content-type': 'application/json' } }));
  let inserted: unknown[] | undefined;
  const db = {
    query: async(_sql: string, values: unknown[]) => {
      inserted = values;
      return { rows: [authority()], rowCount: 1 };
    },
  } as unknown as Database;

  await createAuthority(db, {
    issuer: 'https://remote.example/auth/realms/sulla',
    clientId: 'sulla-desktop',
    resourceAudiences: ['sulla-files'],
    scopes: ['openid', 'profile'],
    remoteAuthorityId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    membershipEndpoint: 'https://remote.example/v1/authority/membership/resolve',
    membershipAudience: 'custom-membership',
  });

  assert.deepEqual(inserted?.[5], ['openid', 'profile', 'sulla-audience-custom-membership']);
  assert.equal(inserted?.[11], 'custom-membership');
  await assert.rejects(createAuthority(db, {
    issuer: 'https://remote.example/auth/realms/sulla', clientId: 'sulla-desktop',
    resourceAudiences: ['sulla-files'], remoteAuthorityId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    membershipEndpoint: 'https://remote.example/v1/authority/membership/resolve',
    membershipAudience: 'forged-membership',
  }), /metadata mismatch/);
});

test('issuer equality alone does not grant authority-managed scopes', async() => {
  const result = await beginAuthorization(database(), config, authority(), undefined, 'sulla-files');
  const scopes = new URL(result.authorizationUrl).searchParams.get('scope')?.split(' ');

  assert.deepEqual(scopes, ['openid', 'profile']);
});
