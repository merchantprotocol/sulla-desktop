import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { createProviderCliBridge } from './providerCliBridge';
import { extractChatgptAccountId } from '../../../services/sulla-vault/src/chatgptOAuth';
import { validateOperation } from '../../../services/sulla-vault/src/operationPolicy';

import type { BrokerExecuteRequest, ToolExecutionContext } from './index';

const context: ToolExecutionContext = {
  request_id:       'request-1',
  v:                1,
  iss:              'test',
  aud:              'sulla-tools',
  sub:              'user-1',
  agent_id:         'agent-1',
  pod_id:           'device-1',
  device_id:        'installation-1',
  org_id:           'org-1',
  thread_id:        'thread-1',
  job_id:           'job-1',
  credential_scope: { integration_id: 'openai', account_id: 'account-1' },
  scopes:           [],
  iat:              1,
  exp:              4_000_000_000,
  jti:              'jti-1',
};
const syntheticAgentPolicy = {
  mode:              'agents' as const,
  level:             'autofill' as const,
  agents:            [],
  sites:             [],
  expiresAt:         null,
  askFirst:          false,
  allowServerAgents: false,
};

test('streams a provider request through an exact identity-bound vault operation', async() => {
  let captured: BrokerExecuteRequest | undefined;
  const lease = await createProviderCliBridge({
    context,
    provider:  'codex',
    accountId: 'account-1',
    authorize: identity => identity.context.job_id === 'job-1',
    broker:    {
      requestFor: (ctx, request) => ({
        ...request,
        claims: {
          sub:              ctx.sub,
          agent_id:         ctx.agent_id!,
          pod_id:           ctx.pod_id!,
          device_id:        ctx.device_id,
          org_id:           ctx.org_id,
          thread_id:        ctx.thread_id,
          job_id:           ctx.job_id,
          credential_scope: ctx.credential_scope,
        },
      }),
      executeStream: (request) => {
        captured = request;
        return Promise.resolve(new Response('data: synthetic\n\n', {
          status: 200, headers: { 'content-type': 'text/event-stream' },
        }));
      },
    },
  });

  try {
    const response = await fetch(`${ lease.config.baseUrl }/responses`, {
      method:  'POST',
      headers: {
        authorization:         `Bearer ${ lease.config.environment.SULLA_PROVIDER_BRIDGE_TOKEN }`,
        'content-type':        'application/json',
        'openai-organization': 'must-not-forward',
        'openai-project':      'must-not-forward',
        'x-api-key':           'must-not-forward',
      },
      body: JSON.stringify({ model: 'synthetic', input: 'fixture' }),
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'data: synthetic\n\n');
    assert.equal(captured?.operation, 'provider.cli');
    assert.equal(captured?.url, 'https://api.openai.com/v1/responses');
    assert.deepEqual(captured?.ref, { integrationId: 'openai', accountId: 'account-1' });
    assert.equal(captured?.claims.job_id, 'job-1');
    assert.equal(captured?.headers?.authorization, undefined);
    assert.equal(captured?.headers?.['x-api-key'], undefined);
    assert.equal(captured?.headers?.['openai-organization'], undefined);
    assert.equal(captured?.headers?.['openai-project'], undefined);
  } finally {
    await lease.close();
  }
});

test('routes ChatGPT OAuth through authority-owned bearer and account injection', async() => {
  let captured: BrokerExecuteRequest | undefined;
  const oauthContext: ToolExecutionContext = {
    ...context,
    credential_scope: { integration_id: 'codex', account_id: 'subscription-1' },
  };
  const lease = await createProviderCliBridge({
    context:   oauthContext,
    provider:  'codex',
    accountId: 'subscription-1',
    authorize: () => oauthContext,
    broker:    {
      requestFor: (ctx, request) => ({
        ...request,
        claims: {
          sub:              ctx.sub,
          agent_id:         ctx.agent_id!,
          pod_id:           ctx.pod_id!,
          device_id:        ctx.device_id,
          org_id:           ctx.org_id,
          thread_id:        ctx.thread_id,
          job_id:           ctx.job_id,
          credential_scope: ctx.credential_scope,
        },
      }),
      executeStream: request => {
        captured = request;
        return Promise.resolve(new Response('data: synthetic\n\n', { status: 200 }));
      },
    },
  });
  try {
    const response = await fetch(`${ lease.config.baseUrl }/responses`, {
      method:  'POST',
      headers: { authorization: `Bearer ${ lease.config.environment.SULLA_PROVIDER_BRIDGE_TOKEN }` },
      body:    JSON.stringify({ model: 'synthetic', input: 'fixture' }),
    });
    assert.equal(response.status, 200);
    assert.equal(captured?.url, 'https://chatgpt.com/backend-api/codex/responses');
    assert.deepEqual(captured?.ref, { integrationId: 'codex', accountId: 'subscription-1' });
    assert.deepEqual(captured?.injections, [
      { field: 'access_token', target: 'header', name: 'authorization', scheme: 'Bearer' },
      { field: 'chatgpt_account_id', target: 'header', name: 'chatgpt-account-id', scheme: 'raw' },
    ]);
    assert.equal(captured?.headers?.originator, 'codex_cli_rs');
    assert.equal(captured?.headers?.['session-id'], 'thread-1');
    assert.equal(captured?.headers?.['thread-id'], 'thread-1');
  } finally {
    await lease.close();
  }
});

test('extracts only bounded ChatGPT account routing metadata from synthetic JWTs', () => {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const token = `${ encode({ alg: 'none' }) }.${ encode({
    'https://api.openai.com/auth': { chatgpt_account_id: 'workspace-synthetic' },
  }) }.signature`;
  assert.equal(extractChatgptAccountId(token), 'workspace-synthetic');
  assert.equal(extractChatgptAccountId('not-a-jwt'), undefined);
  const unsafe = `${ encode({ alg: 'none' }) }.${ encode({
    'https://api.openai.com/auth': { chatgpt_account_id: 'bad\r\nheader' },
  }) }.signature`;
  assert.equal(extractChatgptAccountId(unsafe), undefined);
});

test('rejects arbitrary destinations and revokes when live identity is inactive', async() => {
  let active = true;
  let calls = 0;
  const lease = await createProviderCliBridge({
    context,
    provider:  'codex',
    accountId: 'account-1',
    authorize: () => active,
    broker:    {
      requestFor: (_ctx, request) => ({
        ...request,
        claims: {
          sub:       'user-1',
          agent_id:  'agent-1',
          pod_id:    'device-1',
          device_id: 'installation-1',
          org_id:    'org-1',
          thread_id: 'thread-1',
          job_id:    'job-1',
        },
      }),
      executeStream: () => {
        calls++;
        return Promise.resolve(new Response(null, { status: 204 }));
      },
    },
  });
  const capability = lease.config.environment.SULLA_PROVIDER_BRIDGE_TOKEN;

  try {
    const arbitrary = await fetch(`${ lease.config.baseUrl }/https://attacker.invalid/collect`, {
      method: 'POST', headers: { authorization: `Bearer ${ capability }` }, body: '{}',
    });
    assert.equal(arbitrary.status, 404);
    assert.equal(calls, 0);

    active = false;
    await assert.rejects(fetch(`${ lease.config.baseUrl }/responses`, {
      method: 'POST', headers: { authorization: `Bearer ${ capability }` }, body: '{}',
    }));
    assert.equal(lease.signal.aborted, true);
    assert.equal(calls, 0);
  } finally {
    await lease.close();
  }
});

test('advertises the service hostname with the actual bound port and validates setup before listen', async() => {
  await assert.rejects(createProviderCliBridge({
    context,
    provider:       'codex',
    accountId:      'account-1',
    advertisedHost: 'http://invalid.example/path',
    authorize:      () => true,
    broker:          {} as never,
  }), /advertised host/);

  const lease = await createProviderCliBridge({
    context,
    provider:       'codex',
    accountId:      'account-1',
    advertisedHost: 'sulla-provider-bridge',
    authorize:      () => true,
    broker:         {
      requestFor: (_ctx, request) => ({
        ...request,
        claims: {
          sub: 'unused', agent_id: 'unused', pod_id: 'unused',
        },
      }),
      executeStream: () => Promise.resolve(new Response(null, { status: 204 })),
    },
  });
  try {
    const advertised = new URL(lease.config.baseUrl);
    assert.equal(advertised.hostname, 'sulla-provider-bridge');
    assert.match(advertised.port, /^[1-9][0-9]*$/);
    assert.equal(advertised.pathname.endsWith('/v1'), true);
  } finally {
    await lease.close();
  }
});

test('revocation destroys a partial request body and close does not hang', async() => {
  let checks = 0;
  let requestAuthorized!: () => void;
  const authorized = new Promise<void>(resolve => {
    requestAuthorized = resolve;
  });
  const lease = await createProviderCliBridge({
    context,
    provider:  'codex',
    accountId: 'account-1',
    authorize: () => {
      if (++checks === 2) requestAuthorized();
      return true;
    },
    broker: {
      requestFor: (_ctx, request) => ({
        ...request,
        claims: {
          sub: 'unused', agent_id: 'unused', pod_id: 'unused',
        },
      }),
      executeStream: () => Promise.reject(new Error('broker must not receive a partial request')),
    },
  });
  const url = new URL(`${ lease.config.baseUrl }/responses`);
  const request = http.request({
    hostname: url.hostname,
    port:     url.port,
    path:     url.pathname,
    method:   'POST',
    headers:  { authorization: `Bearer ${ lease.config.environment.SULLA_PROVIDER_BRIDGE_TOKEN }` },
  });
  request.on('error', () => undefined);
  const clientClosed = new Promise<void>(resolve => request.once('close', () => resolve()));
  request.write('{"model":"synthetic"');
  await authorized;
  lease.revoke();
  await Promise.race([
    lease.close(),
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('bridge close hung')), 1_000)),
  ]);
  await Promise.race([
    clientClosed,
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('client socket stayed open')), 1_000)),
  ]);
  assert.equal(request.destroyed, true);
});

