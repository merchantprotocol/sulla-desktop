// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';

import { CompletionInboxStore, formatCompletionBatch } from '../../../services/AgentCompletionInbox';

describe('CompletionInboxStore', () => {
  it('formats every child contract into one wake batch', () => {
    // risk: a parked manager wakes without the returned child contract
    const result = { label: 'worker', status: 'completed' as const, output: 'contract-output', threadId: 'child' };
    const content = formatCompletionBatch([{ jobId: 'worker-a', results: [result] }, { jobId: 'worker-b', results: [], failureReason: 'network failed' }]);
    expect(content).toContain('[sub-agent job worker-a complete');
    expect(content).toContain('contract-output');
    expect(content).toContain('[sub-agent job worker-b FAILED] network failed');
  });

  it('coalesces duplicate receipts while preserving two simultaneous workers', () => {
    // risk: concurrent child completion loss or duplicate parent turns
    const store = new CompletionInboxStore();
    const result = { label: 'worker', status: 'completed' as const, output: 'ok', threadId: 'child' };
    store.enqueue('manager', 'thread', { jobId: 'worker-a', results: [result] });
    store.enqueue('manager', 'thread', { jobId: 'worker-b', results: [result] });
    store.enqueue('manager', 'thread', { jobId: 'worker-a', results: [result] });
    expect(store.take('manager', 'thread').map(entry => entry.jobId)).toEqual(['worker-a', 'worker-b']);
    expect(store.take('manager', 'thread')).toEqual([]);
    store.clear();
  });

  it('preserves a second child that finishes during the parent follow-up turn', () => {
    // risk: a completion arriving during the next parent turn is dropped
    const store = new CompletionInboxStore();
    store.enqueue('manager', 'thread', { jobId: 'first', results: [] });
    expect(store.take('manager', 'thread').map(entry => entry.jobId)).toEqual(['first']);
    store.enqueue('manager', 'thread', { jobId: 'second', results: [] });
    expect(store.take('manager', 'thread').map(entry => entry.jobId)).toEqual(['second']);
    store.clear();
  });

  it('nacks by allowing a failed reservation to be enqueued again', () => {
    // risk: failed dispatch permanently marks a child result delivered
    const store = new CompletionInboxStore();
    const completion = { jobId: 'worker', results: [] };
    store.enqueue('manager', 'thread', completion);
    expect(store.take('manager', 'thread')).toEqual([completion]);
    store.enqueue('manager', 'thread', completion);
    expect(store.take('manager', 'thread')).toEqual([completion]);
    store.clear();
  });
});
