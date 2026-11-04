// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';
import { AgentCompletionInboxService } from '../app/Services/AgentCompletionInboxService';
import { AgentCompletionRecoveryService } from '../app/Services/AgentCompletionRecoveryService';
import { CompletionFormatter } from '../app/Services/CompletionFormatter';
import { CompletionIdleDispatcher } from '../app/Services/CompletionIdleDispatcher';
import type { CompletionTimer, CompletionTimerHandle } from '../app/Services/CompletionTimer';

class InertTimer implements CompletionTimer {
  schedule(): CompletionTimerHandle {
    return { unref: vi.fn() };
  }

  cancel(): void {}
}

describe('AgentCompletionRecoveryService', () => {
  it('recovers deliverable jobs once and clears in-flight ownership', async() => {
    const inbox = new AgentCompletionInboxService(
      new InertTimer(),
      new CompletionIdleDispatcher(),
      new CompletionFormatter(8_000),
      2_000,
    );
    const source = {
      getPendingCompletions: vi.fn().mockResolvedValue([
        {
          jobId: 'job-recovered',
          status: 'completed',
          createdAt: 1,
          finishedAt: 2,
          taskCount: 1,
          tasks: [],
          results: [],
          parentChannel: 'parent',
          parentThreadId: 'thread',
        },
        {
          jobId: 'job-orphan',
          status: 'completed',
          createdAt: 1,
          finishedAt: 2,
          taskCount: 1,
          tasks: [],
          results: [],
        },
      ]),
    };
    const recovery = new AgentCompletionRecoveryService(source, inbox);

    await Promise.all([recovery.recover(), recovery.recover()]);

    expect(source.getPendingCompletions).toHaveBeenCalledOnce();
    expect(inbox.take('parent', 'thread').map(entry => entry.jobId)).toEqual(['job-recovered']);
    expect(recovery.inFlightCount()).toBe(0);
    recovery.dispose();
    expect(recovery.inFlightCount()).toBe(0);
  });
});
