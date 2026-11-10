// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AgentCompletionInbox,
  COMPLETION_RESULT_LIMIT,
  formatCompletionBatch,
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
    let unsuccessfulRunActive = true;
    const dispatch = vi.fn((channel: string, threadId: string) => {
      if (unsuccessfulRunActive) return;
      inbox.take(channel, threadId);
    });
    inbox.registerIdleDispatcher(dispatch);
    inbox.enqueue('sulla-desktop', 'parent', { jobId: 'job-1', taskIndex: 0, results: [result('one')] });
    expect(inbox.take('sulla-desktop', 'missing')).toEqual([]);

    unsuccessfulRunActive = false;
    inbox.notifyReady('sulla-desktop', 'parent');
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(inbox.take('sulla-desktop', 'parent')).toEqual([]);
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
  it('formats sibling contracts with separators and bounds oversized results', () => {
    // risk: prompt integrity — sibling contracts must remain distinct and bounded.
    const one = result('one');
    const content = formatCompletionBatch([
      { jobId: 'job-1', taskIndex: 0, results: [one] },
      { jobId: 'job-1', taskIndex: 1, results: [], failureReason: 'network failed' },
    ]);
    expect(content).toContain('one');
    expect(content).toContain('network failed');
    expect(content).toContain('\n\n==========\n\n');

    const huge = formatCompletionBatch([{ jobId: 'job-2', taskIndex: 0, results: [{ ...one, output: 'x'.repeat(COMPLETION_RESULT_LIMIT + 500) }] }]);
    expect(huge).toContain('Result truncated');
  });

  it('reports a stopped task with its stopper and recorded reason', () => {
    // risk: lifecycle truth — intentional stops must not be mislabeled as provider failures.
    const content = formatCompletionBatch([{
      jobId: 'job-stop', taskIndex: 0, results: [],
      terminal: { status: 'stopped', stoppedBy: { agentId: 'coding-manager', threadId: 'manager-thread' }, reason: 'scope changed' },
    }]);
    expect(content).toContain('[sub-agent job job-stop STOPPED by coding-manager: scope changed]');
    expect(content).not.toContain('FAILED');
    expect(content).not.toContain('provider failure or aborted run');
  });

});
