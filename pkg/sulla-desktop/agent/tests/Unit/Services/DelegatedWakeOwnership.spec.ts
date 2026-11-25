// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import '../../Support/TestHomeEnv';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentJobFailureLogger } from '../../../app/Services/AgentJobFailureLogger';
import { CompletionKey } from '../../../app/Services/CompletionKey';
import { DeferredStallInput } from '../../../app/Services/DeferredStallInput';
import { DelegatedCompletionHandoff } from '../../../app/Services/DelegatedCompletionHandoff';
import { CompletionInboxStore } from '../../../services/AgentCompletionInbox';
import { AgentJobLifecycleService } from '../../../services/AgentJobLifecycleService';
import { DelegatedFreshTurnRunner, type DelegatedFreshTurnPorts } from '../../../services/DelegatedFreshTurnRunner';
import { DelegatedWakeRepairNotice } from '../../../services/DelegatedWakeRepairNotice';
import { ThreadGraphCache } from '../../../services/ThreadGraphCache';
import { TurnOutputCounter } from '../../../services/TurnOutputCounter';
import { injectSteer, markSteerPending, onSteer } from '../../../utils/steerChannel';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp', getVersion: () => 'test', isPackaged: false }, safeStorage: {} }));
const taskThread = 'parked-worker';
const noop = () => Promise.resolve(undefined);
const timer = () => ({ role: 'user' as const, content: 'timer', metadata: { source: 'agent_wait_timer', wakeId: 'timer-1' } });

function harness() {
  const state: any = { metadata: { cycleComplete: true }, messages: [] };
  const task = { status: 'running', emptyWakeCount: 0, waitReason: '', wakeAt: 0 };
  const abort = new AbortController();
  const lifecycle = new AgentJobLifecycleService({ openChildrenForThread: () => Promise.resolve(1) }, () => Promise.resolve(task.status = 'parked'), () => Promise.resolve(task.status = 'running'));
  const inbox = new CompletionInboxStore();
  const rootNotice = new DelegatedWakeRepairNotice(thread => Promise.resolve(({
    [taskThread]: { parentThreadId: 'manager', parentChannel: 'manager-channel' },
    manager:      { parentThreadId: 'po', parentChannel: 'po-channel' },
  } as Record<string, { parentThreadId: string; parentChannel: string }>)[thread]), inbox);
  const execute = vi.fn(() => {
    DeferredStallInput.settledInputs(state, DeferredStallInput.actionableMessages(state));
    new TurnOutputCounter(state.metadata).recordToken('reply');
    return Promise.resolve(state);
  });
  const lines: string[] = [];
  const logger = new AgentJobFailureLogger({ error: line => { lines.push(line) } });
  const ports: DelegatedFreshTurnPorts = {
    jobId:                  'worker-job',
    taskIndex:              0,
    threadId:               taskThread,
    state,
    signal:                 abort.signal,
    prepare:                () => {},
    execute,
    getJob:                 () => Promise.resolve({ tasks: [task] }),
    returnedTask:           noop,
    pendingWait:            noop,
    openChildren:           id => lifecycle.openChildren(id),
    updateJobTask:          (_job, _index, patch) => Promise.resolve(Object.assign(task, patch)),
    endWakeTurn:            (...args) => lifecycle.endWakeTurn(...args),
    resume:                 (...args) => lifecycle.resume(...args),
    waitForWake:            (...args) => lifecycle.waitForWake(...args),
    rerouteCompletions:     noop,
    acknowledgeCompletions: noop,
    alertRoot:              (deadline, missing) => rootNotice.send('worker-job', 0, taskThread, deadline, missing),
    repairInput:            noop,
    logWake:                facts => logger.wake({ ...facts, ...lifecycle.wakeFacts(taskThread, state, facts.cacheHit) }),
  };
  const run = () => lifecycle.withRunner(taskThread, state, () => new DelegatedFreshTurnRunner(ports).run(state));
  return { state, task, abort, lifecycle, ports, run, execute, inbox, lines };
}

