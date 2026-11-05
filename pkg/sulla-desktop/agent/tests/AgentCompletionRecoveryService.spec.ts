// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';
import { AgentCompletionInboxService } from '../app/Services/AgentCompletionInboxService';
import { AgentCompletionRecoveryService } from '../app/Services/AgentCompletionRecoveryService';
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
});
