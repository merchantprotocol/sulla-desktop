import assert from 'node:assert/strict';
import test from 'node:test';

import { buildKeycloakConfig, exactKeycloakId, staleKeycloakIds } from './keycloak-config.mjs';

const config = buildKeycloakConfig({
  realm: 'sulla',
  nativeClientId: 'sulla-desktop',
  nativeRedirectUri: 'http://127.0.0.1:3020/v1/oidc/callback',
  webClientId: 'sulla-web',
  webClientSecret: 'synthetic-secret',
  webRedirectUris: 'https://accounts.example/web/oidc/callback',
  publicUrl: 'https://accounts.example',
  membershipAudience: 'sulla-membership',
  resourceAudiences: 'sulla-projects,sulla-files,sulla-vault,sulla-workflows',
});

function mappedAudience(scope) {
  assert.deepEqual(scope.attributes, {
    'display.on.consent.screen': 'false',
    'include.in.token.scope': 'true',
    'sulla.reconciliation.version': '1',
  });
  assert.equal(scope.protocolMappers.length, 1);
  const mapper = scope.protocolMappers[0];
  assert.equal(mapper.protocolMapper, 'oidc-audience-mapper');
  assert.equal(mapper.config['access.token.claim'], 'true');
  assert.equal(mapper.config['id.token.claim'], 'false');
  return mapper.config['included.custom.audience'];
}

test('membership is a distinct default audience scope', () => {
  assert.equal(config.membershipScope.name, 'sulla-audience-sulla-membership');
  assert.equal(mappedAudience(config.membershipScope), 'sulla-membership');
  assert.deepEqual(config.nativeClient.defaultClientScopes, ['profile', 'sulla-audience-sulla-membership']);
  assert.deepEqual(config.webClient.defaultClientScopes, ['profile', 'sulla-audience-sulla-membership']);
  assert.ok(!config.nativeClient.optionalClientScopes.includes(config.membershipScope.name));
  assert.ok(!config.webClient.optionalClientScopes.includes(config.membershipScope.name));
});

test('resource audiences use the Accounts hyphenated optional scope contract', () => {
  const expected = new Map([
    ['sulla-audience-sulla-projects', 'sulla-projects'],
    ['sulla-audience-sulla-files', 'sulla-files'],
    ['sulla-audience-sulla-vault', 'sulla-vault'],
    ['sulla-audience-sulla-workflows', 'sulla-workflows'],
  ]);
  assert.deepEqual(new Map(config.resourceScopes.map(scope => [scope.name, mappedAudience(scope)])), expected);
  assert.deepEqual(config.nativeClient.optionalClientScopes, [...expected.keys()]);
  assert.deepEqual(config.webClient.optionalClientScopes, [...expected.keys()]);
});

test('Keycloak reconciliation filters ignored query results by exact JSON name', () => {
  const scopes = [
    { id: 'builtin-profile', name: 'profile' },
    { id: 'resource-files', name: 'sulla-audience-sulla-files' },
    { id: 'resource-workflows', name: 'sulla-audience-sulla-workflows' },
  ];
  assert.equal(exactKeycloakId(scopes, 'name', 'sulla-audience-sulla-workflows'), 'resource-workflows');
  assert.equal(exactKeycloakId(scopes, 'name', 'sulla-audience-sulla-membership'), '');
  assert.throws(
    () => exactKeycloakId([...scopes, { id: 'duplicate', name: 'sulla-audience-sulla-files' }], 'name', 'sulla-audience-sulla-files'),
    /duplicate name values/,
  );
});

test('mapper cleanup is bounded to unexpected mappers in the selected scope', () => {
  const mappers = [
    { id: 'intended', name: 'audience-sulla-workflows' },
    { id: 'stale-origin', name: 'allowed-web-origins' },
    { id: 'stale-audience', name: 'audience-sulla-membership' },
  ];
  assert.deepEqual(staleKeycloakIds(mappers, 'name', 'audience-sulla-workflows'), ['stale-origin', 'stale-audience']);
  assert.throws(
    () => staleKeycloakIds([...mappers, { name: 'missing-id' }], 'name', 'audience-sulla-workflows'),
    /invalid id/,
  );
});
