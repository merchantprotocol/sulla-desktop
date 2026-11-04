// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AgentCompletionInbox,
  clearCompletionInboxes,
  enqueueAgentCompletion,
  registerCompletionIdleDispatcher,
  takeAgentCompletions,
} from '../../../services/AgentCompletionInbox';

import type { AgentJobResult } from '../../../tools/agents/jobRegistry';

const result = (label: string): AgentJobResult => ({ label, status: 'completed', output: label, threadId: `thread-${ label }` });

afterEach(() => clearCompletionInboxes());

describe('AgentCompletionInbox', () => {
  it('offers task one immediately while sibling tasks are still running', () => {
    // risk: orchestration liveness — one slow sibling must not hold a ready contract.
    const inbox = new AgentCompletionInbox();
    const dispatched: string[] = [];
    inbox.registerIdleDispatcher((channel, threadId) => {
      dispatched.push(`${ channel }/${ threadId }`);
    });

    inbox.enqueue('sulla-desktop', 'parent', { jobId: 'job-1', taskIndex: 0, results: [result('one')] });

    expect(dispatched).toEqual(['sulla-desktop/parent']);
    expect(inbox.take('sulla-desktop', 'parent').map(entry => entry.taskIndex)).toEqual([0]);
  });

  it('holds mid-run contracts and dispatches all ready tasks in arrival order when the run ends', () => {
    // risk: orchestration correctness — contracts must not interrupt an active model loop.
    const inbox = new AgentCompletionInbox();
    let parentRunning = true;
    const batches: number[][] = [];
    inbox.registerIdleDispatcher((channel, threadId) => {
      if (parentRunning) return;
      batches.push(inbox.take(channel, threadId).map(entry => entry.taskIndex));
    });

    inbox.enqueue('sulla-desktop', 'parent', { jobId: 'job-1', taskIndex: 0, results: [result('one')] });
    inbox.enqueue('sulla-desktop', 'parent', { jobId: 'job-1', taskIndex: 1, results: [result('two')] });
    expect(batches).toEqual([]);

    parentRunning = false;
    inbox.notifyReady('sulla-desktop', 'parent');
    expect(batches).toEqual([[0, 1]]);
  });

  it('dispatches held contracts after an errored or aborted run', () => {
    // risk: data loss — an unsuccessful parent turn must not discard child results.
    const inbox = new AgentCompletionInbox();
    const dispatch = vi.fn();
    inbox.registerIdleDispatcher(dispatch);
    inbox.setStopped('sulla-desktop', 'parent', true);
    inbox.enqueue('sulla-desktop', 'parent', { jobId: 'job-1', taskIndex: 0, results: [result('one')] });
    expect(dispatch).not.toHaveBeenCalled();

    inbox.setStopped('sulla-desktop', 'parent', false);
    inbox.notifyReady('sulla-desktop', 'parent');
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it('deduplicates per task rather than per job and never resends a taken batch', () => {
    // risk: duplicate side effects — retries and final job completion must not replay contracts.
    const dispatch = vi.fn();
    registerCompletionIdleDispatcher(dispatch);
    expect(enqueueAgentCompletion('sulla-desktop', 'parent', { jobId: 'job-1', taskIndex: 0, results: [result('one')] })).toBe(true);
    expect(enqueueAgentCompletion('sulla-desktop', 'parent', { jobId: 'job-1', taskIndex: 0, results: [result('one')] })).toBe(false);
    expect(enqueueAgentCompletion('sulla-desktop', 'parent', { jobId: 'job-1', taskIndex: 1, results: [result('two')] })).toBe(true);

    expect(takeAgentCompletions('sulla-desktop', 'parent').map(entry => entry.taskIndex)).toEqual([0, 1]);
    expect(takeAgentCompletions('sulla-desktop', 'parent')).toEqual([]);
  });
});
