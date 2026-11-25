// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import '../../Support/TestHomeEnv';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { DeferredStallInput } from '../../../app/Services/DeferredStallInput';
import { clearCompletionInboxes, enqueueAgentCompletion, registerCompletionIdleDispatcher } from '../../../services/AgentCompletionInbox';
import { agentJobLifecycle } from '../../../services/AgentJobLifecycleService';
import { AgentWakeScheduler } from '../../../services/AgentWakeScheduler';
import { BackendGraphWebSocketService } from '../../../services/BackendGraphWebSocketService';
import { DelegatedFreshTurnRunner } from '../../../services/DelegatedFreshTurnRunner';
import { GraphRegistry } from '../../../services/GraphRegistry';
import { parkedAgentRehydrator } from '../../../services/ParkedAgentRehydrator';
import { ThreadGraphCache } from '../../../services/ThreadGraphCache';
import { TurnOutputCounter } from '../../../services/TurnOutputCounter';

import type { AgentTaskWait } from '../../../app/Repositories/AgentTaskWaitRepository';

vi.mock('electron', () => ({
  app:         { getPath: () => '/tmp', getVersion: () => '0.0.0-test', isPackaged: false },
  safeStorage: {},
}));

vi.mock('../../../services/AgentExecutionReadiness', () => ({
  agentExecutionReadiness:        { active: true, draining: false, wait: () => Promise.resolve() },
  executionAbort:                 () => Object.assign(new Error('Agent execution interrupted'), { name: 'AbortError' }),
  waitForAutomaticAgentExecution: () => Promise.resolve(),
}));

/** In-memory durable wait repository: the database boundary, not the scheduler, is faked. */
class MemoryWaitRepository {
  readonly retries: number[] = [];

  constructor(public row: AgentTaskWait) {}

  scheduled(): Promise<AgentTaskWait[]> {
    return Promise.resolve(this.row.state === 'scheduled' ? [this.row] : []);
  }

  claim(): Promise<AgentTaskWait | null> {
    if (this.row.state !== 'scheduled') return Promise.resolve(null);
    this.row = { ...this.row, state: 'claimed' };
    return Promise.resolve(this.row);
  }

  release(_jobId: string, _taskIndex: number, wakeAt: Date): Promise<AgentTaskWait | null> {
    if (this.row.state !== 'claimed') return Promise.resolve(null);
    this.retries.push(wakeAt.getTime());
    this.row = { ...this.row, state: 'scheduled', wakeAt };
    return Promise.resolve(this.row);
  }

  complete(): Promise<boolean> {
    this.row = { ...this.row, state: 'cancelled' };
    return Promise.resolve(true);
  }

  cancel(): Promise<boolean> {
    this.row = { ...this.row, state: 'cancelled' };
    return Promise.resolve(true);
  }
}

const flushMicrotasks = async() => {
  for (let turn = 0; turn < 30; turn++) await Promise.resolve();
};

