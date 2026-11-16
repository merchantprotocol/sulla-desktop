// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { afterEach, describe, expect, it } from 'vitest';

import { ToolDeadlinePolicy } from '../../../../../packages/runtime-protocol/src/toolDeadlinePolicy';
import { loadConfig } from '../../../../../services/sulla-relay/src/config';
import { LateToolResultStore } from '../../../runtime/LateToolResultStore';
import { RelayToolTunnel } from '../../../runtime/relayTunnelClient';

import type { RelayToolResult } from '../../../runtime/relayProtocol';

/** Minimal open socket that records what the tunnel sends back to the relay. */
class RecordingSocket {
  readonly readyState = 1; // WebSocket.OPEN
  readonly sent: any[] = [];
  on(): this { return this }
  send(raw: string): void { this.sent.push(JSON.parse(raw)) }
  close(): void { /* no-op */ }
}

class TunnelHarness {
  readonly socket = new RecordingSocket();
  readonly lateResults = new LateToolResultStore();
  readonly tunnel: RelayToolTunnel;

  constructor(execute: (signal: AbortSignal) => Promise<RelayToolResult>) {
    this.tunnel = new RelayToolTunnel({
      relayUrl:       'http://relay.test',
      deviceToken:    'device-token',
      deviceId:       () => Promise.resolve('device-1'),
      currentUserId:  () => Promise.resolve('user-1'),
      execute:        (_ctx, _category, _tool, _args, signal) => execute(signal),
      operationTypes: () => ['read'],
      lateResults:    this.lateResults,
      createSocket:   () => this.socket as any,
    });
  }

  async connect(): Promise<void> {
    this.tunnel.start();
    // connect() awaits the device id and token before it creates the socket.
    for (let i = 0; i < 50 && !(this.tunnel as any).socket; i++) await new Promise(resolve => setTimeout(resolve, 1));
  }

  call(requestId: string, deadlineInMs: number): Promise<void> {
    return this.tunnel.handleMessage(JSON.stringify({
      type: 'tool-call', action: 'execute', requestId, deviceId: 'device-1',
      ctx: { sub: 'user-1', request_id: requestId }, category: 'github', tool: 'github_list_prs',
      args: { owner: 'o', repo: 'r' }, deadlineAt: Date.now() + deadlineInMs, operationTypes: ['read'],
    }));
  }
}

describe('relayed Desktop tool deadline selection', () => {
  const policy = new ToolDeadlinePolicy();

  it('gives network-bound GitHub reads more than the 15 s local-read deadline', () => {
    // risk: managers blocked by DEADLINE_EXCEEDED on github list_prs/get_pr through the vault broker
    expect(policy.deadlineMs('github_list_prs', ['read'], { category: 'github' })).toBe(60_000);
    expect(policy.deadlineMs('github_get_pr', ['read'], { category: 'github' })).toBe(60_000);
    // Local reads still fail fast.
    expect(policy.deadlineMs('browse_tools', ['read'], { category: 'meta' })).toBe(15_000);
  });

  it('matches name overrides against registered category-prefixed names', () => {
    // risk: sulla-tools passes 'github_ci_logs', which missed the 'ci_logs' override and got 15 s
    expect(policy.deadlineMs('github_ci_logs', ['read'], { category: 'github' })).toBe(120_000);
    expect(policy.deadlineMs('ci_logs', ['read'])).toBe(120_000);
    expect(policy.deadlineMs('github_merge_pr', ['update'], { category: 'github' })).toBe(120_000);
  });

  it('takes the deadline from the tool manifest when one is declared', () => {
    // risk: a tool that waits on a human (ask_user_question, 300 s) is cut at the 15 s read default
    expect(policy.deadlineMs('ask_user_question', ['read'], { category: 'meta', manifestDeadlineMs: 305_000 })).toBe(305_000);
    expect(policy.deadlineMs('anything', ['read'], { manifestDeadlineMs: 99_999_999 })).toBe(policy.maxDeadlineMs);
    expect(policy.deadlineMs('anything', ['read'], { manifestDeadlineMs: 0 })).toBe(15_000);
  });

  it('extends an exec deadline to cover the timeout the caller asked the tool to use', () => {
    // risk: exechost/exec asked for a 10 min install were killed by the 120 s transport deadline
    expect(policy.deadlineMs('exechost', ['execute'], { category: 'meta', args: { command: 'x', timeout: 600_000 } })).toBe(605_000);
    expect(policy.deadlineMs('exechost', ['execute'], { category: 'meta', args: { command: 'x' } })).toBe(120_000);
    // A short tool timeout never shortens the class deadline.
    expect(policy.deadlineMs('exechost', ['execute'], { category: 'meta', args: { timeout: 1_000 } })).toBe(120_000);
    // Garbage and absurd values stay bounded.
    expect(policy.deadlineMs('exec', ['execute'], { args: { timeout: 'soon' } })).toBe(120_000);
    expect(policy.deadlineMs('exec', ['execute'], { args: { timeout: 1e12 } })).toBe(policy.maxDeadlineMs);
  });
});

describe('relay deadline ceiling', () => {
  const saved = { ...process.env };
  afterEach(() => { process.env = { ...saved } });

  it('defaults to the longest deadline the policy hands out instead of 120 s', () => {
    // risk: the relay silently clamped git_clone (30 min) and long exec calls to 120 s
    process.env.SULLA_RELAY_DEVICE_TOKEN_SECRET = 'test-secret';
    process.env.SULLA_RELAY_INTERNAL_TOKEN = 'test-internal';
    delete process.env.SULLA_RELAY_MAX_DEADLINE_MS;
    expect(loadConfig().maxDeadlineMs).toBe(new ToolDeadlinePolicy().maxDeadlineMs);
    expect(loadConfig().maxDeadlineMs).toBeGreaterThanOrEqual(1_800_000);
  });
});

describe('relayed Desktop tool expiry', () => {
  it('returns a clear retryable timeout and keeps the late result instead of dropping it', async() => {
    // risk: a slow GitHub read times out, the caller gets an opaque error and the real result vanishes
    let finish!: (result: RelayToolResult) => void;
    const harness = new TunnelHarness(() => new Promise(resolve => { finish = resolve }));
    await harness.connect();

    await harness.call('req-late', 20);

    const [reply] = harness.socket.sent;
    expect(reply).toMatchObject({ type: 'tool-result', requestId: 'req-late', error: { code: 'DEADLINE_EXCEEDED', retryable: true } });
    expect(reply.error.message).toContain('github/github_list_prs');
    expect(reply.error.message).toContain('retryable');
    expect(reply.error.details).toMatchObject({ tool: 'github_list_prs', retryable: true });
    expect(reply.error.details.sideEffectUnknown).toBeUndefined();

    finish({ success: true, result: 'PR #1' });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(harness.lateResults.get('req-late')).toMatchObject({ outcome: 'success', result: { success: true, result: 'PR #1' } });
    expect(harness.socket.sent).toHaveLength(1);
    harness.tunnel.stop();
  });

  it('delivers a result that arrives before the deadline exactly once', async() => {
    // risk: an in-time result is reported twice or recorded as late
    const harness = new TunnelHarness(() => Promise.resolve({ success: true, result: 'ok' }));
    await harness.connect();

    await harness.call('req-fast', 5_000);

    expect(harness.socket.sent).toEqual([{ type: 'tool-result', requestId: 'req-fast', deviceId: 'device-1', result: { success: true, result: 'ok' } }]);
    expect(harness.lateResults.get('req-fast')).toBeUndefined();
    harness.tunnel.stop();
  });
});
