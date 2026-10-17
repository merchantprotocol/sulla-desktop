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

test('parses bounded relay events split across NDJSON chunks', async() => {
  const encoder = new TextEncoder();
  const chunks = [
    '{"sequence":1,"type":"slack.events_api","pay',
    'load":{"event":{"type":"message"}}}\n{"sequence":2,"type":"relay.gap","payload":{}}\n',
  ];
  const syntheticFetch = () => Promise.resolve(new Response(new ReadableStream({
    pull(controller) {
      const chunk = chunks.shift();
      if (chunk === undefined) controller.close();
      else controller.enqueue(encoder.encode(chunk));
    },
  }), { status: 200, headers: { 'content-type': 'application/x-ndjson' } }));
  const client = new LocalVaultBrokerClient('https://127.0.0.1:30135', {
    serviceId: 'sulla-tools', serviceToken: 'synthetic-service-token',
  }, syntheticFetch);

  const events = [];
  for await (const event of client.relayEventStream('synthetic-relay')) events.push(event);
  assert.deepEqual(events.map(event => [event.sequence, event.type]), [
    [1, 'slack.events_api'],
    [2, 'relay.gap'],
  ]);
});

test('rejects a relay stream that ends with a partial event', async() => {
  const syntheticFetch = () => Promise.resolve(new Response('{"sequence":1', {
    status: 200, headers: { 'content-type': 'application/x-ndjson' },
  }));
  const client = new LocalVaultBrokerClient('https://127.0.0.1:30135', {
    serviceId: 'sulla-tools', serviceToken: 'synthetic-service-token',
  }, syntheticFetch);

  await assert.rejects(async() => {
    for await (const _event of client.relayEventStream('synthetic-relay')) {
      // No complete event should be yielded.
    }
  }, (error: unknown) => error instanceof VaultBrokerError && error.code === 'invalid_response');
});
