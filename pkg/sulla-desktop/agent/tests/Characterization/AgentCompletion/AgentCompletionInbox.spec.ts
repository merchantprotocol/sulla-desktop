// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const pendingCompletions = vi.hoisted(() => vi.fn());

vi.mock('../../../tools/agents/jobRegistry', async(importOriginal) => ({
  ...await importOriginal<typeof import('../../../tools/agents/jobRegistry')>(),
  getPendingCompletions: pendingCompletions,
}));

import {
  clearCompletionInboxes,
  COMPLETION_COALESCE_MS,
  enqueueAgentCompletion,
  registerCompletionIdleDispatcher,
  setCompletionInboxStopped,
  takeAgentCompletions,
} from '../../../services/AgentCompletionInbox';
import { recoverPendingAgentCompletions } from '../../../services/AgentCompletionRecoveryService';

const result = { label: 'worker', status: 'completed' as const, output: 'done' };

describe('agent completion inbox characterization', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    pendingCompletions.mockReset();
    clearCompletionInboxes();
  });

  afterEach(() => {
    clearCompletionInboxes();
    vi.useRealTimers();
  });

  it('deduplicates a job, batches one wake, and preserves first-seen flush order', async() => {
    const dispatch = vi.fn();
    registerCompletionIdleDispatcher(dispatch);

    enqueueAgentCompletion('parent', 'thread', { jobId: 'job-2', results: [result] });
    enqueueAgentCompletion('parent', 'thread', { jobId: 'job-1', results: [result] });
    enqueueAgentCompletion('parent', 'thread', { jobId: 'job-2', results: [result], failureReason: 'duplicate' });

    await vi.advanceTimersByTimeAsync(COMPLETION_COALESCE_MS - 1);
    expect(dispatch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledWith('parent', 'thread');
    expect(takeAgentCompletions('parent', 'thread').map(entry => entry.jobId)).toEqual(['job-2', 'job-1']);
  });

  it('suppresses stopped inboxes and cleanup cancels every pending wake', async() => {
    const dispatch = vi.fn();
    registerCompletionIdleDispatcher(dispatch);
    enqueueAgentCompletion('parent', 'stopped', { jobId: 'job-stopped', results: [result] });
    enqueueAgentCompletion('parent', 'cleared', { jobId: 'job-cleared', results: [result] });
    setCompletionInboxStopped('parent', 'stopped', true);
    clearCompletionInboxes();

    await vi.advanceTimersByTimeAsync(COMPLETION_COALESCE_MS);
    expect(dispatch).not.toHaveBeenCalled();
    expect(takeAgentCompletions('parent', 'stopped')).toEqual([]);
    expect(takeAgentCompletions('parent', 'cleared')).toEqual([]);
  });

  it('recovers only deliverable undelivered completions and coalesces concurrent recovery', async() => {
    pendingCompletions.mockResolvedValue([
      { jobId: 'job-recovered', parentChannel: 'parent', parentThreadId: 'thread', results: [result] },
      { jobId: 'job-orphan', results: [result] },
    ]);

    await Promise.all([recoverPendingAgentCompletions(), recoverPendingAgentCompletions()]);

    expect(pendingCompletions).toHaveBeenCalledOnce();
    expect(takeAgentCompletions('parent', 'thread').map(entry => entry.jobId)).toEqual(['job-recovered']);
  });
});
