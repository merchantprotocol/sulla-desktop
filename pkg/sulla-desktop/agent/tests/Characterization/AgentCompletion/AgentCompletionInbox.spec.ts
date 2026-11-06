// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const pendingCompletions = vi.hoisted(() => vi.fn());
vi.mock('../../../tools/agents/jobRegistry', async(importOriginal) => ({
  ...await importOriginal<typeof import('../../../tools/agents/jobRegistry')>(),
  getPendingCompletions: pendingCompletions,
}));

import { clearCompletionInboxes, enqueueAgentCompletion, registerCompletionIdleDispatcher, takeAgentCompletions } from '../../../services/AgentCompletionInbox';
import { recoverPendingAgentCompletions } from '../../../services/AgentCompletionRecoveryService';

const result = { label: 'worker', status: 'completed' as const, output: 'done', threadId: 'child' };

describe('agent completion inbox characterization', () => {
  beforeEach(() => {
    pendingCompletions.mockReset();
    clearCompletionInboxes();
  });
  afterEach(() => clearCompletionInboxes());

  it('offers ready contracts immediately and deduplicates by job and task', () => {
    // risk: sibling waiting and duplicate contract delivery.
    const dispatch = vi.fn();
    registerCompletionIdleDispatcher(dispatch);
    enqueueAgentCompletion('parent', 'thread', { jobId: 'job-1', taskIndex: 0, results: [result] });
    enqueueAgentCompletion('parent', 'thread', { jobId: 'job-1', taskIndex: 0, results: [result] });
    enqueueAgentCompletion('parent', 'thread', { jobId: 'job-1', taskIndex: 1, results: [result] });

    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(takeAgentCompletions('parent', 'thread').map(entry => entry.taskIndex)).toEqual([0, 1]);
  });

  it('recovers only deliverable undelivered task completions', async() => {
    // risk: restart recovery data loss or replay.
    pendingCompletions.mockResolvedValue([{
      jobId: 'job-recovered', parentChannel: 'parent', parentThreadId: 'thread', results: [result, result],
      tasks: [
        { completion: result },
        { completion: result, completionDeliveredAt: 123 },
      ],
    }, { jobId: 'job-orphan', results: [result], tasks: [{ completion: result }] }]);

    await Promise.all([recoverPendingAgentCompletions(), recoverPendingAgentCompletions()]);

    expect(pendingCompletions).toHaveBeenCalledOnce();
    expect(takeAgentCompletions('parent', 'thread').map(entry => entry.taskIndex)).toEqual([0]);
  });
});
