// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../../utils/logging', () => ({ default: { perf: { log: () => undefined } } }));

vi.mock('../../../app/Providers/AgentJobServiceProvider', () => ({ agentJobProvider: {} }));
vi.mock('../../../tools/agents/jobDelivery', () => ({ deliverJobCompletion: vi.fn(), returnedJobResult: vi.fn() }));
vi.mock('../../../tools/agents/jobRegistry', () => ({ completeJob: vi.fn(), getJob: vi.fn(), parkJobTask: vi.fn(), recordTaskCompletion: vi.fn(), resumeParkedJob: vi.fn() }));
vi.mock('../../../services/ReturnedTaskSettlement', () => ({ ReturnedTaskSettlement: class { settle = vi.fn() } }));

import { AgentCompletionInboxService, type PendingCompletion } from '../../../app/Services/AgentCompletionInboxService';
import { CompletionFormatter } from '../../../app/Services/CompletionFormatter';
import { CompletionIdleDispatcher } from '../../../app/Services/CompletionIdleDispatcher';
import { DelegatedCompletionHandoff, type DelegatedThreadState } from '../../../app/Services/DelegatedCompletionHandoff';
import { AgentJobLifecycleService } from '../../../services/AgentJobLifecycleService';
import { injectSteer, markSteerDelivered } from '../../../utils/steerChannel';

const MANAGER_CHANNEL = 'coding-manager';
const MANAGER_THREAD = 'thread-manager';

/** A delegated manager's thread, its runner lifecycle, and the real completion inbox wired the way BackendGraphWebSocketService wires them. */
class NestedDelegationHarness {
  readonly state: DelegatedThreadState = { messages: [], metadata: { delegatedRunActive: true } };
  readonly lifecycle = new AgentJobLifecycleService({ openChildrenForThread: async() => 0 }, async() => true, async() => true);
  readonly inbox = new AgentCompletionInboxService(new CompletionIdleDispatcher(), new CompletionFormatter(10_000));
  readonly delivered: string[] = [];
  readonly acknowledged: string[] = [];
  readonly handoff = new DelegatedCompletionHandoff(
    this.inbox,
    this.lifecycle,
    {
      firstDelivered: async entry => { this.delivered.push(`${ entry.jobId }#${ entry.taskIndex }`) },
      acknowledge:    async entry => { this.acknowledged.push(`${ entry.jobId }#${ entry.taskIndex }`); this.inbox.acknowledge(entry) },
    },
    (state, message, options) => { injectSteer(state as any, message, options) },
    () => `msg-${ this.state.messages.length + 1 }`,
  );

  readonly settled: Promise<boolean>[] = [];

  constructor() {
    this.inbox.registerIdleDispatcher((channel, threadId) => {
      this.settled.push(this.handoff.deliver(channel, threadId, threadId === MANAGER_THREAD ? this.state : undefined));
    });
  }

  childReturns(jobId: string): boolean {
    const completion: PendingCompletion = { jobId, taskIndex: 0, results: [{ label: 'worker', status: 'completed', output: `${ jobId } done`, threadId: `t-${ jobId }` }] };
    return this.inbox.enqueue(MANAGER_CHANNEL, MANAGER_THREAD, completion);
  }

  async flush(): Promise<void> {
    await Promise.all(this.settled);
  }

  /** The runner's park: delegatedRunActive=false then waitForWake. Resolves true if it woke within the window. */
  async park(withinMs = 50): Promise<boolean> {
    this.state.metadata!.delegatedRunActive = false;
    const woke = this.lifecycle.waitForWake(MANAGER_THREAD).then(() => true);
    return Promise.race([woke, new Promise<boolean>(resolve => setTimeout(() => resolve(false), withinMs))]);
  }

  completionSteers(): any[] {
    return this.state.messages.filter(message => message.metadata?.source === 'sub_agent_completion');
  }
}