test('rejects device, organization, and model scope changes during a live lease', async() => {
  for (const changed of [
    { ...context, device_id: 'installation-2' },
    { ...context, org_id: 'org-2' },
  ]) {
    let checks = 0;
    let calls = 0;
    const lease = await createProviderCliBridge({
      context,
      provider:  'codex',
      accountId: 'account-1',
      models:    ['allowed-model'],
      authorize: () => ++checks === 1 ? context : changed,
      broker:    {
        requestFor: (_ctx, request) => ({
          ...request,
          claims: {
            sub:       'user-1',
            agent_id:  'agent-1',
            pod_id:    'device-1',
            device_id: 'installation-1',
            org_id:    'org-1',
            thread_id: 'thread-1',
            job_id:    'job-1',
          },
        }),
        executeStream: () => {
          calls++;
          return Promise.resolve(new Response(null, { status: 204 }));
        },
      },
    });
    try {
      await assert.rejects(fetch(`${ lease.config.baseUrl }/responses`, {
        method:  'POST',
        headers: { authorization: `Bearer ${ lease.config.environment.SULLA_PROVIDER_BRIDGE_TOKEN }` },
        body:    JSON.stringify({ model: 'allowed-model' }),
      }));
      assert.equal(calls, 0);
    } finally {
      await lease.close();
    }
  }

  let calls = 0;
  const lease = await createProviderCliBridge({
    context,
    provider:  'codex',
    accountId: 'account-1',
    models:    ['allowed-model'],
    authorize: () => context,
    broker:    {
      requestFor: (_ctx, request) => ({
        ...request,
        claims: {
          sub:       'user-1',
          agent_id:  'agent-1',
          pod_id:    'device-1',
          device_id: 'installation-1',
          org_id:    'org-1',
          thread_id: 'thread-1',
          job_id:    'job-1',
        },
      }),
      executeStream: () => {
        calls++;
        return Promise.resolve(new Response(null, { status: 204 }));
      },
    },
  });
  try {
    const response = await fetch(`${ lease.config.baseUrl }/responses`, {
      method:  'POST',
      headers: { authorization: `Bearer ${ lease.config.environment.SULLA_PROVIDER_BRIDGE_TOKEN }` },
      body:    JSON.stringify({ model: 'different-model' }),
    });
    assert.equal(response.status, 403);
    assert.equal(calls, 0);
  } finally {
    await lease.close();
  }
});