afterEach(() => { vi.useRealTimers() });

describe('live delegated wake ownership', () => {
  it('rechecks queued work at the first deadline without spending a provider call or a strike on missing input', async() => {
    vi.useFakeTimers();
    const h = harness();
    h.ports.repairInput = () => { h.lifecycle.deliver(taskThread, timer()); return noop() };
    const run = h.run();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.task).toMatchObject({ status: 'parked', emptyWakeCount: 0 });
    await vi.advanceTimersByTimeAsync(1);
    await run;
    expect(h.execute).toHaveBeenCalledTimes(1);
    expect(h.state.messages).toHaveLength(1);
    expect(h.task).toMatchObject({ status: 'running', emptyWakeCount: 0 });
    expect(h.inbox.pendingCount()).toBe(0);
  });

  it('parks after exactly three repair deadlines, alerts the root (not the manager) once and accepts later input', async() => {
    vi.useFakeTimers();
    const h = harness();
    const repairs: number[] = [];
    const started = Date.now();
    h.ports.repairInput = () => { repairs.push(Date.now() - started); return noop() };
    const run = h.run();
    await vi.advanceTimersByTimeAsync(180_000);
    const alert = h.inbox.take('po-channel', 'po');
    expect(alert).toHaveLength(1);
    expect(CompletionKey.isTaskCompletion(alert[0])).toBe(false);
    expect(h.task).toMatchObject({ status: 'parked', emptyWakeCount: 0, waitReason: expect.stringContaining('exhausted') });
    expect(h.task.wakeAt).toBeGreaterThan(Date.now());
    expect(h.inbox.take('manager-channel', 'manager')).toEqual([]);
    h.lifecycle.wake(taskThread); // a second empty release in the same episode, even after the alert was taken
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(repairs).toEqual([30_000, 90_000, 180_000]);
    expect(h.inbox.pendingCount()).toBe(0);
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.lifecycle.hasLiveWaiter(taskThread)).toBe(true);
    h.lifecycle.deliver(taskThread, timer());
    await run;
    expect(h.execute).toHaveBeenCalledTimes(1);
  });

  it('retries a failed alert on a bounded timer with the same episode deadline', async() => {
    vi.useFakeTimers();
    const h = harness();
    const alert = vi.fn(h.ports.alertRoot).mockRejectedValueOnce(new Error('ancestry unavailable'));
    h.ports.alertRoot = alert;
    const run = h.run();
    try {
      await vi.advanceTimersByTimeAsync(209_999);
      expect(alert).toHaveBeenCalledTimes(1);
      expect(h.inbox.pendingCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(alert).toHaveBeenCalledTimes(2);
      expect(alert.mock.calls[0][0]).toBe(alert.mock.calls[1][0]);
      expect(h.inbox.take('po-channel', 'po')).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(600_000);
      expect(alert).toHaveBeenCalledTimes(2);
      expect(h.execute).not.toHaveBeenCalled();
    } finally { h.abort.abort(); await run }
  });

  it('suppresses an obsolete alert when input arrives during ancestry lookup', async() => {
    vi.useFakeTimers();
    const h = harness();
    let finish!: () => void;
    const lookup = new Promise<undefined>(resolve => { finish = () => resolve(undefined) });
    const notice = new DelegatedWakeRepairNotice(id => id === taskThread
      ? Promise.resolve({ parentThreadId: 'po' })
      : lookup, h.inbox);
    h.ports.alertRoot = (deadline, missing) => notice.send('job', 0, taskThread, deadline, missing);
    const run = h.run();
    await vi.advanceTimersByTimeAsync(180_000);
    h.lifecycle.deliver(taskThread, timer());
    finish();
    await run;
    expect(h.inbox.pendingCount()).toBe(0);
    expect(h.execute).toHaveBeenCalledOnce();
  });

  it.each(['task stop', 'runtime drain'])('releases an evicted parked runner on %s without a zombie or provider call', async(reason) => {
    vi.useFakeTimers();
    const h = harness();
    h.state.metadata.options = { abort: h.abort };
    const publishCompletion = vi.fn();
    const writeTerminal = vi.fn();
    const settled = h.run().then(writeTerminal).then(publishCompletion);
    const outcome = settled.catch(error => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.lifecycle.hasLiveWaiter(taskThread)).toBe(true);
    if (reason === 'task stop') h.abort.abort();
    else h.lifecycle.interruptRunners();
    if (reason === 'runtime drain') {
      expect(await outcome).toMatchObject({ runtimeInterrupted: true });
      expect(writeTerminal).not.toHaveBeenCalled();
      expect(publishCompletion).not.toHaveBeenCalled();
    } else await settled;
    expect(h.lifecycle.liveState(taskThread)).toBeUndefined();
    expect(h.lifecycle.hasLiveWaiter(taskThread)).toBe(false);
    expect(h.lifecycle.deliver(taskThread, timer())).toBe(false);
    expect(h.execute).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['timer first', 'child first'])('keeps both ingress events in order under capacity eviction (%s)', async(order) => {
    const h = harness();
    const cache = new ThreadGraphCache(noop, () => false, () => 1);
    try {
      await h.lifecycle.withRunner(taskThread, h.state, async() => {
        cache.set(taskThread, { graph: {} as any, state: h.state });
        for (let n = 0; n < 15; n++) cache.set(String(n), { graph: {} as any, state: structuredClone(h.state) });
        await cache.evictIdle();
        expect(cache.has(taskThread)).toBe(false);
        const parked = h.lifecycle.waitForWake(taskThread, h.abort.signal);
        const handoff = new DelegatedCompletionHandoff(h.inbox, h.lifecycle, { firstDelivered: noop, acknowledge: noop }, injectSteer, () => 'child-msg');
        h.inbox.enqueue('channel', taskThread, { jobId: 'child', taskIndex: 0, results: [] });
        const child = () => handoff.deliver('channel', taskThread, () => cache.get(taskThread)?.state);
        const deliver = () => Promise.resolve(h.lifecycle.deliver(taskThread, timer()));
        await Promise.all(order === 'child first' ? [child(), deliver()] : [deliver(), child()]);
        await parked;
        expect(h.state.messages.map((m: any) => m.metadata.source)).toEqual(order === 'child first'
          ? ['sub_agent_completion', 'agent_wait_timer']
          : ['agent_wait_timer', 'sub_agent_completion']);
        expect(await h.lifecycle.withRunner(taskThread, h.state, () => Promise.resolve(true)).catch(() => false)).toBe(false);
        await new DelegatedFreshTurnRunner(h.ports).run(h.state);
        // Replaying the same external ID never re-appends or makes another model call.
        expect(await deliver()).toBe(true);
        expect(h.state.messages).toHaveLength(2);
        expect(h.execute).toHaveBeenCalledTimes(1);
        const nextPark = h.lifecycle.waitForWake(taskThread, h.abort.signal);
        try {
          expect(h.lifecycle.hasLiveWaiter(taskThread)).toBe(true);
          expect(h.inbox.pendingCount()).toBe(0);
        } finally {
          h.abort.abort();
          await nextPark;
        }
      });
      expect(h.lifecycle.liveState(taskThread)).toBeUndefined();
      expect(cache.size).toBeLessThanOrEqual(12);
    } finally { cache.clear() }
  });

  it('admits input before wait installation even beyond the legacy wake TTL; leaves a later arrival pending', async() => {
    vi.useFakeTimers();
    const h = harness();
    await h.lifecycle.withRunner(taskThread, h.state, async() => {
      h.lifecycle.deliver(taskThread, timer());
      await vi.advanceTimersByTimeAsync(300_001);
      const guard = new AbortController();
      const wait = h.lifecycle.waitForWake(taskThread, guard.signal);
      try { expect(h.lifecycle.hasLiveWaiter(taskThread)).toBe(false) } finally { guard.abort(); await wait }
      h.ports.execute = async() => {
        await h.execute();
        h.lifecycle.deliver(taskThread, { ...timer(), metadata: { wakeId: 'later' } });
        return h.state;
      };
      await new DelegatedFreshTurnRunner(h.ports).run(h.state);
      expect(DeferredStallInput.actionableMessages(h.state).map(m => m.metadata?.wakeId)).toEqual(['later']);
    });
  });

  it.each([true, false])('only a handed-back CLI steer admits another turn: handback=%s', async(handback) => {
    vi.useFakeTimers();
    const h = harness();
    const message = timer();
    const off = onSteer(h.state, () => true);
    try { expect(injectSteer(h.state, message)).toBe(true) } finally { off() }
    if (handback) markSteerPending(message, h.state);
    const run = h.run();
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(h.execute).toHaveBeenCalledTimes(handback ? 1 : 0);
    } finally { h.abort.abort(); await run }
  });

  it('logs cache hit and miss independently of the live owner without refreshing the cache', async() => {
    vi.useFakeTimers();
    const h = harness();
    const cache = new ThreadGraphCache(noop, () => false, () => Date.now(), 10);
    const { GraphRegistry } = await import('../../../services/GraphRegistry');
    const sample = vi.spyOn(GraphRegistry, 'containsState').mockImplementation((id, recipient) => cache.containsState(id, recipient));
    try {
      await h.lifecycle.withRunner(taskThread, h.state, async() => {
        cache.set(taskThread, { graph: {} as any, state: h.state });
        await vi.advanceTimersByTimeAsync(9);
        h.lifecycle.deliver(taskThread, timer());
        await vi.advanceTimersByTimeAsync(2);
        await cache.evictIdle();
        expect(cache.has(taskThread)).toBe(false);
        h.ports.execute = () => Promise.reject(new Error('provider unavailable'));
        const fresh = new DelegatedFreshTurnRunner(h.ports);
        await expect(fresh.run(h.state)).rejects.toThrow();
        h.lifecycle.deliver(taskThread, { ...timer(), metadata: { wakeId: 'miss' } });
        await expect(fresh.run(h.state)).rejects.toThrow();
        const facts = h.lines.map(line => JSON.parse(line.slice(line.indexOf('{'))));
        expect(facts.map(f => [f.graphCache, f.cacheHit])).toEqual([['live_runner', true], ['live_runner', false]]);
      });
    } finally { sample.mockRestore(); cache.clear() }
  });

  it.each([['agent_inbox', 'agent_inbox'], ['PRIVATE_SENTINEL_NOT_FOR_LOGS', 'unknown_wake']])(
    'logs the safe source for a failed wake from %s without exposing input or IDs', async(source, expected) => {
      const h = harness();
      const sentinel = 'PRIVATE_SENTINEL_NOT_FOR_LOGS';
      DeferredStallInput.appendActionable(h.state, { role: 'user', content: sentinel, metadata: { source, wakeId: sentinel } });
      h.ports.execute = () => {
        h.state.metadata.delegatedProviderDispatchCount = 1;
        return Promise.reject(new Error(sentinel));
      };
      await expect(h.run()).rejects.toThrow('Delegated wake execution failed');
      expect(h.lines).toHaveLength(1);
      expect(h.lines.join('')).not.toContain(sentinel);
      expect(JSON.parse(h.lines[0].slice(h.lines[0].indexOf('{')))).toMatchObject({
        wakeId:             expect.stringMatching(/^[0-9a-f]{16}$/),
        source:             expected,
        attempt:            1,
        graphCache:         'live_runner',
        cacheHit:           false,
        providerDispatched: true,
        liveChildCount:     1,
      });
      expect(h.lifecycle.liveState(taskThread)).toBeUndefined();
    });
});
