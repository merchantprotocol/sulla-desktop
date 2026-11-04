// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';

import { CompletionInboxStore } from '../../../services/AgentCompletionInbox';

describe('CompletionInboxStore', () => {
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
