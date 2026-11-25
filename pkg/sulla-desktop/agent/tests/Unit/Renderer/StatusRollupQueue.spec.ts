/*
 * Sulla Desktop · https://sulladesktop.com
 * Copyright (c) 2025-2026 Merchant Protocol LLC.
 * SPDX-License-Identifier: GPL-2.0-or-later
 * "Sulla" is a trademark. See TRADEMARK.md.
 */

import { describe, expect, it } from 'vitest';

import { StatusRollupQueue, type StatusRollupItem } from '../../../../pages/chat/components/composer/StatusRollupQueue';

class StatusRollupQueueFixture {
  readonly queue = new StatusRollupQueue();
  readonly threadId = 'thread-a';

  item(
    key: string,
    agentId: string,
    text: string,
    observedAt: number,
    urgency: StatusRollupItem['urgency'] = 'normal',
    threadId = this.threadId,
  ): StatusRollupItem {
    return { key, threadId, agentId, agentName: agentId, kind: 'agent', text, observedAt, urgency, role: 'worker' };
  }
}

describe('StatusRollupQueue', () => {
  // risk: data accuracy — a rapid event burst must be displayed in-order without dropping progress.
  it('drains all 30 events from a one-second burst in order within about three seconds', () => {
    const fixture = new StatusRollupQueueFixture();
    const items = Array.from({ length: 30 }, (_, index) =>
      fixture.item(`event-${index}`, `agent-${index % 4}`, `Action ${index}`, index * 33),
    );
    fixture.queue.observe(items, fixture.threadId, 1_000);

    const shown: string[] = [];
    let lastShownAt = 1_000;
    for (let now = 1_000; now <= 4_000 && shown.length < items.length; now += 25) {
      const item = fixture.queue.pump(now);
      if (item) { shown.push(item.key); lastShownAt = now; }
    }

    expect(shown).toEqual(items.map(item => item.key));
    expect(fixture.queue.pending).toEqual([]);
    expect(fixture.queue.current?.key).toBe('event-29');
    expect(lastShownAt - 1_000).toBeLessThanOrEqual(3_000);
  });

  // risk: data accuracy — hidden-tab backlog playback must catch up without skipping or reordering actions.
  it('drains a 200-item backlog on real 100ms ticks in about three seconds', () => {
    const fixture = new StatusRollupQueueFixture();
    const items = Array.from({ length: 200 }, (_, index) =>
      fixture.item(`event-${index}`, `agent-${index % 4}`, `Action ${index}`, index),
    );
    fixture.queue.observe(items, fixture.threadId, 0);

    const shown: string[] = [];
    for (let now = 0; now <= 3_000 && shown.length < items.length; now += 100) {
      shown.push(...fixture.queue.pumpDue(now).map(item => item.key));
    }

    expect(shown).toEqual(items.map(item => item.key));
    expect(fixture.queue.pending).toEqual([]);
    expect(fixture.queue.current?.key).toBe('event-199');
  });

  // risk: safety — a blocked or failed agent must interrupt ordinary updates and remain readable.
  it('jumps urgent activity ahead of normal items and holds it for 2.6 seconds', () => {
    const fixture = new StatusRollupQueueFixture();
    fixture.queue.observe([
      fixture.item('normal-1', 'agent-a', 'Working', 0),
      fixture.item('normal-2', 'agent-b', 'Still working', 1),
    ], fixture.threadId, 0);
    expect(fixture.queue.pump(0)?.key).toBe('normal-1');

    fixture.queue.observe([fixture.item('blocked', 'agent-c', 'Needs you', 10, 'needs-you')], fixture.threadId, 10);
    expect(fixture.queue.pump(10)?.key).toBe('blocked');
    expect(fixture.queue.pump(2_609)).toBeNull();
    expect(fixture.queue.current?.key).toBe('blocked');
    expect(fixture.queue.pump(2_610)?.key).toBe('normal-2');
  });

  // risk: privacy — events from another chat must never enter the active thread's queue or history.
  it('rejects another thread’s events while retaining only current-thread history', () => {
    const fixture = new StatusRollupQueueFixture();
    fixture.queue.observe([
      fixture.item('local', 'agent-a', 'This thread', 0),
      fixture.item('foreign', 'agent-b', 'Other thread private activity', 1, 'failed', 'thread-b'),
    ], fixture.threadId, 0);

    expect(fixture.queue.pending.map(item => item.key)).toEqual(['local']);
    expect(fixture.queue.history.map(item => item.key)).toEqual(['local']);
    expect(fixture.queue.pump(0)?.threadId).toBe('thread-a');
    expect(fixture.queue.pending.some(item => item.text.includes('Other thread'))).toBe(false);
  });

  // risk: availability — an initial single check-in must render during setup without being replayed after mount.
  it('seeds one initial event while preserving its recorded history', () => {
    const fixture = new StatusRollupQueueFixture();
    const initial = fixture.item('initial', 'agent-a', 'Ready', 0);
    fixture.queue.observe([initial], fixture.threadId, 0);

    expect(fixture.queue.seed([initial], fixture.threadId, 0)?.key).toBe('initial');
    expect(fixture.queue.current?.key).toBe('initial');
    expect(fixture.queue.pending).toEqual([]);
    expect(fixture.queue.history.map(item => item.key)).toEqual(['initial']);
  });

  // risk: data accuracy — only an identical event key may be collapsed, not repeated text from the same agent.
  it('collapses exact duplicate keys but preserves distinct repeated actions', () => {
    const fixture = new StatusRollupQueueFixture();
    fixture.queue.observe([
      fixture.item('same', 'agent-a', 'Read file', 0),
      fixture.item('same', 'agent-a', 'Read file', 0),
      fixture.item('again', 'agent-a', 'Read file', 1),
    ], fixture.threadId, 1);

    expect(fixture.queue.pending.map(item => item.key)).toEqual(['same', 'again']);
  });

  // risk: event delivery — each displayed tool step must retain its label and start/result correlation for the glow.
  it('preserves action labels and tool correlation through presentation', () => {
    const fixture = new StatusRollupQueueFixture();
    const item = {
      ...fixture.item('tool-start', 'agent-a', 'Reading file', 0),
      kind: 'read' as const,
      phase: 'start' as const,
      correlationId: 'primary:thread-a:tool-1',
    };

    expect(fixture.queue.present(item, fixture.threadId, 0)).toMatchObject({
      kind: 'read',
      phase: 'start',
      correlationId: 'primary:thread-a:tool-1',
    });
  });

  // risk: privacy — event text remains inert plain text and foreign root fallbacks are rejected.
  it('sanitizes event text and rejects a cross-thread fallback', () => {
    const fixture = new StatusRollupQueueFixture();
    const item = fixture.item('safe', 'agent', '  <b>literal</b>\nupdate\u0000 ', 0);
    expect(fixture.queue.present(item, fixture.threadId, 0)?.text).toBe('<b>literal</b> update');
    expect(fixture.queue.present(fixture.item('foreign-root', 'root', 'fallback', 0, 'normal', 'thread-b'), fixture.threadId, 0)).toBeNull();
  });
});
