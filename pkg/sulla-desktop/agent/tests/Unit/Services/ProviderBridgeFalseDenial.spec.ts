// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { request as httpRequest } from 'node:http';
import { Readable } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { isProviderBridgeDenial } from '../../../languagemodels/providerRecovery';
import { AgentContainerRuntimeRegistry } from '../../../services/AgentContainerRuntimeRegistry';
import {
  ProviderBridgeAuthorizeUnavailableError,
  ProviderCliBridgeService,
  type ProviderCliBridgeLease,
  type ProviderCliBridgeOptions,
} from '../../../../vault-broker/providerCliBridge';
import { providerBridgeActivity } from '../../../../vault-broker/ProviderBridgeActivity';
import { SystemTurnTimingClock, TurnTiming } from '../../../services/TurnTiming';

/**
 * Real ProviderCliBridgeService on a loopback port; only the vault broker
 * (the external upstream) is faked. Each case is a request a healthy
 * container job makes that the bridge used to refuse as a terminal
 * "Provider bridge request denied", which the CLI recovery treats as fatal.
 */
const now = Math.floor(Date.now() / 1000);
const context = {
  v: 1, iss: 'sulla-desktop', aud: 'sulla-tools', sub: 'user-1', org_id: 'org-1', agent_id: 'agent-1', pod_id: 'pod-1',
  thread_id: 'thread-1', job_id: 'job-1', device_id: 'device-1',
  credential_scope: { integration_id: 'codex', account_id: 'acct-1' }, scopes: [], iat: now, exp: now + 300, jti: 'jti-1',
} as any;

