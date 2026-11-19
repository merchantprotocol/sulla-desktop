// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { afterEach, describe, expect, it, vi } from 'vitest';
import { performance } from 'node:perf_hooks';

import { ToolDeadlinePolicy } from '../../../../../packages/runtime-protocol/src/toolDeadlinePolicy';
import { loadConfig } from '../../../../../services/sulla-relay/src/config';
import { LateToolResultStore } from '../../../runtime/LateToolResultStore';
import { RelayToolTunnel } from '../../../runtime/relayTunnelClient';
import { relayRequestFingerprint } from '../../../runtime/relayProtocol';

import type { RelayToolExecutionContext, RelayToolResult } from '../../../runtime/relayProtocol';

/** Local-only socket seam that can drop and restore the relay connection. */
class RecordingSocket {
  readyState = 0;
  readonly sent: any[] = [];
  private readonly listeners = new Map<string, ((...args: any[]) => void)[]>();
  on(event: string, listener: (...args: any[]) => void): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }
  emit(event: string, ...args: any[]): void { for (const listener of this.listeners.get(event) ?? []) listener(...args) }
  open(): void { this.readyState = 1; this.emit('open') }
  drop(): void { this.readyState = 3; this.emit('close') }
  receive(envelope: unknown): void { this.emit('message', Buffer.from(JSON.stringify(envelope))) }
  send(raw: string): void { this.sent.push(JSON.parse(raw)) }
  close(): void { this.drop() }
}

class TunnelHarness {
  readonly sockets: RecordingSocket[] = [];
  readonly lateResults = new LateToolResultStore();
  readonly tunnel: RelayToolTunnel;

  constructor(execute: (signal: AbortSignal, requestId?: string) => Promise<RelayToolResult>) {
    this.tunnel = new RelayToolTunnel({
      relayUrl:       'http://relay.test',
      deviceToken:    'device-token',
      deviceId:       () => Promise.resolve('device-1'),
      currentUserId:  () => Promise.resolve('user-1'),
      execute:        (ctx, _category, _tool, _args, signal) => execute(signal, ctx.request_id),
      operationTypes: () => ['read'],
      lateResults:    this.lateResults,
      createSocket:   () => {
        const socket = new RecordingSocket();
        this.sockets.push(socket);
        return socket as any;
      },
    });
  }

  async connect(): Promise<void> {
    this.tunnel.start();
    // connect() awaits the device id and token before it creates the socket.
    for (let i = 0; i < 20 && !this.sockets.length; i++) await Promise.resolve();
    this.sockets[0]?.open();
  }

  call(requestId: string, remainingMs: number, operationTypes?: readonly string[]): Promise<void> {
    return this.startCall(requestId, remainingMs, operationTypes).then(({ operation }) => operation);
  }

  async startCall(requestId: string, remainingMs: number, operationTypes?: readonly string[]): Promise<{ operation: Promise<void>; call: any }> {
    const call = await this.offerCall(requestId, remainingMs, operationTypes);
    const operation = this.tunnel.handleMessage(JSON.stringify({ ...call, action: 'execute', remainingMs }));
    return { operation, call };
  }

  async offerCall(requestId: string, remainingMs: number, operationTypes: readonly string[] = ['read']): Promise<any> {
    const ctx: RelayToolExecutionContext = {
      v: 1, iss: 'test', aud: 'sulla-tools', sub: 'user-1', scopes: [],
      iat: 1, exp: 99, jti: `jti-${ requestId }`, request_id: requestId,
    };
    const call = {
      type: 'tool-call', requestId, deviceId: 'device-1', ctx, category: 'github', tool: 'github_list_prs',
      args: { owner: 'o', repo: 'r' }, operationTypes: [...operationTypes],
      requestFingerprint: relayRequestFingerprint({ deviceId: 'device-1', userId: 'user-1', ctx, category: 'github', tool: 'github_list_prs', args: { owner: 'o', repo: 'r' } }),
    };
    await this.tunnel.handleMessage(JSON.stringify({ ...call, action: 'offer', remainingMs }));
    const claim = [...this.socket.sent].reverse().find((item: any) => item.type === 'tool-call-claim' && item.requestId === requestId);
    if (!claim) throw new Error(`Expected a lease claim for ${ requestId }`);
    return call;
  }