describe('delegated timer wake after graph-cache eviction', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each(['timer first after TTL', 'child first under cache pressure'])('handles both inputs once on the original thread: %s', async(order) => {
    // W11/R14: this fixture uses the old public waiter, scheduler, wakeParkedAgent
    // and fresh-turn entry points. It intentionally does not manually drain the
    // mailbox or call round-specific owner-registration APIs.
    vi.useFakeTimers();
    const startedAt = new Date('2026-11-24T17:00:00.000Z').getTime();
    vi.setSystemTime(startedAt);

    const childFirst = order.startsWith('child');
    const threadId = childFirst ? 'lost-wake-pressure' : 'lost-wake-ttl';
    const state: any = {
      messages: [
        { role: 'user', content: 'coordinate one live child' },
        { role: 'assistant', content: 'waiting on the child and timer' },
      ],
      metadata: { cycleComplete: true, waitingForUser: false, threadId, delegatedJobId: 'lost-wake-job' },
    };
    const cache = new ThreadGraphCache(async() => {}, () => false, () => Date.now());
    cache.set(threadId, { graph: {} as any, state });
    vi.spyOn(GraphRegistry, 'get').mockImplementation(id => cache.get(id) ?? null);

    const job: any = { status: 'parked', tasks: [{ status: 'parked', emptyWakeCount: 0 }] };
    const identity: any = {
      job,
      task:            { status: 'parked', threadId, agentId: 'coding-manager' },
      taskIndex:       0,
      agentId:         'coding-manager',
      modelPrecedence: {},
    };
    vi.spyOn(parkedAgentRehydrator, 'resolve').mockImplementation(() => Promise.resolve(job.status === 'failed' ? null : identity));
    vi.spyOn(agentJobLifecycle, 'openChildren').mockResolvedValue(1);

    const controller = new AbortController();
    const receivedTimerThreads: string[] = [];
    const receivedChildJobs: string[] = [];
    const acknowledgedChildren: string[] = [];
    let substantiveTurns = 0;
    let providerCalls = 0;
    let failure: unknown;
    const ports: any = {
      jobId: 'lost-wake-job',
      taskIndex: 0,
      threadId,
      state,
      signal: controller.signal,
      prepare: () => {},
      execute: () => {
        providerCalls++;
        state.metadata.delegatedProviderDispatchCount = providerCalls;
        const timer = DeferredStallInput.actionableMessages(state).find(message => message.metadata?.source === 'agent_wait_timer');
        const child = state.messages.find((message: any) => message.metadata?.source === 'sub_agent_completion');
        if (timer && child) {
          receivedTimerThreads.push(threadId);
          receivedChildJobs.push(...(child.metadata?.completionEntries ?? []).map((entry: any) => entry.jobId));
          substantiveTurns++;
          DeferredStallInput.settledInputs(state, [timer]);
          new TurnOutputCounter(state.metadata).recordToken('timer wake handled');
          state.messages.push({ role: 'assistant', content: 'handled timer wake' });
        }
        return Promise.resolve(state);
      },
      returnedTask: () => Promise.resolve(undefined),
      getJob: () => Promise.resolve(job),
      openChildren: () => Promise.resolve(1),
      pendingWait: () => Promise.resolve(undefined),
      updateJobTask: (_id: string, index: number, patch: any) => Promise.resolve(Object.assign(job.tasks[index], patch)),
      endWakeTurn: async() => {},
      waitForWake: (id: string, signal?: AbortSignal) => agentJobLifecycle.waitForWake(id, signal),
      resume: async() => {},
      rerouteCompletions: async() => {},
      acknowledgeCompletions: async() => {},
    };
    ports.acknowledgeCompletions = (entries: any[]) => { acknowledgedChildren.push(...entries.map(entry => entry.jobId)); return Promise.resolve() };
    const runner = new DelegatedFreshTurnRunner(ports);
    // The baseline predates owner registration; the same parked waiter and
    // both production senders are exercised there without a shimmed receipt.
    const releaseOwner = agentJobLifecycle.registerRunner?.(threadId, state);
    const initialWait = agentJobLifecycle.waitForWake(threadId, controller.signal);
    let releaseRunner!: () => void;
    const runnerBarrier = new Promise<void>(resolve => { releaseRunner = resolve });
    const run = initialWait.then(async() => {
      await runnerBarrier;
      return runner.run(state);
    }).catch(error => {
      failure = error;
      job.status = 'failed'; // spawn_agent's failure edge; keep runner logic real
    });
    await flushMicrotasks();
    expect(agentJobLifecycle.hasLiveWaiter(threadId)).toBe(true);

    const repository = new MemoryWaitRepository({
      jobId: 'lost-wake-job',
      taskIndex: 0,
      wakeAt: new Date(startedAt + 20 * 60_000),
      reason: '20-minute external review',
      state: 'scheduled',
    });
    const backend = Object.create(BackendGraphWebSocketService.prototype);
    backend.activeAborts = new Map();
    backend.recoveryAbort = new AbortController();
    backend.dispatchToAgent = vi.fn(() => Promise.resolve('deferred'));
    vi.spyOn(parkedAgentRehydrator, 'isTerminalDelegatedThread').mockResolvedValue(false);
    registerCompletionIdleDispatcher((channel, target) => backend.handleCompletionWake(channel, target));
    const childReturns = () => enqueueAgentCompletion('sulla-desktop', threadId, {
      jobId: 'lost-wake-child',
      taskIndex: 0,
      results: [{ label: 'worker', status: 'completed', output: 'child result', threadId: 'lost-wake-child-thread' }],
    });
    const firedOffsets: number[] = [];
    const scheduler = new AgentWakeScheduler(repository as any, (wait, wakeId, attempt) => {
      firedOffsets.push(Date.now() - startedAt);
      return backend.wakeParkedAgent('sulla-desktop', threadId, `[Wait complete]\n${ wait.reason }`, 'coding-manager', {
        source: 'agent_wait_timer', wakeId, wakeAttempt: attempt,
      });
    }, () => Date.now());
    await scheduler.start();

    try {
      if (childFirst) {
        for (let n = 0; n < 14; n++) cache.set(`idle-${ n }`, { graph: {} as any, state: structuredClone(state) });
        await cache.evictIdle();
        expect(cache.has(threadId)).toBe(false); // capacity, before TTL
        expect(cache.size).toBeLessThanOrEqual(12);
      }
      await vi.advanceTimersByTimeAsync(16 * 60_000);
      await cache.evictIdle();
      expect(cache.has(threadId)).toBe(false);

      // Advance the whole fixed observation horizon before awaiting the run:
      // the accepted behavior fires only the original wake; the broken path
      // remains observable through the actual +30/+60/+90 repair deadlines.
      if (childFirst) {
        childReturns();
        await flushMicrotasks();
      }
      await vi.advanceTimersByTimeAsync(4 * 60_000);
      await flushMicrotasks();
      if (!childFirst) childReturns();
      await flushMicrotasks();
      releaseRunner();
      await flushMicrotasks();
      for (const retryDelay of [30_000, 60_000, 90_000]) {
        await vi.advanceTimersByTimeAsync(retryDelay);
        await flushMicrotasks();
      }

      const outcome = {
        bothInputsConsumedOnOriginalThread: receivedTimerThreads.length === 1 && receivedTimerThreads[0] === threadId &&
          receivedChildJobs.length === 1 && receivedChildJobs[0] === 'lost-wake-child',
        substantiveTurns,
        emptyWakeCount: job.tasks[0].emptyWakeCount,
        jobFailed: job.status === 'failed',
        firedOffsetsMs: firedOffsets,
        scheduledRetryOffsetsMs: repository.retries.map(deadline => deadline - startedAt),
        scheduledRetryDeadlineMs: repository.row.state === 'scheduled' ? repository.row.wakeAt.getTime() - startedAt : null,
        failure: failure instanceof Error ? failure.message : null,
        providerCalls,
        acknowledgedChildren,
      };
      expect(outcome).toEqual({
        bothInputsConsumedOnOriginalThread: true,
        substantiveTurns: 1,
        emptyWakeCount: 0,
        jobFailed: false,
        firedOffsetsMs: [20 * 60_000],
        scheduledRetryOffsetsMs: [],
        scheduledRetryDeadlineMs: null,
        failure: null,
        providerCalls: 1,
        acknowledgedChildren: ['lost-wake-child'],
      });
    } finally {
      releaseRunner();
      controller.abort();
      scheduler.stop();
      cache.clear();
      await flushMicrotasks();
      await run;
      releaseOwner?.();
      clearCompletionInboxes();
    }
  });
});