class FakeBroker {
  readonly calls: unknown[] = [];
  constructor(private readonly respond: (signal?: AbortSignal) => Promise<Response> = async() => new Response('data: ok\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } })) {}
  requestFor = (_ctx: unknown, request: unknown) => request;
  executeStream = async(request: unknown, signal?: AbortSignal) => {
    this.calls.push(request);
    return this.respond(signal);
  };
}

/**
 * Talks to the bridge over loopback with node:http. The agent spec setup
 * replaces global fetch with a guard that refuses every request, and the
 * bridge's own upstream goes through the injected FakeBroker, so no fetch
 * is involved anywhere. The reply is wrapped in a standard Response so the
 * assertions read the same as for a fetch client.
 */
class LoopbackClient {
  post(url: string, token: string | undefined, body: string): Promise<Response> {
    return new Promise((resolve, reject) => {
      const request = httpRequest(url, {
        method:  'POST',
        agent:   false,
        headers: { authorization: `Bearer ${ token }`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      }, incoming => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (value === undefined) continue;
          for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
        }
        const status = incoming.statusCode ?? 0;
        const stream = [204, 205, 304].includes(status) ? null : Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
        resolve(new Response(stream, { status, headers }));
      });
      request.once('error', reject);
      request.end(body);
    });
  }
}

const loopback = new LoopbackClient();
const leases: ProviderCliBridgeLease[] = [];
afterEach(async() => {
  await Promise.all(leases.splice(0).map(lease => lease.close()));
  vi.restoreAllMocks();
});

async function openBridge(overrides: Partial<ProviderCliBridgeOptions> & { broker?: FakeBroker }) {
  const timings: string[] = [];
  const lease = await new ProviderCliBridgeService(() => { throw new Error('no default broker in tests') }).create({
    context, provider: 'codex', accountId: 'acct-1', authorize: () => true,
    logTiming: message => timings.push(message),
    ...overrides,
    broker: (overrides.broker ?? new FakeBroker()) as any,
  });
  leases.push(lease);
  const send = (body = '{"model":"gpt-5"}', path = '/responses') => loopback.post(`${ lease.config.baseUrl }${ path }`, lease.config.environment.SULLA_PROVIDER_BRIDGE_TOKEN, body);
  return { lease, send, timings };
}

describe('provider bridge never falsely denies a healthy container job', () => {
  it.each([429, 503])('logs only safe bridge timing fields and retry-after for HTTP %i', async(status) => {
    // risk: provider error diagnostics accidentally persist bearer credentials or unbounded response content
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const secret = 'sk-proj-synthetic-secret-token';
    const orgId = 'org-SyntheticOrgId1234567890';
    const providerMessage = `${ secret } rate limit details in organization ${ orgId } ${ 'for the selected model '.repeat(30) } Bearer ${ secret }`;
    const broker = new FakeBroker(async() => new Response(JSON.stringify({ error: { message: providerMessage } }), {
      status,
      headers: { 'retry-after': '9' },
    }));
    const { send, timings } = await openBridge({ broker });
    const statuses: Array<{ status: number; reason?: string; retryAfterSeconds?: number }> = [];
    const unsubscribe = providerBridgeActivity.subscribeRetryStatus(context.pod_id, value => statuses.push(value));

    try {
      const response = await send();
      await response.text();

      const timing = timings.at(-1)!;
      expect(response.status).toBe(status);
      expect(timing).toContain(`status=${ status }`);
      expect(timing).toContain('retry_after=9s');
      expect(timing).toContain('path=/v1/responses');
      expect(timing).not.toContain('openai_reason=');
      expect(timing).not.toContain('rate limit details');
      expect(timing).not.toContain(secret);
      expect(timing).not.toContain(`Bearer ${ secret }`);
      expect(timing).not.toContain(orgId);
      expect(statuses[0]).toMatchObject({ status, retryAfterSeconds: 9 });
      expect(statuses.at(-1)).toMatchObject({ status, retryAfterSeconds: 9 });
      expect(statuses.at(-1)?.reason).toContain('rate limit details');
      expect(statuses.at(-1)?.reason).not.toContain(secret);
    } finally {
      unsubscribe();
    }
  });

  it('correlates bridge request timings with the owning turn id without logging response text', async() => {
    // risk: a bridge request cannot be joined to its turn or its streamed text leaks into perf.log
    const turnLines: string[] = [];
    const timing = new TurnTiming({
      clock: new SystemTurnTimingClock(),
      perfLog: { log: line => turnLines.push(line) },
      runId: 'run-bridge-test',
      surface: 'chat',
      provider: 'codex',
      model: null,
      threadId: 'thread-bridge-test',
    });
    const output = 'synthetic-visible-output';
    const sse = `event: response.output_text.delta\ndata: ${ JSON.stringify({ type: 'response.output_text.delta', delta: output }) }\n\n`;
    const broker = new FakeBroker(async() => new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    const { send, timings } = await openBridge({ runId: timing.runId, turnTiming: timing, broker });
    const response = await send();
    expect(await response.text()).toBe(sse);
    timing.finish('ok');

    const bridgeLine = timings.at(-1)!;
    const bridgeRequestId = bridgeLine.match(/bridgeRequestId=([0-9a-f-]+)/)?.[1];
    expect(bridgeLine).toContain('runId=run-bridge-test');
    expect(bridgeRequestId).toBeTruthy();
    expect(bridgeLine).not.toContain(output);
    expect(bridgeLine).not.toContain('openai_reason=');
    const record = JSON.parse(turnLines[0].replace(/^\[TurnTiming\] /, ''));
    expect(record.providerRequests).toMatchObject([{ bridgeRequestId, status: 200 }]);
    expect(record.providerRequests[0].firstByteMs).not.toBeNull();
    expect(record.providerRequests[0].firstTextMs).not.toBeNull();
    expect(record.providerRequests[0].endMs).not.toBeNull();
    expect(turnLines[0]).not.toContain(output);
  });

  it('refreshes run correlation on a reused bridge lease for each turn', async() => {
    // risk: a persistent container attributes later provider requests to the first turn’s sink
    const firstLines: string[] = [];
    const secondLines: string[] = [];
    const makeTiming = (runId: string, threadId: string, lines: string[]) => new TurnTiming({
      clock: new SystemTurnTimingClock(),
      perfLog: { log: line => lines.push(line) },
      runId,
      surface: 'chat',
      provider: 'codex',
      model: null,
      threadId,
    });
    const first = makeTiming('run-first', 'thread-first', firstLines);
    const second = makeTiming('run-second', 'thread-second', secondLines);
    let current = { runId: first.runId, turnTiming: first };
    const { send, timings } = await openBridge({ getTimingContext: () => current, broker: new FakeBroker() });

    const firstResponse = await send();
    await firstResponse.text();
    current = { runId: second.runId, turnTiming: second };
    const secondResponse = await send();
    await secondResponse.text();
    first.finish('ok');
    second.finish('ok');

    expect(timings[0]).toContain('runId=run-first');
    expect(timings[1]).toContain('runId=run-second');
    expect(JSON.parse(firstLines[0].replace(/^\[TurnTiming\] /, '')).providerRequests).toHaveLength(1);
    expect(JSON.parse(secondLines[0].replace(/^\[TurnTiming\] /, '')).providerRequests).toHaveLength(1);
    expect(firstLines[0]).toContain('thread-first');
    expect(secondLines[0]).toContain('thread-second');
  });

  it('forwards after a failed early OAuth refresh and logs only its fixed upkeep code', async() => {
    // risk: one failed precautionary Codex token refresh killed the whole worker with 502 provider_bridge_failed
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const broker = new FakeBroker();
    const { send, timings } = await openBridge({ broker, beforeUpstream: async() => { throw new Error('OAuth refresh failed: socket hang up') } });

    const response = await send();

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('data: ok\n\n');
    expect(broker.calls).toHaveLength(1);
    expect(timings.at(-1)).toContain('status=200');
    expect(timings.at(-1)).toContain('upkeep=credential_upkeep_failed');
    expect(timings.at(-1)).not.toContain('OAuth refresh failed');
    expect(timings.at(-1)).not.toContain('socket hang up');
    expect(timings.at(-1)).not.toContain('provider_bridge_failed');
  });

  it('answers a retryable 503 and keeps the lease when the revocation check cannot run', async() => {
    // risk: a Redis blip revoked the lease for the rest of the job (403 identity_changed on every later call)
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Call 0 is the bind-time check in create(); call 1 is the first request's check.
    let calls = 0;
    const flaky = await openBridge({
      authorize: () => {
        if (calls++ === 1) throw new ProviderBridgeAuthorizeUnavailableError('revocation_check_unavailable', { cause: new Error('Connection is closed.') });
        return true;
      },
    });

    const first = await flaky.send();
    const firstBody = await first.json() as { error: { type: string; message: string; reason?: string } };
    expect(first.status).toBe(503);
    expect(first.headers.get('retry-after')).toBe('5');
    expect(firstBody.error.type).toBe('provider_bridge_unavailable');
    expect(firstBody.error.reason).toBe('revocation_check_unavailable');
    expect(isProviderBridgeDenial(new Error(firstBody.error.message))).toBe(false);

    const second = await flaky.send();
    expect(second.status).toBe(200);
    expect(flaky.lease.signal.aborted).toBe(false);
  });

  it('still revokes on a genuine refusal and names the cause', async() => {
    // risk: over-correcting lets an unregistered container keep spending the account
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const registry = new AgentContainerRuntimeRegistry();
    let calls = 0;
    const { lease, send, timings } = await openBridge({
      authorize: () => {
        if (calls++ === 0) return true; // bind time: the container is still registered
        registry.require(context); // request time: it is not
        return true;
      },
    });

    const response = await send();
    const body = await response.json() as { error: { type: string; message: string; reason?: string } };

    expect(response.status).toBe(403);
    expect(body.error.type).toBe('provider_bridge_identity_changed');
    expect(body.error.reason).toBe('container_not_registered');
    expect(isProviderBridgeDenial(new Error(body.error.message))).toBe(true);
    expect(lease.signal.aborted).toBe(true);
    expect(timings.at(-1)).toContain('status=403');
    expect(timings.at(-1)).toContain('failure=provider_bridge_identity_changed');
    expect(timings.at(-1)).toContain('reason=container_not_registered');
    expect(timings.at(-1)).toContain('stage=authorize');
  });

  it('revokes when authorize throws an untyped error that only claims to be retryable', async() => {
    // risk: permissions: any error carrying retryable:true could dodge revocation and keep a refused job spending the account
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let calls = 0;
    const { lease, send } = await openBridge({
      authorize: () => {
        if (calls++ === 0) return true;
        throw Object.assign(new Error('capability refused'), { retryable: true, reason: 'capability_refused' });
      },
    });

    const response = await send();
    const body = await response.json() as { error: { type: string; reason?: string } };

    expect(response.status).toBe(403);
    expect(response.headers.get('retry-after')).toBeNull();
    expect(body.error).toMatchObject({ type: 'provider_bridge_identity_changed', reason: 'capability_refused' });
    expect(lease.signal.aborted).toBe(true);
  });

  it('logs a job teardown mid-stream as a cancellation, not provider_bridge_failed', async() => {
    // risk: every job ending with an open stream inflated the provider_bridge_failed error count
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const lifecycle = new AbortController();
    const encoder = new TextEncoder();
    // Like the real broker fetch, the open upstream stream errors when the bridge aborts it.
    const broker = new FakeBroker(async signal => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: first\n\n'));
        signal?.addEventListener('abort', () => controller.error(new DOMException('This operation was aborted', 'AbortError')), { once: true });
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    const { send, timings } = await openBridge({ broker, signal: lifecycle.signal });

    const response = await send();
    const reader = response.body!.getReader();
    await reader.read();
    lifecycle.abort();
    await reader.read().catch(() => undefined);
    await vi.waitFor(() => expect(timings.some(line => line.includes('status=499'))).toBe(true));

    const line = timings.find(entry => entry.includes('status=499'))!;
    expect(line).toContain('bridgeRequestId=');
    expect((line.match(/failure=/g) ?? [])).toHaveLength(1);
    expect((line.match(/reason=/g) ?? [])).toHaveLength(1);
    expect((line.match(/stage=/g) ?? [])).toHaveLength(1);
    expect(line).toContain('failure=provider_bridge_cancelled reason=lifecycle_revoked stage=upstream_stream');
    expect(line).not.toContain('provider_bridge_failed');
    expect(error).not.toHaveBeenCalled();
  });

  it('writes one failure reason and stage when cancellation arrives before upstream headers', async() => {
    // risk: cancellation diagnostics duplicate a failure/reason/stage set and distort bridge failure counts
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const lifecycle = new AbortController();
    let markStarted!: () => void;
    const upstreamStarted = new Promise<void>(resolve => { markStarted = resolve });
    const broker = new FakeBroker(async signal => new Promise<Response>((_resolve, reject) => {
      markStarted();
      signal?.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError')), { once: true });
    }));
    const { send, timings } = await openBridge({ broker, signal: lifecycle.signal });

    const pending = send();
    await upstreamStarted;
    lifecycle.abort();
    const response = await pending;
    await response.text();

    const line = timings.at(-1)!;
    expect(response.status).toBe(403);
    expect((line.match(/failure=/g) ?? [])).toHaveLength(1);
    expect((line.match(/reason=/g) ?? [])).toHaveLength(1);
    expect((line.match(/stage=/g) ?? [])).toHaveLength(1);
    expect(line).toContain('failure=provider_bridge_cancelled');
    expect(line).toContain('reason=lifecycle_revoked');
  });

  it('answers a malformed body as a client error, not a bridge failure', async() => {
    // risk: CLI-side request bugs counted (and failed fast) as Sulla bridge failures
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { send } = await openBridge({});
    const response = await send('{not json');
    const body = await response.json() as { error: { type: string; reason?: string } };
    expect(response.status).toBe(400);
    expect(body.error).toMatchObject({ type: 'invalid_provider_request', reason: 'invalid_json' });
  });

  it('splits failures by safe enum cause without logging free text', async() => {
    // risk: bridge failures cannot be separated by cause without leaking vault/provider error text
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { send, timings } = await openBridge({ broker: new FakeBroker(async() => { throw new RangeError('boom sk-abc123 private detail') }) });
    const response = await send();
    const body = await response.json() as { error: { type: string; reason?: string } };
    expect(response.status).toBe(502);
    expect(body.error).toMatchObject({ type: 'provider_bridge_failed', reason: 'upstream_headers_RangeError' });
    expect(timings.at(-1)).toContain('status=502');
    expect(timings.at(-1)).toContain('failure=provider_bridge_failed');
    expect(timings.at(-1)).toContain('reason=upstream_headers_RangeError');
    expect(timings.at(-1)).toContain('stage=upstream_headers');
    expect(timings.at(-1)).not.toContain('boom');
    expect(timings.at(-1)).not.toContain('sk-abc123');
    expect(timings.at(-1)).not.toContain('private detail');
  });

  it('logs a route only when it matches the fixed provider route table', async() => {
    // risk: client-controlled path strings leak through BridgeTiming
    const { send, timings } = await openBridge({});
    const allowed = await send('{"model":"gpt-5"}', '/responses');
    expect(allowed.status).toBe(200);
    expect(timings.at(-1)).toContain('path=/v1/responses');

    const clientPath = '/client-supplied-secret-route';
    const denied = await send('{"model":"gpt-5"}', clientPath);
    expect(denied.status).toBe(404);
    expect(timings.at(-1)).not.toContain('path=');
    expect(timings.at(-1)).not.toContain(clientPath);
  });

  it('treats a bare fetch failure reaching the vault as transient', async() => {
    // risk: a dropped vault connection without an errno failed the worker instead of backing off
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { send } = await openBridge({ broker: new FakeBroker(async() => { throw new TypeError('fetch failed') }) });
    const response = await send();
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('5');
  });
});