describe('nested child completion wakes its delegated manager', () => {
  it('delivers a child result that settles while the manager is mid-turn, so its next park wakes at once', async() => {
    // risk: orchestration liveness — managers sat "parked, waiting on 0 children" with unprocessed child results for 10-20 min.
    const harness = new NestedDelegationHarness();
    expect(harness.childReturns('child-job-1')).toBe(true);
    await harness.flush();

    expect(await harness.park()).toBe(true);
    const steers = harness.completionSteers();
    expect(steers).toHaveLength(1);
    expect(steers[0].metadata.completionEntries.map((entry: PendingCompletion) => entry.jobId)).toEqual(['child-job-1']);
    expect(steers[0].content).toContain('child-job-1 done');
    expect(harness.inbox.pendingCount()).toBe(0);
    expect(harness.acknowledged).toEqual([]);
    markSteerDelivered(steers[0]);
    await new Promise(resolve => setImmediate(resolve));
    expect(harness.acknowledged).toEqual(['child-job-1#0']);
  });

  it('wakes a manager that is already parked and consumes the completion exactly once', async() => {
    // risk: orchestration liveness + duplicate delivery — the result must reach the parked manager once, not twice.
    const harness = new NestedDelegationHarness();
    const parked = harness.park(200);
    harness.childReturns('child-job-2');
    await harness.flush();
    expect(await parked).toBe(true);

    expect(harness.childReturns('child-job-2')).toBe(false); // recovery re-send is a duplicate
    await harness.flush();
    expect(harness.completionSteers()).toHaveLength(1);
    expect(harness.acknowledged).toEqual([]);
    markSteerDelivered(harness.completionSteers()[0]);
    await new Promise(resolve => setImmediate(resolve));
    expect(harness.delivered).toEqual(['child-job-2#0']);
    expect(harness.acknowledged).toEqual(['child-job-2#0']);
    expect(harness.inbox.pendingCount()).toBe(0);
  });

  it('keeps multiple live-turn completions in their enqueue order', async() => {
    // risk: reordered helper results can make a manager act on stale information.
    const harness = new NestedDelegationHarness();
    harness.childReturns('first-child');
    harness.childReturns('second-child');
    await harness.flush();

    expect(harness.completionSteers().map(message => message.metadata.completionEntries[0].jobId)).toEqual(['first-child', 'second-child']);
    expect(harness.completionSteers().map(message => message.content)).toEqual(expect.arrayContaining([
      expect.stringContaining('first-child done'),
      expect.stringContaining('second-child done'),
    ]));
  });

  it('leaves a dormant thread (no live runner) to the normal dispatch path', async() => {
    // risk: orchestration liveness — a dormant parked manager must still be re-entered by a dispatched wake turn.
    const harness = new NestedDelegationHarness();
    harness.state.metadata!.delegatedRunActive = false;
    harness.childReturns('child-job-3');
    await harness.flush();
    expect(await Promise.all(harness.settled)).toEqual([false]);
    expect(harness.inbox.pendingCount()).toBe(1);
    expect(harness.completionSteers()).toHaveLength(0);
  });
});

describe('agents/wait parking of a live delegated task', () => {
  const wait = { taskIndex: 0, reason: 'waiting on workers', wakeAt: new Date(120_000) };

  it('re-parks a live task whose row is still marked parked instead of reporting it no longer running', async() => {
    // risk: orchestration liveness — managers woken by a completion steer could not park again ("no longer running").
    const { AgentTaskParkingService } = await import('../../../services/AgentTaskParkingService');
    const job = { waitingOnChildren: 2, tasks: [{ status: 'parked', waitReason: 'waiting on 2 children' }] };
    expect(AgentTaskParkingService.parkedJob(job, wait)).toEqual({
      waitingOnChildren: 0, tasks: [{ status: 'parked', waitReason: 'waiting on workers', wakeAt: 120_000 }],
    });
  });

  it('refuses to park a settled task', async() => {
    // risk: orchestration integrity — a finished or stopped task must never be resurrected by a wait.
    const { AgentTaskParkingService } = await import('../../../services/AgentTaskParkingService');
    for (const status of ['completed', 'stopped', 'error']) {
      expect(AgentTaskParkingService.parkedJob({ tasks: [{ status }] }, wait)).toBeUndefined();
    }
  });
});
