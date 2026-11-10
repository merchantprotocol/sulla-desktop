// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';
import { AgentCompletionInboxService } from '../app/Services/AgentCompletionInboxService';
import { AgentCompletionRecoveryService } from '../app/Services/AgentCompletionRecoveryService';
import { CompletionAcknowledgementService } from '../app/Services/CompletionAcknowledgementService';
import { CompletionFormatter } from '../app/Services/CompletionFormatter';
import { CompletionIdleDispatcher } from '../app/Services/CompletionIdleDispatcher';

const result = (label: string) => ({ label, status: 'completed' as const, output: label, threadId: `thread-${ label }` });

describe('AgentCompletionRecoveryService', () => {
  it('recovers only undelivered task contracts and coalesces concurrent recovery', async() => {
    // risk: restart recovery must neither drop nor replay task contracts.
    const inbox = new AgentCompletionInboxService(new CompletionIdleDispatcher(), new CompletionFormatter(8_000));
    const source = {
      getPendingCompletions: vi.fn().mockResolvedValue([{
        jobId: 'job-recovered', status: 'completed', createdAt: 1, finishedAt: 2, taskCount: 2,
        tasks: [
          { completion: result('ready'), completionDeliveredAt: undefined },
          { completion: result('already-delivered'), completionDeliveredAt: 3 },
        ],
        results: [result('ready'), result('already-delivered')],
        parentChannel: 'parent', parentThreadId: 'thread',
      }]),
    };
    const recovery = new AgentCompletionRecoveryService(source as any, inbox);

    await Promise.all([recovery.recover(), recovery.recover()]);

    expect(source.getPendingCompletions).toHaveBeenCalledOnce();
    expect(inbox.take('parent', 'thread').map(entry => entry.taskIndex)).toEqual([0]);
    expect(recovery.inFlightCount()).toBe(0);
  });

  it('sweeps aged undelivered completions once and labels recovery with delivery time and current job state', async() => {
    // risk: a missed wake must be recovered without duplicate parent turns.
    let callback: (() => void) | undefined;
    const timer = {
      every: vi.fn((next: () => void) => { callback = next; return 1 as any; }),
      clear: vi.fn(),
    };
    const inbox = new AgentCompletionInboxService(new CompletionIdleDispatcher(), new CompletionFormatter(8_000));
    const source = { getPendingCompletions: vi.fn().mockResolvedValue([{
      jobId: 'job-sweep', status: 'completed', createdAt: 1, finishedAt: 10, taskCount: 1,
      tasks: [{ completion: result('sweep'), returnedAt: 10, completionFirstDeliveredAt: 50 }], results: [result('sweep')],
      parentChannel: 'parent', parentThreadId: 'thread',
    }]) };
    const recovery = new AgentCompletionRecoveryService(source as any, inbox, undefined, () => 200_000, timer as any);
    recovery.start(120_000, 120_000);
    callback?.();
    await recovery.recover();
    callback?.();
    await recovery.recover();

    const entries = inbox.take('parent', 'thread');
    expect(entries).toHaveLength(1);
    expect(inbox.format(entries)).toContain('[re-delivery: first delivered at');
    expect(inbox.format(entries)).toContain('[job state: completed]');
    recovery.dispose();
    expect(timer.clear).toHaveBeenCalledOnce();
  });

  it('does not replay a completion after its injection acknowledgment survives a simulated restart', async() => {
    // risk: restart after injection must not create a duplicate parent wake.
    const task: any = { completion: result('persisted'), returnedAt: 10 };
    const job: any = {
      jobId: 'job-persisted', status: 'completed', createdAt: 1, finishedAt: 10, taskCount: 1,
      tasks: [task], results: [task.completion], parentChannel: 'parent', parentThreadId: 'thread',
    };
    const source = { getPendingCompletions: vi.fn().mockResolvedValue([job]) };
    const firstInbox = new AgentCompletionInboxService(new CompletionIdleDispatcher(), new CompletionFormatter(8_000));
    const firstRecovery = new AgentCompletionRecoveryService(source, firstInbox);
    await firstRecovery.recover();
    const [injected] = firstInbox.take('parent', 'thread');
    const acknowledgements = new CompletionAcknowledgementService({
      markTaskCompletionDelivered: async() => { task.completionDeliveredAt = 100; },
    }, { markDelivered: async() => {} } as any, firstInbox);
    await acknowledgements.acknowledge(injected);

    const restartedInbox = new AgentCompletionInboxService(new CompletionIdleDispatcher(), new CompletionFormatter(8_000));
    await new AgentCompletionRecoveryService(source, restartedInbox).recover();
    expect(restartedInbox.pendingCount()).toBe(0);
  });

  it('replays an unconsumed completion once after restart and includes the re-delivery state', async() => {
    // risk: a turn that never consumed its completion must not strand its result.
    const completion = result('unconsumed');
    const job: any = {
      jobId: 'job-unconsumed', status: 'parked', createdAt: 1, finishedAt: 10, taskCount: 1,
      tasks: [{ completion, returnedAt: 10, completionFirstDeliveredAt: 50 }], results: [completion],
      parentChannel: 'parent', parentThreadId: 'thread',
    };
    const source = { getPendingCompletions: vi.fn().mockResolvedValue([job]) };
    const timer = { every: vi.fn(() => 1 as any), clear: vi.fn() };
    const inbox = new AgentCompletionInboxService(new CompletionIdleDispatcher(), new CompletionFormatter(8_000));
    const recovery = new AgentCompletionRecoveryService(source, inbox, undefined, () => 200_000, timer as any);
    recovery.start(120_000, 120_000);
    await recovery.recover();
    await recovery.recover();
    const entries = inbox.take('parent', 'thread');
    expect(entries).toHaveLength(1);
    expect(inbox.format(entries)).toContain('[re-delivery: first delivered at');
    expect(inbox.format(entries)).toContain('[job state: parked]');
    recovery.dispose();
  });
});
