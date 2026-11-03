/**
 * @jest-environment node
 */
// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { VaultBrokerError } from '../index';
import { classifyProviderBridgeFailure, createProviderCliBridge, PROVIDER_BRIDGE_RETRY_AFTER_SECONDS } from '../providerCliBridge';

import type { BrokerExecuteRequest, ToolExecutionContext } from '../index';

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

function requestFor(ctx: ToolExecutionContext, request: Omit<BrokerExecuteRequest, 'claims'>): BrokerExecuteRequest {
  return {
    ...request,
    claims: {
      sub:              ctx.sub,
      agent_id:         ctx.agent_id!,
      pod_id:           ctx.pod_id!,
      org_id:           ctx.org_id,
      thread_id:        ctx.thread_id,
      job_id:           ctx.job_id,
      credential_scope: ctx.credential_scope,
    },
  };
}

async function callBridge(executeStream: () => Promise<Response>) {
  const timings: string[] = [];
  const lease = await createProviderCliBridge({
    context,
    provider:  'codex',
    accountId: 'account-1',
    authorize: () => true,
    logTiming: line => timings.push(line),
    broker:    { requestFor, executeStream },
  });

  try {
    const response = await fetch(`${ lease.config.baseUrl }/responses`, {
      method:  'POST',
      headers: {
        authorization:  `Bearer ${ lease.config.environment.SULLA_PROVIDER_BRIDGE_TOKEN }`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: 'synthetic', input: 'fixture' }),
    });
    const body = await response.json() as { error: { type: string; message: string; reason?: string } };

    return { response, body, timings };
  } finally {
    await lease.close();
  }
}

describe('provider CLI bridge egress failures', () => {
  let errorSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('turns a vault broker egress failure into a retryable 503 with the reason logged', async() => {
    const { response, body, timings } = await callBridge(() => Promise.reject(
      new VaultBrokerError('upstream_failed', 'Broker upstream stream failed', 502, 'connect_ECONNREFUSED', true),
    ));

    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe(String(PROVIDER_BRIDGE_RETRY_AFTER_SECONDS));
    expect(response.headers.get('retry-after-ms')).toBe(String(PROVIDER_BRIDGE_RETRY_AFTER_SECONDS * 1000));
    expect(response.headers.get('x-should-retry')).toBe('true');
    expect(body.error.type).toBe('provider_bridge_unavailable');
    expect(body.error.message).toMatch(/provider bridge/i);
    expect(body.error.reason).toBe('connect_ECONNREFUSED');

    // perf.log is the only place bridge failures persist on the host, so the reason must be there.
    expect(timings).toHaveLength(1);
    expect(timings[0]).toContain('status=503');
    expect(timings[0]).toContain('failure=provider_bridge_unavailable:upstream_failed');
    expect(timings[0]).toContain('reason=connect_ECONNREFUSED');
    expect(errorSpy.mock.calls.map(call => String(call[0])).join('\n')).toContain('VaultBrokerError (upstream_failed) reason=connect_ECONNREFUSED -> 503');
  });

  it('keeps a non-transient vault denial as a terminal 502 without retry hints', async() => {
    const { response, body, timings } = await callBridge(() => Promise.reject(
      new VaultBrokerError('policy_denied', 'Credential is unavailable to this caller', 403),
    ));

    expect(response.status).toBe(502);
    expect(response.headers.get('retry-after')).toBeNull();
    expect(body.error.type).toBe('provider_bridge_failed');
    expect(timings[0]).toContain('status=502');
    expect(timings[0]).toContain('failure=provider_bridge_failed:policy_denied');
  });
});

describe('classifyProviderBridgeFailure', () => {
  it.each([
    ['vault upstream_failed', new VaultBrokerError('upstream_failed', 'x', 502, 'dns_EAI_AGAIN'), 503, 'dns_EAI_AGAIN'],
    ['vault upstream_timeout', new VaultBrokerError('upstream_timeout', 'x', 504), 503, 'upstream_timeout'],
    ['vault database_unavailable', new VaultBrokerError('database_unavailable', 'x', 503), 503, 'database_unavailable'],
    ['vault unreachable (Node fetch)', Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }), 503, 'vault_unreachable_ECONNREFUSED'],
    ['vault unreachable (Electron net)', new Error('net::ERR_NETWORK_CHANGED'), 503, 'vault_unreachable_ERR_NETWORK_CHANGED'],
    ['vault still starting', new Error('Sulla is still starting its password vault. Wait for startup to finish, then try again.'), 503, 'vault_starting'],
    ['vault locked', new VaultBrokerError('vault_locked', 'Vault is locked', 423), 502, 'vault_locked'],
    ['malformed request body', new SyntaxError('Unexpected token'), 502, undefined],
  ])('classifies %s', (_label, error, status, reason) => {
    const failure = classifyProviderBridgeFailure(error);

    expect(failure.status).toBe(status);
    expect(failure.transient).toBe(status === 503);
    expect(failure.reason).toBe(reason);
  });

  it('never echoes arbitrary reason text from the vault', () => {
    const failure = classifyProviderBridgeFailure(new VaultBrokerError('upstream_failed', 'x', 502, 'https://example.test/path?token=secret value'));

    expect(failure.reason).toBe('upstream_failed');
  });
});
