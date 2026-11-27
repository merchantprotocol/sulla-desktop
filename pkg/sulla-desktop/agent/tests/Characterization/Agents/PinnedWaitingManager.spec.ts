// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import '../../Support/TestHomeEnv';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { DeferredStallInput } from '../../../app/Services/DeferredStallInput';
import { agentJobLifecycle } from '../../../services/AgentJobLifecycleService';
import { AgentOrchestratorMessageFormatter } from '../../../services/AgentOrchestratorMessageFormatter';
import { AgentWakeScheduler } from '../../../services/AgentWakeScheduler';
import { BackendGraphWebSocketService } from '../../../services/BackendGraphWebSocketService';
import { DelegatedFreshTurnRunner, type DelegatedFreshTurnPorts } from '../../../services/DelegatedFreshTurnRunner';
import { GraphRegistry } from '../../../services/GraphRegistry';
import { parkedAgentRehydrator } from '../../../services/ParkedAgentRehydrator';
import { ThreadGraphCache } from '../../../services/ThreadGraphCache';
import { TurnOutputCounter } from '../../../services/TurnOutputCounter';

import type { AgentTaskWait, AgentTaskWaitRepository } from '../../../app/Repositories/AgentTaskWaitRepository';

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
class MemoryWaitRepository implements Pick<AgentTaskWaitRepository, 'scheduled' | 'claim' | 'release'> {
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
}

describe('pinned waiting manager', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each([0, 14])('delivers a 1,200-second wait to the original runner with %i other idle graphs', async(idleCount) => {
    vi.useFakeTimers();
    const startedAt = new Date('2026-11-24T17:00:00.000Z').getTime();
    vi.setSystemTime(startedAt);

    const threadId = `pin-wait-${ idleCount }`;
    const state: any = {
      messages: [
        { role: 'user', content: 'coordinate one live child' },
        { role: 'assistant', content: 'waiting on the child and timer' },
      ],
      metadata: { cycleComplete: true, waitingForUser: false, threadId, delegatedJobId: 'lost-wake-job', runtimeRunnerActive: true },
    };
    const checkpoints: string[] = [];
    const cache = new ThreadGraphCache(snapshot => {
      checkpoints.push(snapshot.metadata.threadId);
      return Promise.resolve();
    }, () => false, () => Date.now());
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

    const controller = new AbortController();
    let consumedTimers = 0;
    let substantiveTurns = 0;
    let providerCalls = 0;
    let failure: unknown;
    const ports: DelegatedFreshTurnPorts = {
      jobId:     'lost-wake-job',
      taskIndex: 0,
      threadId,
      state,
      signal:    controller.signal,
      prepare:   () => {},
      execute:   () => {
        providerCalls++;
        const timers = DeferredStallInput.actionableMessages(state).filter(message => message.metadata?.source === 'agent_wait_timer');
        if (timers.length) {
          consumedTimers += timers.length;
          substantiveTurns++;
          DeferredStallInput.settledInputs(state, timers);
          new TurnOutputCounter(state.metadata).recordToken('timer wake handled');
          state.messages.push({ role: 'assistant', content: 'handled timer wake' });
        }
        return Promise.resolve(state);
      },
      returnedTask:           () => Promise.resolve(undefined),
      getJob:                 () => Promise.resolve(job),
      openChildren:           () => Promise.resolve(1),
      pendingWait:            () => Promise.resolve(undefined),
      updateJobTask:          (_id: string, index: number, patch: any) => Promise.resolve(Object.assign(job.tasks[index], patch)),
      endWakeTurn:            async() => {},
      waitForWake:            (id: string, signal?: AbortSignal) => agentJobLifecycle.waitForWake(id, signal),
      resume:                 async() => {},
      rerouteCompletions:     async() => {},
      acknowledgeCompletions: async() => {},
    };
    const runner = new DelegatedFreshTurnRunner(ports);
    const run = agentJobLifecycle.waitForWake(threadId, controller.signal).then(() => {
      if (!controller.signal.aborted) return runner.run(state);
    }).catch(error => {
      failure = error;
      job.status = 'failed'; // spawn_agent's failure edge; keep runner logic real
    });
    expect(agentJobLifecycle.hasLiveWaiter(threadId)).toBe(true);

    const repository = new MemoryWaitRepository({
      jobId:     'lost-wake-job',
      taskIndex: 0,
      wakeAt:    new Date(startedAt + 20 * 60_000),
      reason:    '20-minute external review',
      state:     'scheduled',
    });
    const backend = Object.create(BackendGraphWebSocketService.prototype);
    backend.orchestratorMessageFormatter = new AgentOrchestratorMessageFormatter();
    backend.activeAborts = new Map();
    backend.recoveryAbort = new AbortController();
    backend.dispatchToAgent = vi.fn(() => Promise.resolve('deferred'));
    const firedOffsets: number[] = [];
    const scheduler = new AgentWakeScheduler(repository as unknown as AgentTaskWaitRepository, wait => {
      firedOffsets.push(Date.now() - startedAt);
      return backend.wakeParkedAgent('sulla-desktop', threadId, `[Wait complete]\n${ wait.reason }`, 'coding-manager', {
        source: 'agent_wait_timer',
      });
    }, () => Date.now());
    try {
      await scheduler.start();
      for (let n = 0; n < idleCount; n++) {
        const id = `idle-${ n }`;
        cache.set(id, { graph: {} as any, state: { messages: [], metadata: { cycleComplete: true, threadId: id } } as any });
      }
      await cache.evictIdle();
      expect.soft(cache.has(threadId)).toBe(true);
      expect.soft(cache.size).toBe(1 + Math.min(12, idleCount));

      await vi.advanceTimersByTimeAsync(16 * 60_000);
      await cache.evictIdle();
      expect.soft(cache.has(threadId)).toBe(true);
      await vi.advanceTimersByTimeAsync(60_000);
      await cache.evictIdle();
      expect.soft(checkpoints.filter(id => id === threadId)).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(3 * 60_000);
      // Observe through the +30/+60/+90s retry deadlines, not just first delivery.
      await vi.advanceTimersByTimeAsync(180_000);
      expect({
        consumedTimers,
        substantiveTurns,
        providerCalls,
        firedOffsets,
        retries:                repository.retries,
        retryScheduled:         repository.row.state === 'scheduled',
        secondRunnerDispatches: backend.dispatchToAgent.mock.calls.length,
        emptyWakeCount:         job.tasks[0].emptyWakeCount,
        jobFailed:              job.status === 'failed',
        failure,
      }).toEqual({
        consumedTimers:         1,
        substantiveTurns:       1,
        providerCalls:          1,
        firedOffsets:           [1_200_000],
        retries:                [],
        retryScheduled:         false,
        secondRunnerDispatches: 0,
        emptyWakeCount:         0,
        jobFailed:              false,
        failure:                undefined,
      });
      await run;
      state.metadata.runtimeRunnerActive = false;
      state.metadata.delegatedRunActive = false;
      await vi.advanceTimersByTimeAsync(16 * 60_000);
      await cache.evictIdle();
      expect(cache.has(threadId)).toBe(false);
    } finally {
      controller.abort();
      scheduler.stop();
      cache.clear();
      await run;
    }
  });
});
