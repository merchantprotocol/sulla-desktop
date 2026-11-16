// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';
import { AgentCompletionInboxService, type PendingCompletion } from '../app/Services/AgentCompletionInboxService';
import { CompletionFormatter } from '../app/Services/CompletionFormatter';
import { CompletionIdleDispatcher } from '../app/Services/CompletionIdleDispatcher';
import { CompletionRequeueBackoff, type CompletionRetryTimer } from '../app/Services/CompletionRequeueBackoff';

/** Fake clock: timers fire only when the test advances time. */
class ManualTimer implements CompletionRetryTimer {
  private now = 0;
  private nextId = 1;
  readonly pending = new Map<number, { at: number; callback: () => void }>();
  readonly delays: number[] = [];

  set(callback: () => void, delayMs: number): unknown {
    const id = this.nextId++;
    this.delays.push(delayMs);
    this.pending.set(id, { at: this.now + delayMs, callback });
    return id;
  }

  clear(handle: unknown): void {
    this.pending.delete(handle as number);
  }

  advance(ms: number): void {
    this.now += ms;
    for (const [id, timer] of [...this.pending].sort((a, b) => a[1].at - b[1].at)) {
      if (timer.at > this.now) continue;
      this.pending.delete(id);
      timer.callback();
    }
  }
}

const completion = (jobId: string, taskIndex = 0): PendingCompletion => ({
  jobId, taskIndex, results: [{ label: 'worker', status: 'completed', output: 'done', threadId: 'child' }],
});

const createInbox = () => {
  const timer = new ManualTimer();
  const dispatcher = new CompletionIdleDispatcher();
  const inbox = new AgentCompletionInboxService(dispatcher, new CompletionFormatter(8_000), new CompletionRequeueBackoff(timer, 1_000, 8_000));
  return { timer, dispatcher, inbox };
};

describe('Completion requeue after a failed delivery', () => {
  it('retries a persistently failing delivery with growing, capped delays instead of a hot loop', () => {
    // risk: liveness/CPU — a dispatch that always fails (Postgres down) requeued and re-woke the dispatcher with zero delay, forever.
    const { timer, dispatcher, inbox } = createInbox();
    let wakes = 0;
    dispatcher.register((channel, threadId) => {
      wakes++;
      if (wakes > 50) throw new Error('hot retry loop');
      for (const entry of inbox.take(channel, threadId)) inbox.requeueAfterFailure(channel, threadId, entry);
    });

    inbox.enqueue('parent', 'thread', completion('job-down'));
    expect(wakes).toBe(1);
    expect(inbox.pendingCount()).toBe(0);

    timer.advance(999);
    expect(wakes).toBe(1);
    for (let step = 0; step < 6; step++) timer.advance(8_000);

    expect(timer.delays).toEqual([1_000, 2_000, 4_000, 8_000, 8_000, 8_000, 8_000]);
    expect(wakes).toBe(7);
  });

  it('delivers the result once the failure clears, and holds duplicate recovery enqueues during the wait', () => {
    // risk: data loss / duplicate delivery — the backed-off result must come back exactly once.
    const { timer, dispatcher, inbox } = createInbox();
    const wake = vi.fn();
    dispatcher.register(wake);
    inbox.enqueue('parent', 'thread', completion('job-flaky'));
    const [claimed] = inbox.take('parent', 'thread');

    expect(inbox.requeueAfterFailure('parent', 'thread', claimed)).toBe(1_000);
    expect(inbox.requeueAfterFailure('parent', 'thread', claimed)).toBe(-1);
    expect(inbox.enqueue('parent', 'thread', completion('job-flaky'))).toBe(false);
    expect(inbox.take('parent', 'thread')).toEqual([]);

    timer.advance(1_000);
    expect(wake).toHaveBeenCalledTimes(2);
    expect(inbox.take('parent', 'thread').map(entry => entry.jobId)).toEqual(['job-flaky']);
  });

  it('hands a result back to a busy thread without waking the dispatcher', () => {
    // risk: liveness — the deferred-while-busy path must not re-fire the dispatcher; the running turn drains it.
    const { dispatcher, inbox } = createInbox();
    const wake = vi.fn();
    dispatcher.register(wake);
    inbox.enqueue('parent', 'thread', completion('job-busy'));
    const [claimed] = inbox.take('parent', 'thread');

    inbox.requeueQuietly('parent', 'thread', claimed);

    expect(wake).toHaveBeenCalledTimes(1);
    expect(inbox.take('parent', 'thread').map(entry => entry.jobId)).toEqual(['job-busy']);
  });

  it('lets recovery redeliver a result whose claim was released for a stopped thread', () => {
    // risk: data loss — a claim left behind by the terminal-thread early return made every later recovery enqueue a silent duplicate.
    const { inbox } = createInbox();
    inbox.enqueue('parent', 'thread', completion('job-stopped'));
    const [claimed] = inbox.take('parent', 'thread');
    expect(inbox.enqueue('parent', 'thread', completion('job-stopped'))).toBe(false);

    inbox.releaseClaim(claimed);

    expect(inbox.enqueue('parent', 'thread', completion('job-stopped'))).toBe(true);
  });

  it('cancels pending retries on dispose', () => {
    // risk: irreversible side effect — a disposed inbox must not wake a parent later.
    const { timer, dispatcher, inbox } = createInbox();
    const wake = vi.fn();
    dispatcher.register(wake);
    inbox.enqueue('parent', 'thread', completion('job-late'));
    const [claimed] = inbox.take('parent', 'thread');
    inbox.requeueAfterFailure('parent', 'thread', claimed);

    inbox.dispose();
    timer.advance(60_000);

    expect(timer.pending.size).toBe(0);
    expect(wake).toHaveBeenCalledTimes(1);
  });
});