  get socket(): RecordingSocket { return this.sockets[0] }
}

/** Records the retained outbox revision at each moment the request's capacity slot is released. */
function watchReleases(harness: TunnelHarness, requestId: string): Array<number | undefined> {
  const tunnel = harness.tunnel as any;
  const releases: Array<number | undefined> = [];
  const calls: Map<string, unknown> = tunnel.calls;
  const remove = calls.delete.bind(calls);
  calls.delete = (key: string) => {
    if (key === requestId && calls.has(key)) releases.push(tunnel.outbox.get(key)?.envelope.resultRevision);
    return remove(key);
  };
  return releases;
}

/** A complete, authenticated tool-call envelope as the relay sends it. */
function offerEnvelope(requestId: string): any {
  const ctx: RelayToolExecutionContext = {
    v: 1, iss: 'test', aud: 'sulla-tools', sub: 'user-1', scopes: [],
    iat: 1, exp: 99, jti: `jti-${ requestId }`, request_id: requestId,
  };
  return {
    type: 'tool-call', requestId, deviceId: 'device-1', ctx, category: 'github', tool: 'github_list_prs',
    args: { owner: 'o', repo: 'r' }, operationTypes: ['read'],
    requestFingerprint: relayRequestFingerprint({ deviceId: 'device-1', userId: 'user-1', ctx, category: 'github', tool: 'github_list_prs', args: { owner: 'o', repo: 'r' } }),
  };
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

    const [reply] = harness.socket.sent.filter(item => item.type === 'tool-result');
    expect(reply).toMatchObject({ type: 'tool-result', requestId: 'req-late', error: { code: 'DEADLINE_EXCEEDED', retryable: true } });
    expect(reply.error.message).toContain('github/github_list_prs');
    expect(reply.error.message).toContain('retryable');
    expect(reply.error.details).toMatchObject({ tool: 'github_list_prs', retryable: true });
    expect(reply.error.details.sideEffectUnknown).toBeUndefined();

    finish({ success: true, result: 'PR #1' });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(harness.lateResults.get('req-late')).toMatchObject({ outcome: 'success', result: { success: true, result: 'PR #1' } });
    const results = harness.socket.sent.filter(item => item.type === 'tool-result');
    expect(results[0]).toMatchObject({ type: 'tool-result', provisional: true });
    expect(results[1]).toMatchObject({ type: 'tool-result', late: true });
    harness.tunnel.stop();
  });

  it('delivers a result that arrives before the deadline exactly once', async() => {
    // risk: an in-time result is reported twice or recorded as late
    const harness = new TunnelHarness(() => Promise.resolve({ success: true, result: 'ok' }));
    await harness.connect();

    await harness.call('req-fast', 5_000);

    expect(harness.socket.sent.filter(item => item.type === 'tool-result')).toMatchObject([
      { requestId: 'req-fast', resultRevision: 1, result: { success: true, result: 'ok' } },
    ]);
    expect(harness.lateResults.get('req-fast')).toBeUndefined();
    harness.tunnel.stop();
  });

  it.each([-30_000, 30_000])('uses the relay relative budget when the Desktop wall clock is offset by %i ms', async(offset) => {
    const harness = new TunnelHarness(() => Promise.resolve({ success: true, result: 'ok' }));
    await harness.connect();
    const wallClock = Date.now;
    const base = wallClock();
    Date.now = () => base + offset;
    try {
      await harness.call(`offset-${ offset }`, 40_000);
      expect(harness.socket.sent.filter(item => item.type === 'tool-result')[0]).toMatchObject({ result: { success: true, result: 'ok' } });
    } finally {
      Date.now = wallClock;
      harness.tunnel.stop();
    }
  });

  it('allows a 40 second bridged read within the relay supplied budget', async() => {
    vi.useFakeTimers();
    let finish!: (result: RelayToolResult) => void;
    const harness = new TunnelHarness(() => new Promise(resolve => { finish = resolve }));
    try {
      await harness.connect();
      let completed = false;
    const operation = harness.call('req-40s', 60_000).then(() => { completed = true });
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(39_999);
      expect(completed).toBe(false);
      finish({ success: true, result: 'read complete' });
      await operation;
      expect(harness.socket.sent.filter(item => item.type === 'tool-result')[0]).toMatchObject({ result: { success: true, result: 'read complete' } });
    } finally {
      harness.tunnel.stop();
      vi.useRealTimers();
    }
  });

  it('does not start a mutation when the relay execution grant arrives after the original lease', async() => {
    const execute = vi.fn(() => Promise.resolve({ success: true, result: 'should not run' }));
    const harness = new TunnelHarness(execute);
    await harness.connect();
    const call = await harness.offerCall('req-expired-grant', 5_000);
    const now = vi.spyOn(performance, 'now');
    const sentAt = now.mock.results[0]?.value ?? performance.now();
    const base = performance.now();
    now.mockReturnValue(base + 6_000);
    try {
      await harness.tunnel.handleMessage(JSON.stringify({ ...call, action: 'execute', remainingMs: 4_000 }));
      expect(execute).not.toHaveBeenCalled();
      expect(harness.socket.sent.filter(item => item.type === 'tool-result')).toMatchObject([
        { requestId: 'req-expired-grant', error: { code: 'DEADLINE_EXCEEDED', details: { sideEffectUnknown: false } } },
      ]);
    } finally {
      now.mockRestore();
      harness.tunnel.stop();
    }
  });

  it('keeps fifty original results in a bounded outbox through reconnect and acknowledges them by request identity', async() => {
    vi.useFakeTimers();
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    const finish = new Map<string, (result: RelayToolResult) => void>();
    const harness = new TunnelHarness((_signal, requestId) => new Promise(resolve => { finish.set(requestId!, resolve) }));
    try {
      await harness.connect();
      const operations = Array.from({ length: 50 }, (_, index) => harness.startCall(`req-${ index }`, 30_000));
      for (let i = 0; i < 20 && finish.size < 50; i++) await Promise.resolve();
      expect(finish.size).toBe(50);
      harness.socket.drop();
      for (let index = 49; index >= 0; index--) finish.get(`req-${ index }`)!({ success: true, result: `original-${ index }` });
      await Promise.all(operations.map(item => item.then(({ operation }) => operation)));
      expect(harness.socket.sent.filter(item => item.type === 'tool-result')).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(20_000);
      const reconnected = harness.sockets[1];
      expect(reconnected).toBeDefined();
      reconnected.open();
      const results = reconnected.sent.filter(item => item.type === 'tool-result');
      expect(results).toHaveLength(50);
      expect(results.map(item => item.requestId)).toEqual(expect.arrayContaining(Array.from({ length: 50 }, (_, index) => `req-${ index }`)));
      for (const item of [...results].reverse()) reconnected.receive({
        type: 'tool-result-ack', requestId: item.requestId, deviceId: item.deviceId,
        requestFingerprint: item.requestFingerprint, resultRevision: item.resultRevision,
      });
      await Promise.resolve();
      expect((harness.tunnel as any).outbox.size).toBe(0);
    } finally {
      harness.tunnel.stop();
      random.mockRestore();
      vi.useRealTimers();
    }
  });

  it('keeps a finished call reserved until its result is retained, so a reconnect offer cannot overbook the 100-result outbox', async() => {
    vi.useFakeTimers();
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    const finish = new Map<string, (result: RelayToolResult) => void>();
    const harness = new TunnelHarness((_signal, requestId) => new Promise(resolve => { finish.set(requestId!, resolve) }));
    const flush = async() => { for (let i = 0; i < 20; i++) await Promise.resolve() };
    try {
      await harness.connect();
      // Socket A: the relay's per-connection limit (100) is fully used by executing calls.
      const operations = Array.from({ length: 100 }, (_, index) => harness.startCall(`req-${ index }`, 30_000));
      await flush();
      expect(finish.size).toBe(100);

      // An unexpected drop: the old calls keep running. The relay's new connection starts with an
      // empty in-flight set, so it may offer new work on socket B.
      harness.socket.drop();
      await vi.advanceTimersByTimeAsync(2_000);
      const socketB = harness.sockets[1];
      socketB.open();
      const fresh = offerEnvelope('req-new');
      await harness.tunnel.handleMessage(JSON.stringify({ ...fresh, action: 'offer', remainingMs: 30_000 }));
      expect(socketB.sent.some(item => item.type === 'tool-call-claim' && item.requestId === 'req-new')).toBe(false);

      // One old call finishes; its result is not acknowledged yet.
      finish.get('req-0')!({ success: true, result: 'original-0' });
      await flush();
      let freshOperation: Promise<void> = Promise.resolve();
      if (socketB.sent.some(item => item.type === 'tool-call-claim' && item.requestId === 'req-new')) {
        // The relay grants the claim it received (handleMessage settles when the call finishes).
        freshOperation = harness.tunnel.handleMessage(JSON.stringify({ ...fresh, action: 'execute', remainingMs: 30_000 }));
        await flush();
      }

      // The relay link drops again before any acknowledgement; every running call finishes.
      socketB.drop();
      for (const [requestId, resolve] of finish) if (requestId !== 'req-0') resolve({ success: true, result: `original-${ requestId }` });
      await Promise.all([...operations.map(item => item.then(({ operation }) => operation)), freshOperation]);
      await flush();

      // Every call that executed keeps its original result; nothing executed beyond retained capacity.
      const outbox = (harness.tunnel as any).outbox as Map<string, any>;
      const executed = [...finish.keys()];
      expect(executed.filter(requestId => !outbox.has(requestId))).toEqual([]);
      expect(outbox.size).toBeLessThanOrEqual(100);
      expect(executed).not.toContain('req-new');

      // After the retained result is acknowledged, the queued offer is claimed normally.
      await vi.advanceTimersByTimeAsync(5_000);
      const socketC = harness.sockets[2];
      socketC.open();
      const r0 = outbox.get('req-0').envelope;
      socketC.receive({ type: 'tool-result-ack', requestId: 'req-0', deviceId: r0.deviceId, requestFingerprint: r0.requestFingerprint, resultRevision: r0.resultRevision });
      await flush();
      expect(socketC.sent.some(item => item.type === 'tool-call-claim' && item.requestId === 'req-new')).toBe(true);
    } finally {
      harness.tunnel.stop();
      random.mockRestore();
      vi.useRealTimers();
    }
  });

  it('turns a 3 MB result into one isolated error and keeps the socket available for other calls', async() => {
    const harness = new TunnelHarness((_signal, requestId) => Promise.resolve({ success: true, result: requestId === 'req-large' ? 'x'.repeat(3 * 1024 * 1024) : 'still alive' }));
    await harness.connect();
    await harness.call('req-large', 30_000);
    await harness.call('req-small', 30_000);
    expect(harness.socket.readyState).toBe(1);
    const results = harness.socket.sent.filter(item => item.type === 'tool-result');
    expect(results[0]).toMatchObject({ requestId: 'req-large', error: { code: 'RESULT_TOO_LARGE' } });
    expect(results[1]).toMatchObject({ requestId: 'req-small', result: { success: true, result: 'still alive' } });
    harness.tunnel.stop();
  });

  it('publishes only the provisional timeout when the deadline aborts a tool that rejects in that turn', async() => {
    // risk: the abort rejection runs before Promise.race resumes, sending terminal revision 2 INTERNAL and then overwriting the outbox with revision 1
    const harness = new TunnelHarness(signal => new Promise((_resolve, reject) => {
      const fail = () => reject(new DOMException('The operation was aborted', 'AbortError'));
      if (signal.aborted) fail();
      else signal.addEventListener('abort', fail, { once: true });
    }));
    await harness.connect();
    try {
      await harness.call('req-abort-reject', 40, ['update']);
      const results = harness.socket.sent.filter(item => item.type === 'tool-result');
      expect(results.map(item => [item.resultRevision, item.error?.code, item.provisional ?? false, item.late ?? false])).toEqual([
        [1, 'DEADLINE_EXCEEDED', true, false],
      ]);
      expect(results[0].error).toMatchObject({
        retryable: true,
        details: { tool: 'github_list_prs', sideEffectUnknown: true, retryable: true },
      });
      expect(results[0].error.message).toContain('deadline exceeded');
      expect(results[0].error.details.hint).toContain('timed out');
      const stored = (harness.tunnel as any).outbox.get('req-abort-reject').envelope;
      expect(stored).toMatchObject({ resultRevision: 1, provisional: true, error: { code: 'DEADLINE_EXCEEDED' } });
      expect(harness.lateResults.get('req-abort-reject')).toBeUndefined();
    } finally {
      harness.tunnel.stop();
    }
  });

  it('publishes the deadline first and keeps a value resolved inside the abort as late revision 2, not on time', async() => {
    // risk: the tool resolves inside the abort listener; reporting it on time hides the timeout, dropping it loses the original outcome
    const harness = new TunnelHarness(signal => new Promise(resolve => {
      const finish = () => resolve({ success: true, result: 'finished-at-abort' });
      if (signal.aborted) finish();
      else signal.addEventListener('abort', finish, { once: true });
    }));
    await harness.connect();
    try {
      const releases = watchReleases(harness, 'req-abort-resolve');
      await harness.call('req-abort-resolve', 40, ['update']);
      await new Promise(resolve => setTimeout(resolve, 0));
      const results = harness.socket.sent.filter(item => item.type === 'tool-result');
      expect(results.map(item => [item.resultRevision, item.provisional ?? false, item.late ?? false])).toEqual([[1, true, false], [2, false, true]]);
      expect(results[0]).toMatchObject({
        requestId: 'req-abort-resolve', error: { code: 'DEADLINE_EXCEEDED', retryable: true, details: { sideEffectUnknown: true, retryable: true } },
      });
      expect(results[0].result).toBeUndefined();
      expect(results[1]).toMatchObject({ result: { success: true, result: 'finished-at-abort' } });
      expect((harness.tunnel as any).outbox.get('req-abort-resolve').envelope).toMatchObject({ resultRevision: 2, late: true, result: { result: 'finished-at-abort' } });
      expect(harness.lateResults.get('req-abort-resolve')).toMatchObject({ outcome: 'success', result: { result: 'finished-at-abort' } });
      // The slot was released only once the late original outcome was retained.
      expect(releases.length).toBeGreaterThan(0);
      expect(releases.every(revision => revision === 2)).toBe(true);
      expect((harness.tunnel as any).calls.has('req-abort-resolve')).toBe(false);
    } finally {
      harness.tunnel.stop();
    }
  });

  it.each([
    ['synchronously inside the abort', (settle: () => void) => settle()],
    ['in a queued microtask after the abort', (settle: () => void) => queueMicrotask(settle)],
    ['two promise hops after the abort', (settle: () => void) => { Promise.resolve().then(() => Promise.resolve()).then(settle) }],
  ])('retains a genuine failure that settles %s as late revision 2 after the deadline', async(_label, schedule) => {
    // risk: a real failure that settles in the abort turn is discarded as if it were cancellation
    const harness = new TunnelHarness(signal => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => schedule(() => reject(new Error('upstream failed during abort'))), { once: true });
    }));
    await harness.connect();
    try {
      const releases = watchReleases(harness, 'req-abort-fail');
      await harness.call('req-abort-fail', 30, ['update']);
      await new Promise(resolve => setTimeout(resolve, 0));
      const results = harness.socket.sent.filter(item => item.type === 'tool-result');
      expect(results.map(item => [item.resultRevision, item.error?.code, item.late ?? false])).toEqual([[1, 'DEADLINE_EXCEEDED', false], [2, 'INTERNAL', true]]);
      expect(results[1].error.message).toBe('upstream failed during abort');
      expect(harness.lateResults.get('req-abort-fail')).toMatchObject({ outcome: 'failure', error: 'upstream failed during abort' });
      expect(releases.every(revision => revision === 2)).toBe(true);
      expect((harness.tunnel as any).calls.has('req-abort-fail')).toBe(false);
    } finally {
      harness.tunnel.stop();
    }
  });

  it.each([
    ['in a queued microtask', (settle: () => void) => queueMicrotask(settle)],
    ['two promise hops later', (settle: () => void) => { Promise.resolve().then(() => Promise.resolve()).then(settle) }],
  ])('retains a value that resolves %s after the abort as late revision 2 exactly once', async(_label, schedule) => {
    const harness = new TunnelHarness(signal => new Promise(resolve => {
      signal.addEventListener('abort', () => schedule(() => resolve({ success: true, result: 'real value' })), { once: true });
    }));
    await harness.connect();
    try {
      await harness.call('req-abort-value', 30, ['update']);
      await new Promise(resolve => setTimeout(resolve, 0));
      const results = harness.socket.sent.filter(item => item.type === 'tool-result');
      expect(results.map(item => [item.resultRevision, item.late ?? false])).toEqual([[1, false], [2, true]]);
      expect(results[1]).toMatchObject({ result: { success: true, result: 'real value' } });
    } finally {
      harness.tunnel.stop();
    }
  });

  it('keeps a genuine post-deadline failure as late revision 2 after the provisional timeout is retained', async() => {
    // risk: filtering deadline cancellations also swallows a real tool failure, or the slot is released before that failure is kept
    let fail!: (error: Error) => void;
    const harness = new TunnelHarness(() => new Promise((_resolve, reject) => { fail = reject }));
    await harness.connect();
    try {
      await harness.call('req-late-error', 30, ['execute']);
      const tunnel = harness.tunnel as any;
      expect(tunnel.calls.has('req-late-error')).toBe(true);
      expect(tunnel.outbox.get('req-late-error').envelope).toMatchObject({
        resultRevision: 1, provisional: true, error: { code: 'DEADLINE_EXCEEDED', details: { sideEffectUnknown: true } },
      });
      fail(new Error('upstream failed'));
      await new Promise(resolve => setTimeout(resolve, 0));
      const results = harness.socket.sent.filter(item => item.type === 'tool-result');
      expect(results.map(item => item.resultRevision)).toEqual([1, 2]);
      expect(results[1]).toMatchObject({ late: true, error: { code: 'INTERNAL', message: 'upstream failed' } });
      expect(tunnel.outbox.get('req-late-error').envelope).toMatchObject({
        resultRevision: 2, late: true, error: { code: 'INTERNAL', message: 'upstream failed' },
      });
      expect(tunnel.calls.has('req-late-error')).toBe(false);
      expect(harness.lateResults.get('req-late-error')).toMatchObject({ outcome: 'failure', error: 'upstream failed' });
    } finally {
      harness.tunnel.stop();
    }
  });

  it('still publishes a post-deadline error whose message mentions abort when it is not an AbortError', async() => {
    // risk: a message heuristic treats a real upstream failure as deadline cancellation and drops it
    let fail!: (error: Error) => void;
    const harness = new TunnelHarness(() => new Promise((_resolve, reject) => { fail = reject }));
    await harness.connect();
    try {
      await harness.call('req-abort-text', 30, ['update']);
      fail(new Error('operation aborted by the upstream api'));
      await new Promise(resolve => setTimeout(resolve, 0));
      const results = harness.socket.sent.filter(item => item.type === 'tool-result');
      expect(results.map(item => [item.resultRevision, item.error?.code])).toEqual([
        [1, 'DEADLINE_EXCEEDED'],
        [2, 'INTERNAL'],
      ]);
      expect(results[1]).toMatchObject({ late: true, error: { message: 'operation aborted by the upstream api' } });
      expect((harness.tunnel as any).outbox.get('req-abort-text').envelope.resultRevision).toBe(2);
    } finally {
      harness.tunnel.stop();
    }
  });

  it.each([
    ['DOMException', (reject: (error: Error) => void) => {
      Promise.resolve().then(() => reject(new DOMException('The operation was aborted', 'AbortError')));
    }],
    ['named AbortError', (reject: (error: Error) => void) => {
      setTimeout(() => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })), 0);
    }],
  ])('keeps the provisional timeout when a deadline abort later rejects with %s', async(_label, rejectLater) => {
    // risk: the cancellation is published as a second INTERNAL failure and replaces the retryable timeout
    const harness = new TunnelHarness(signal => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => rejectLater(reject), { once: true });
    }));
    await harness.connect();
    try {
      await harness.call(`req-${ _label }`, 30, ['update']);
      await new Promise(resolve => setTimeout(resolve, 20));
      const results = harness.socket.sent.filter(item => item.type === 'tool-result');
      expect(results.map(item => [item.resultRevision, item.error?.code, item.provisional ?? false])).toEqual([
        [1, 'DEADLINE_EXCEEDED', true],
      ]);
      expect(results[0].error.details).toMatchObject({ sideEffectUnknown: true, retryable: true });
      expect(results[0].error.details.hint).toContain('timed out');
      const tunnel = harness.tunnel as any;
      expect(tunnel.outbox.get(`req-${ _label }`).envelope).toMatchObject({
        resultRevision: 1, provisional: true, error: { code: 'DEADLINE_EXCEEDED' },
      });
      expect(tunnel.calls.has(`req-${ _label }`)).toBe(false);
      expect(harness.lateResults.get(`req-${ _label }`)).toBeUndefined();
    } finally {
      harness.tunnel.stop();
    }
  });

  it('never moves an outbox result revision backward and still acknowledges the newest matching revision', async() => {
    // risk: a duplicate or reordered publication replaces a late final result with an older timeout, and the ack then drops the original
    const harness = new TunnelHarness(() => Promise.resolve({ success: true, result: 'unused' }));
    await harness.connect();
    try {
      const fingerprint = 'ab'.repeat(32);
      const base = { type: 'tool-result', requestId: 'req-rev', deviceId: 'device-1', requestFingerprint: fingerprint };
      const enqueue = (envelope: Record<string, unknown>) => (harness.tunnel as any).enqueueResult({ ...base, ...envelope });
      enqueue({ resultRevision: 1, provisional: true, error: { code: 'DEADLINE_EXCEEDED', message: 'timeout', retryable: true } });
      enqueue({ resultRevision: 2, late: true, result: { success: true, result: 'final' } });
      enqueue({ resultRevision: 1, result: { success: true, result: 'stale' } });
      enqueue({ result: { success: true, result: 'default-revision' } });
      const revisions = harness.socket.sent.filter(item => item.type === 'tool-result').map(item => item.resultRevision);
      expect(revisions).toEqual([1, 2]);
      const tunnel = harness.tunnel as any;
      const stored = tunnel.outbox.get('req-rev');
      expect(stored.envelope).toMatchObject({ resultRevision: 2, late: true, result: { success: true, result: 'final' } });
      expect(tunnel.outbox.size).toBe(1);
      expect(tunnel.outboxBytes).toBe(stored.bytes);
      const ack = (resultRevision: number) => harness.socket.receive({
        type: 'tool-result-ack', requestId: 'req-rev', deviceId: 'device-1', requestFingerprint: fingerprint, resultRevision,
      });
      ack(1);
      expect(tunnel.outbox.has('req-rev')).toBe(true);
      expect(tunnel.outbox.get('req-rev').envelope).toMatchObject({ resultRevision: 2, result: { result: 'final' } });
      expect(tunnel.outboxBytes).toBe(stored.bytes);
      ack(2);
      expect(tunnel.outbox.has('req-rev')).toBe(false);
      expect(tunnel.outboxBytes).toBe(0);
    } finally {
      harness.tunnel.stop();
    }
  });
});