test('provider CLI authority policy binds provider, host, path, and injection', () => {
  const request: BrokerExecuteRequest = {
    claims: {
      sub:              'user-1',
      agent_id:         'agent-1',
      pod_id:           'device-1',
      device_id:        'installation-1',
      org_id:           'org-1',
      thread_id:        'thread-1',
      job_id:           'job-1',
      credential_scope: { integration_id: 'openai', account_id: 'account-1' },
    },
    operation:    'provider.cli',
    ref:          { integrationId: 'openai', accountId: 'account-1' },
    url:          'https://api.openai.com/v1/responses',
    method:       'POST',
    injections:   [{ field: 'api_key', target: 'header', name: 'authorization', scheme: 'Bearer' }],
    responseType: 'stream',
  };
  assert.doesNotThrow(() => validateOperation(request, 'api.openai.com', syntheticAgentPolicy));
  assert.throws(() => validateOperation({
    ...request, url: 'https://api.openai.com/v1/chat/completions',
  }, 'api.openai.com', syntheticAgentPolicy), /path_denied/);
  assert.throws(() => validateOperation({
    ...request,
    ref: { integrationId: 'anthropic', accountId: 'account-1' },
    url: 'https://api.anthropic.com/v1/messages',
  }, 'api.anthropic.com', syntheticAgentPolicy), /injection_denied/);
  assert.throws(() => validateOperation({
    ...request, url: 'https://attacker.invalid/v1/responses',
  }, 'attacker.invalid', syntheticAgentPolicy), /destination_denied/);

  const chatgptRequest: BrokerExecuteRequest = {
    ...request,
    claims: {
      ...request.claims,
      credential_scope: { integration_id: 'codex', account_id: 'account-1' },
    },
    ref:        { integrationId: 'codex', accountId: 'account-1' },
    url:        'https://chatgpt.com/backend-api/codex/responses',
    injections: [
      { field: 'access_token', target: 'header', name: 'authorization', scheme: 'Bearer' },
      { field: 'chatgpt_account_id', target: 'header', name: 'chatgpt-account-id', scheme: 'raw' },
    ],
  };
  assert.doesNotThrow(() => validateOperation(chatgptRequest, 'chatgpt.com', syntheticAgentPolicy));
  assert.throws(() => validateOperation({
    ...chatgptRequest,
    injections: [{ field: 'access_token', target: 'header', name: 'authorization', scheme: 'Bearer' }],
  }, 'chatgpt.com', syntheticAgentPolicy), /injection_denied/);
});
