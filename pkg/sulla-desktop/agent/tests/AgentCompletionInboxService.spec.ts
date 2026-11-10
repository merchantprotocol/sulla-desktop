// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';
import { AgentCompletionInboxService, type PendingCompletion } from '../app/Services/AgentCompletionInboxService';
import { CompletionFormatter } from '../app/Services/CompletionFormatter';
import { CompletionIdleDispatcher } from '../app/Services/CompletionIdleDispatcher';

const completion = (jobId: string, taskIndex: number): PendingCompletion => ({
  jobId,
  taskIndex,
  results: [{ label: `worker-${ taskIndex }`, status: 'completed', output: 'done', threadId: 'child' }],
});

const createInbox = () => {
  const dispatcher = new CompletionIdleDispatcher();
  const inbox = new AgentCompletionInboxService(dispatcher, new CompletionFormatter(8_000));
  return { dispatcher, inbox };
};

describe('AgentCompletionInboxService', () => {
  it('offers each task immediately, deduplicates per task, and preserves arrival order', () => {
    // risk: orchestration liveness and duplicate side effects.
    const { dispatcher, inbox } = createInbox();
    const dispatch = vi.fn();
    dispatcher.register(dispatch);

    expect(inbox.enqueue('parent', 'thread', completion('job-1', 0))).toBe(true);
    expect(inbox.enqueue('parent', 'thread', completion('job-1', 0))).toBe(false);
    expect(inbox.enqueue('parent', 'thread', completion('job-1', 1))).toBe(true);

    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(inbox.take('parent', 'thread').map(entry => entry.taskIndex)).toEqual([0, 1]);
  });

  it('holds stopped inboxes and offers every held task together when the run ends', () => {
    // risk: contract loss when a parent run errors or aborts.
    const { dispatcher, inbox } = createInbox();
    const dispatch = vi.fn();
    dispatcher.register(dispatch);
    inbox.enqueue('parent', 'thread', completion('job-1', 0));
    inbox.setStopped('parent', 'thread', true);
    inbox.enqueue('parent', 'thread', completion('job-1', 1));
    expect(dispatch).toHaveBeenCalledOnce();

    inbox.setStopped('parent', 'thread', false);
    inbox.notifyReady('parent', 'thread');
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(inbox.take('parent', 'thread').map(entry => entry.taskIndex)).toEqual([0, 1]);
  });

  it('keeps independent service instances isolated and dispose removes retained state', () => {
    // risk: cross-runtime completion leakage.
    const first = createInbox();
    const second = createInbox();
    first.inbox.enqueue('parent', 'thread', completion('job-first', 0));

    expect(first.inbox.pendingCount()).toBe(1);
    expect(second.inbox.pendingCount()).toBe(0);
    first.inbox.dispose();
    expect(first.inbox.pendingCount()).toBe(0);
  });

  it('does not accept a completion again after its parent input was acknowledged', () => {
    // risk: duplicate completion events must not wake a parent twice in one runtime.
    const { inbox } = createInbox();
    const notice = completion('job-acknowledged', 0);
    expect(inbox.enqueue('parent', 'thread', notice)).toBe(true);
    inbox.take('parent', 'thread');
    inbox.acknowledge(notice);
    expect(inbox.enqueue('parent', 'thread', notice)).toBe(false);
    expect(inbox.pendingCount()).toBe(0);
  });
});
