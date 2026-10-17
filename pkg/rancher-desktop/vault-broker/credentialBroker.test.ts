import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LocalVaultBrokerClient,
  VaultBrokerError,
  type ToolExecutionContext,
} from './index';

const verifiedContext: ToolExecutionContext = {
  request_id: 'request-1',
  v:          1,
  iss:        'test',
  aud:        'sulla-tools',
  sub:        'user-1',
  agent_id:   'agent-1',
  pod_id:     'pod-1',
  scopes:     ['*'],
  iat:        1,
  exp:        4_000_000_000,
  jti:        'jti-1',
};

test('rejects an incomplete caller before making a broker request', () => {
  const client = new LocalVaultBrokerClient('https://127.0.0.1:30135', {
    serviceId: 'sulla-tools', serviceToken: 'synthetic-service-token',
  });
  assert.throws(
    () => client.requestFor({ ...verifiedContext, agent_id: undefined }, {
      operation:  'github.api',
      ref:        { integrationId: 'github' },
      url:        'https://api.github.com/user',
      method:     'GET',
      injections: [],
    }),
    (error: unknown) => error instanceof VaultBrokerError && error.code === 'invalid_caller_identity',
  );
});

test('forwards destination policy denial without returning secret material', async() => {
  const syntheticFetch = () => Promise.resolve(new Response(JSON.stringify({ error: 'destination_denied', message: 'Destination denied' }), {
    status: 403, headers: { 'content-type': 'application/json' },
  }));
  const client = new LocalVaultBrokerClient('https://127.0.0.1:30135', {
    serviceId: 'sulla-tools', serviceToken: 'synthetic-service-token',
  }, syntheticFetch);
  const request = client.requestFor(verifiedContext, {
    operation:  'github.api',
    ref:        { integrationId: 'github' },
    url:        'https://127.0.0.1/private',
    method:     'GET',
    injections: [{ field: 'token', target: 'header', name: 'authorization', scheme: 'Bearer' }],
  });
  await assert.rejects(client.execute(request), (error: unknown) =>
    error instanceof VaultBrokerError && error.code === 'destination_denied' && !error.message.includes('synthetic-service-token'));
});

test('arbitrary secret egress is an explicit unsupported operation', () => {
  const error = new VaultBrokerError('unsupported_secret_egress', 'Secret env/stdin injection is unsupported', 501);
  assert.equal(error.code, 'unsupported_secret_egress');
  assert.doesNotMatch(JSON.stringify(error), /password|private.?key|refresh.?token/i);
});
