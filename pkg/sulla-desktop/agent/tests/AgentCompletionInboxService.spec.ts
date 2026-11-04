// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';
import { AgentCompletionInboxService, type PendingCompletion } from '../app/Services/AgentCompletionInboxService';
import { CompletionFormatter } from '../app/Services/CompletionFormatter';
import { CompletionIdleDispatcher } from '../app/Services/CompletionIdleDispatcher';
import type { CompletionTimer, CompletionTimerHandle } from '../app/Services/CompletionTimer';

class FakeTimer implements CompletionTimer {
  private tasks = new Map<CompletionTimerHandle, () => void>();

  schedule(callback: () => void): CompletionTimerHandle {
    const handle = { unref: vi.fn() };
    this.tasks.set(handle, callback);
    return handle;
  }

  cancel(handle: CompletionTimerHandle): void {
    this.tasks.delete(handle);
  }

  flush(): void {
    const tasks = Array.from(this.tasks.values());
    this.tasks.clear();
    for (const task of tasks) task();
  }

  size(): number {
    return this.tasks.size;
  }
}

const completion = (jobId: string): PendingCompletion => ({
  jobId,
  results: [{ label: 'worker', status: 'completed', output: 'done', threadId: 'child' }],
});

const createInbox = (timer = new FakeTimer()) => {
  const dispatcher = new CompletionIdleDispatcher();
  const inbox = new AgentCompletionInboxService(timer, dispatcher, new CompletionFormatter(8_000), 2_000);
  return { dispatcher, inbox, timer };
};

describe('AgentCompletionInboxService', () => {
  it('deduplicates jobs and dispatches one batched wake in insertion order', () => {
    const { dispatcher, inbox, timer } = createInbox();
    const dispatch = vi.fn();
    dispatcher.register(dispatch);

    inbox.enqueue('parent', 'thread', completion('job-2'));
    inbox.enqueue('parent', 'thread', completion('job-1'));
    inbox.enqueue('parent', 'thread', completion('job-2'));
    timer.flush();

    expect(dispatch).toHaveBeenCalledOnce();
    expect(inbox.take('parent', 'thread').map(entry => entry.jobId)).toEqual(['job-2', 'job-1']);
  });

  it('stop cancels pending timers and dispose removes all retained state', () => {
    const { dispatcher, inbox, timer } = createInbox();
    const dispatch = vi.fn();
    dispatcher.register(dispatch);
    inbox.enqueue('parent', 'one', completion('job-1'));
    inbox.enqueue('parent', 'two', completion('job-2'));

    inbox.stop();
    expect(timer.size()).toBe(0);
    timer.flush();
    expect(dispatch).not.toHaveBeenCalled();
    expect(inbox.pendingCount()).toBe(2);

    inbox.dispose();
    expect(inbox.pendingCount()).toBe(0);
    expect(inbox.take('parent', 'one')).toEqual([]);
  });

  it('keeps independent instances isolated', () => {
    const first = createInbox();
    const second = createInbox();
    first.inbox.enqueue('parent', 'thread', completion('job-first'));

    expect(first.inbox.pendingCount()).toBe(1);
    expect(second.inbox.pendingCount()).toBe(0);
    expect(second.inbox.take('parent', 'thread')).toEqual([]);
  });
});
