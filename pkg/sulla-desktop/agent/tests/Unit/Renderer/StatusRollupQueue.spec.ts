/*
 * Sulla Desktop · https://sulladesktop.com
 * Copyright (c) 2025-2026 Merchant Protocol LLC.
 * SPDX-License-Identifier: GPL-2.0-or-later
 * "Sulla" is a trademark. See TRADEMARK.md.
 */

import { describe, expect, it } from 'vitest';

import { BoundedThreadKeyLedger, StatusRollupQueue, type StatusRollupItem } from '../../../../pages/chat/components/composer/StatusRollupQueue';

class StatusRollupQueueFixture {
  readonly queue = new StatusRollupQueue();
  readonly threadId = 'thread-a';

  item(key: string, text: string, observedAt: number, threadId = this.threadId): StatusRollupItem {
    return { key, threadId, agentId: `agent-${key}`, agentName: 'Agent', kind: 'agent', text, observedAt };
  }
}

describe('StatusRollupQueue live selection', () => {
  // risk: status replay — rows present at mount or at the subscription boundary never render.
  it('primes historical rows and rejects every event at or before the live subscription boundary', () => {
    const fixture = new StatusRollupQueueFixture();
    const old = fixture.item('old', 'Cached activity', 99);
    fixture.queue.prime([old], fixture.threadId);

    expect(fixture.queue.observe([old], fixture.threadId, 101, 100)).toBeNull();
    expect(fixture.queue.observe([fixture.item('at-boundary', 'Same timestamp', 100)], fixture.threadId, 101, 100)).toBeNull();
    expect(fixture.queue.current).toBeNull();
    expect(fixture.queue.history).toEqual([]);
  });

  // risk: latency and backlog replay — a burst must present its newest live item immediately instead of pacing a queue.
  it('returns only the newest live item from a burst while retaining live-only history', () => {
    const fixture = new StatusRollupQueueFixture();
    const burst = [
      fixture.item('event-2', 'Action 2', 103),
      fixture.item('event-0', 'Action 0', 101),
      fixture.item('event-1', 'Action 1', 102),
    ];

    const shown = fixture.queue.observe(burst, fixture.threadId, 200, 100);

    expect(shown?.key).toBe('event-2');
    expect(fixture.queue.current?.key).toBe('event-2');
    expect(fixture.queue.history.map(item => item.key)).toEqual(['event-2', 'event-1', 'event-0']);
  });

  // risk: thread isolation and remount recovery — shown statuses must not return when revisiting a thread.
  it('remembers shown keys independently per thread across thread resets', () => {
    const fixture = new StatusRollupQueueFixture();
    const item = fixture.item('seen-a', 'Already shown', 101);
    expect(fixture.queue.observe([item], 'thread-a', 101, 100)?.key).toBe(item.key);
    fixture.queue.reset('thread-b');
    expect(fixture.queue.observe([fixture.item('other', 'Other thread', 102, 'thread-b')], 'thread-b', 102, 100)?.key).toBe('other');
    fixture.queue.reset('thread-a');

    expect(fixture.queue.observe([item], 'thread-a', 200, 100)).toBeNull();
    expect(fixture.queue.current).toBeNull();
  });

  // risk: stale status replay — the subscription timestamp gate rejects keys evicted after the 2,000-key cap.
  it('does not replay an evicted key after 3,000 events and a new subscription boundary', () => {
    const fixture = new StatusRollupQueueFixture();
    const burst = Array.from({ length: 3_000 }, (_, index) => fixture.item(`event-${index}`, `Action ${index}`, 101 + index));

    expect(fixture.queue.observe(burst, 'thread-a', 4_000, 100)?.key).toBe('event-2999');
    fixture.queue.reset('thread-b');
    fixture.queue.reset('thread-a');

    expect(fixture.queue.observe([burst[0]!], 'thread-a', 4_001, 4_000)).toBeNull();
  });

  // risk: long-session memory growth — displayed key history is capped oldest-first at 2,000 keys per thread.
  it('retains no more than 2,000 keys per thread and evicts the oldest key first', () => {
    const ledger = new BoundedThreadKeyLedger();
    for (let index = 0; index < 3_000; index += 1) ledger.remember('thread-a', `key-${index}`);

    expect(ledger.retainedKeyCount('thread-a')).toBe(BoundedThreadKeyLedger.maxKeysPerThread);
    expect(ledger.has('thread-a', 'key-999')).toBe(false);
    expect(ledger.has('thread-a', 'key-1000')).toBe(true);
    expect(ledger.has('thread-a', 'key-2999')).toBe(true);
  });

  // risk: multi-thread memory growth — only the 20 most recently active thread ledgers remain retained.
  it('retains key history for only the 20 most recently active threads', () => {
    const ledger = new BoundedThreadKeyLedger();
    for (let index = 0; index < 20; index += 1) ledger.remember(`thread-${index}`, 'seen');
    expect(ledger.has('thread-0', 'seen')).toBe(true);
    ledger.remember('thread-20', 'seen');

    expect(ledger.retainedThreadCount).toBe(BoundedThreadKeyLedger.maxThreads);
    expect(ledger.retainedKeyCount('thread-0')).toBe(1);
    expect(ledger.retainedKeyCount('thread-1')).toBe(0);
    expect(ledger.has('thread-20', 'seen')).toBe(true);
  });

  // risk: duplicate source delivery — duplicate IDs cannot reappear, while a current thought revision updates in place.
  it('deduplicates repeated keys and revises only the currently displayed thought', () => {
    const fixture = new StatusRollupQueueFixture();
    const thought = { ...fixture.item('thought', 'First thought', 101), kind: 'thought' as const };
    expect(fixture.queue.observe([thought], fixture.threadId, 101, 100)?.text).toBe('First thought');
    fixture.queue.markShown(thought);

    expect(fixture.queue.observe([{ ...thought, text: 'Updated thought', observedAt: 102, updateOnly: true }], fixture.threadId, 102, 100)?.text)
      .toBe('Updated thought');
    expect(fixture.queue.observe([thought], fixture.threadId, 103, 100)).toBeNull();
    expect(fixture.queue.current?.text).toBe('Updated thought');
  });

  // risk: privacy — foreign thread data and unsafe control characters never enter live status or history.
  it('rejects other threads and sanitizes the text-only event', () => {
    const fixture = new StatusRollupQueueFixture();
    const local = fixture.item('local', '  <b>literal</b>\nupdate\u0000 ', 101);
    const foreign = fixture.item('foreign', 'Private other chat', 102, 'thread-b');

    expect(fixture.queue.observe([local, foreign], fixture.threadId, 103, 100)?.text).toBe('<b>literal</b> update');
    expect(fixture.queue.history.map(item => item.key)).toEqual(['local']);
  });

  // risk: action/glow correlation — label, phase and tool correlation survive event normalization.
  it('preserves action labels and tool correlation through presentation', () => {
    const fixture = new StatusRollupQueueFixture();
    const item = {
      ...fixture.item('tool-start', 'Reading file', 101),
      kind: 'read' as const,
      phase: 'start' as const,
      correlationId: 'primary:thread-a:tool-1',
    };

    expect(fixture.queue.present(item, fixture.threadId, 101)).toMatchObject({
      kind: 'read', phase: 'start', correlationId: 'primary:thread-a:tool-1',
    });
  });
});
