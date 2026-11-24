/*
 * Sulla Desktop · https://sulladesktop.com
 * Copyright (c) 2025-2026 Merchant Protocol LLC.
 * SPDX-License-Identifier: GPL-2.0-or-later
 * "Sulla" is a trademark. See TRADEMARK.md.
 */

import { describe, expect, it } from 'vitest';

import { StatusRollupQueue, type StatusRollupItem } from './StatusRollupQueue';

class StatusRollupQueueFixture {
  readonly queue = new StatusRollupQueue();
  readonly threadId = 'thread-1';

  item(
    key: string,
    agentId: string,
    text: string,
    observedAt: number,
    urgency: StatusRollupItem['urgency'] = 'normal',
    threadId = this.threadId,
  ): StatusRollupItem {
    return {
      key,
      threadId,
      agentId,
      agentName: agentId,
      text,
      observedAt,
      urgency,
      role: 'worker',
    };
  }
}

describe('StatusRollupQueue', () => {
  // risk: data accuracy — queued progress should not flicker faster than one new line per second.
  it('enforces the one-second minimum gap', () => {
    const fixture = new StatusRollupQueueFixture();
    fixture.queue.observe([
      fixture.item('first', 'agent-a', 'First update', 0),
      fixture.item('second', 'agent-b', 'Second update', 0),
    ], fixture.threadId, 0);

    expect(fixture.queue.pump(0)?.key).toBe('first');
    expect(fixture.queue.pump(749)).toBeNull();
    expect(fixture.queue.pump(750)).toBeNull();
    expect(fixture.queue.current).toBeNull();
    expect(fixture.queue.pump(999)).toBeNull();
    expect(fixture.queue.pump(1_000)?.key).toBe('second');
  });

  // risk: data accuracy — urgent needs-you/failure signals must jump normal work and remain visible long enough to read.
  it('prioritizes urgent snippets and holds them for 2.6 seconds', () => {
    const fixture = new StatusRollupQueueFixture();
    fixture.queue.observe([
      fixture.item('normal', 'agent-a', 'Working', 0),
      fixture.item('urgent', 'agent-b', 'Needs input', 0, 'needs-you'),
    ], fixture.threadId, 0);

    expect(fixture.queue.pump(0)?.key).toBe('urgent');
    expect(fixture.queue.pump(999)?.key).toBeUndefined();
    expect(fixture.queue.pump(2_599)?.key).toBeUndefined();
    expect(fixture.queue.current?.key).toBe('urgent');
    expect(fixture.queue.pump(2_600)?.key).toBe('normal');
  });

  // risk: data accuracy — stale queued progress must be replaced and a repeated visible line must not reappear.
  it('replaces a queued item from the same agent and drops a repeated visible agent/text pair', () => {
    const fixture = new StatusRollupQueueFixture();
    fixture.queue.observe([fixture.item('a-1', 'agent-a', 'Starting', 0)], fixture.threadId, 0);
    fixture.queue.observe([fixture.item('a-2', 'agent-a', 'Still working', 100)], fixture.threadId, 100);

    expect(fixture.queue.pending.map(item => item.key)).toEqual(['a-2']);
    expect(fixture.queue.pump(0)?.key).toBe('a-2');
    fixture.queue.observe([fixture.item('a-3', 'agent-a', 'Still working', 250)], fixture.threadId, 250);

    expect(fixture.queue.pending).toEqual([]);
    expect(fixture.queue.history.map(item => item.key)).toEqual(['a-3', 'a-2', 'a-1']);
  });

  // risk: data accuracy — old normal progress must not surface after it is stale, while urgent requests remain available.
  it('expires nonurgent items only after six seconds, including while the pump is paused', () => {
    const fixture = new StatusRollupQueueFixture();
    fixture.queue.observe([
      fixture.item('normal', 'agent-a', 'Old normal', 0),
      fixture.item('urgent', 'agent-b', 'Urgent survives', 0, 'failed'),
    ], fixture.threadId, 0);
    fixture.queue.pump(0, true);

    fixture.queue.pump(6_000, true);
    expect(fixture.queue.pending.map(item => item.key)).toEqual(['normal', 'urgent']);
    fixture.queue.pump(6_001, true);
    expect(fixture.queue.pending.map(item => item.key)).toEqual(['urgent']);
  });

  // risk: data accuracy — sustained bursts must remain bounded without displacing urgent FIFO order.
  it('caps at five, evicts the oldest nonurgent item, and drops the newest urgent overflow', () => {
    const fixture = new StatusRollupQueueFixture();
    fixture.queue.observe([
      fixture.item('n-1', 'normal-1', 'one', 0),
      fixture.item('n-2', 'normal-2', 'two', 1),
      fixture.item('u-1', 'urgent-1', 'three', 2, 'needs-you'),
      fixture.item('u-2', 'urgent-2', 'four', 3, 'failed'),
      fixture.item('u-3', 'urgent-3', 'five', 4, 'needs-you'),
      fixture.item('u-4', 'urgent-4', 'six', 5, 'failed'),
    ], fixture.threadId, 5);

    expect(fixture.queue.pending.map(item => item.key)).toEqual(['n-2', 'u-1', 'u-2', 'u-3', 'u-4']);

    fixture.queue.observe([
      fixture.item('u-5', 'urgent-5', 'seven', 6, 'needs-you'),
    ], fixture.threadId, 6);
    expect(fixture.queue.pending.map(item => item.key)).toEqual(['u-1', 'u-2', 'u-3', 'u-4', 'u-5']);

    fixture.queue.observe([
      fixture.item('u-6', 'urgent-6', 'eight', 7, 'failed'),
    ], fixture.threadId, 7);
    expect(fixture.queue.pending.map(item => item.key)).toEqual(['u-1', 'u-2', 'u-3', 'u-4', 'u-5']);
  });

  // risk: data accuracy — urgency ordering and thread scope must not leak another chat's activity.
  it('prioritizes urgent arrivals FIFO and ignores records outside the active thread', () => {
    const fixture = new StatusRollupQueueFixture();
    fixture.queue.observe([
      fixture.item('normal', 'normal', 'normal first', 0),
      fixture.item('urgent-first', 'urgent-1', 'urgent first', 1, 'failed'),
      fixture.item('urgent-second', 'urgent-2', 'urgent second', 2, 'needs-you'),
      fixture.item('foreign', 'foreign', 'other chat', 3, 'failed', 'thread-2'),
    ], fixture.threadId, 3);

    expect(fixture.queue.pending.map(item => item.key)).toEqual(['normal', 'urgent-first', 'urgent-second']);
    expect(fixture.queue.pump(3)?.key).toBe('urgent-first');
    expect(fixture.queue.pump(2_603)?.key).toBe('urgent-second');
    expect(fixture.queue.history.map(item => item.key)).not.toContain('foreign');
  });

  // risk: data accuracy — recent check-in history and queued content must not cross thread boundaries.
  it('keeps only six observed check-ins and fully resets queue state on thread switch', () => {
    const fixture = new StatusRollupQueueFixture();
    fixture.queue.observe(Array.from({ length: 7 }, (_, index) =>
      fixture.item(`check-${index}`, `agent-${index}`, `Update ${index}`, index),
    ), fixture.threadId, 7);
    expect(fixture.queue.history.map(item => item.key)).toEqual([
      'check-6', 'check-5', 'check-4', 'check-3', 'check-2', 'check-1',
    ]);

    fixture.queue.observe([
      fixture.item('other-thread', 'agent-other', 'New chat', 8, 'normal', 'thread-2'),
    ], 'thread-2', 8);
    expect(fixture.queue.history.map(item => item.key)).toEqual(['other-thread']);
    expect(fixture.queue.pending.map(item => item.key)).toEqual(['other-thread']);
    expect(fixture.queue.current).toBeNull();
  });

  // risk: data accuracy — external text must remain inert and a foreign root fallback must be rejected.
  it('presents check-in data as bounded plain text and rejects a cross-thread root fallback', () => {
    const fixture = new StatusRollupQueueFixture();
    const item = fixture.item('safe', 'agent', '  <b>literal</b>\nupdate\u0000 ', 0);
    expect(fixture.queue.present(item, fixture.threadId, 0)?.text).toBe('<b>literal</b> update');
    expect(fixture.queue.present(fixture.item('foreign-root', 'root', 'fallback', 0, 'normal', 'thread-2'), fixture.threadId, 0)).toBeNull();
  });
});
