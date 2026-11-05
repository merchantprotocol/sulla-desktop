// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it, vi } from 'vitest';

import { AgentDetailFeed, type FeedSnapshot, type VisibilitySource } from '@pkg/components/studio/live/AgentDetailFeed';
import type { AgentConversationDetail } from '@pkg/main/agentsIpc';

class FakeVisibilitySource implements VisibilitySource {
  hidden = false;
  private listener: (() => void) | undefined;

  addEventListener(_type: 'visibilitychange', listener: () => void): void {
    this.listener = listener;
  }

  removeEventListener(_type: 'visibilitychange', listener: () => void): void {
    if (this.listener === listener) this.listener = undefined;
  }

  change(hidden: boolean): void {
    this.hidden = hidden;
    this.listener?.();
  }
}

class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;

  constructor() {
    this.promise = new Promise(resolve => {
      this.resolve = resolve;
    });
  }
}

function detail(
  entries: AgentConversationDetail['entries'],
  id = 'thread-1',
  logIdentity?: AgentConversationDetail['logIdentity'],
): AgentConversationDetail {
  return { id, channel: 'worker', title: 'Run', status: 'running', createdAt: '', lastActiveAt: '', entries, logIdentity, truncated: false, missingLog: false };
}

function entryTexts(snapshot: FeedSnapshot | undefined): string[] {
  return snapshot?.detail?.entries.map(entry => entry.text) ?? [];
}

describe('AgentDetailFeed', () => {
  it('shows loading only on the first load and appends only new stable entries', async() => {
    // risk: activity continuity — a background poll must not remount or duplicate the feed.
    const first = new Deferred<AgentConversationDetail>();
    const secondEntry = { kind: 'assistant' as const, ts: '2026-11-05T01:00:01Z', text: 'second', offset: 20 };
    const firstEntry = { kind: 'user' as const, ts: '2026-11-05T01:00:00Z', text: 'first', offset: 0 };
    const invoke = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(detail([firstEntry, secondEntry]))
      .mockResolvedValueOnce(detail([firstEntry, secondEntry]));
    const snapshots: FeedSnapshot[] = [];
    const visibility = new FakeVisibilitySource();
    const feed = new AgentDetailFeed(invoke, visibility, setInterval, clearInterval, snapshot => snapshots.push(snapshot));

    feed.select('thread-1');
    expect(snapshots.at(-1)?.loading).toBe(true);
    first.resolve(detail([firstEntry]));
    await first.promise;
    await vi.waitFor(() => expect(entryTexts(snapshots.at(-1))).toEqual(['first']));

    const loadingEventsBeforeRefresh = snapshots.filter(snapshot => snapshot.loading).length;
    await feed.refresh();
    expect(snapshots.filter(snapshot => snapshot.loading)).toHaveLength(loadingEventsBeforeRefresh);
    expect(entryTexts(snapshots.at(-1))).toEqual(['first', 'second']);

    await feed.refresh();
    expect(entryTexts(snapshots.at(-1))).toEqual(['first', 'second']);
    feed.dispose();
  });

  it('preserves identical consecutive events with unique render sequences', async() => {
    // risk: activity accuracy — repeated tool records are distinct append-only log events.
    const repeated = { kind: 'tool' as const, ts: '2026-11-05T01:00:00Z', text: '{}', toolName: 'status', offset: 10 };
    const repeatedAppend = { ...repeated, offset: 20 };
    const snapshots: FeedSnapshot[] = [];
    const invoke = vi.fn().mockResolvedValueOnce(detail([repeated])).mockResolvedValueOnce(detail([repeated, repeatedAppend]));
    const feed = new AgentDetailFeed(invoke, new FakeVisibilitySource(), setInterval, clearInterval, snapshot => snapshots.push(snapshot));

    feed.select('thread-1');
    await vi.waitFor(() => expect(entryTexts(snapshots.at(-1))).toHaveLength(1));
    await feed.refresh();

    expect(entryTexts(snapshots.at(-1))).toEqual(['{}', '{}']);
    expect(new Set(snapshots.at(-1)?.detail?.entries.map(entry => entry.feedSequence)).size).toBe(2);
    feed.dispose();
  });

  it('appends an identical new boundary row when a capped window slides', async() => {
    // risk: activity accuracy — identical content at a moving cap boundary must remain a distinct event.
    const entries = ['a', 'same', 'c', 'same'].map((text, index) => ({ kind: 'event' as const, ts: `${ index }`, text, offset: index * 10 }));
    const snapshots: FeedSnapshot[] = [];
    const invoke = vi.fn().mockResolvedValueOnce(detail(entries.slice(0, 3))).mockResolvedValueOnce(detail(entries.slice(1)));
    const feed = new AgentDetailFeed(invoke, new FakeVisibilitySource(), setInterval, clearInterval, snapshot => snapshots.push(snapshot));

    feed.select('thread-1');
    await vi.waitFor(() => expect(entryTexts(snapshots.at(-1))).toHaveLength(3));
    await feed.refresh();

    expect(entryTexts(snapshots.at(-1))).toEqual(['a', 'same', 'c', 'same']);
    feed.dispose();
  });

  it('appends a zero-overlap window using source offsets', async() => {
    // risk: activity accuracy — a tail that advances beyond all retained rows must not disappear.
    const first = [{ kind: 'event' as const, ts: '1', text: 'old', offset: 10 }];
    const next = [{ kind: 'event' as const, ts: '2', text: 'new', offset: 200 }];
    const snapshots: FeedSnapshot[] = [];
    const feed = new AgentDetailFeed(vi.fn().mockResolvedValueOnce(detail(first)).mockResolvedValueOnce(detail(next)), new FakeVisibilitySource(), setInterval, clearInterval, snapshot => snapshots.push(snapshot));

    feed.select('thread-1');
    await vi.waitFor(() => expect(entryTexts(snapshots.at(-1))).toEqual(['old']));
    await feed.refresh();
    expect(entryTexts(snapshots.at(-1))).toEqual(['old', 'new']);
    feed.dispose();
  });

  it('replaces a truncated log generation, then appends new records exactly once', async() => {
    // risk: activity continuity — log rotation must not freeze the feed at stale high offsets.
    const oldEntry = { kind: 'event' as const, ts: '1', text: 'old generation', offset: 900 };
    const replacement = { kind: 'event' as const, ts: '2', text: 'replacement', offset: 0 };
    const appended = { kind: 'event' as const, ts: '3', text: 'appended', offset: 30 };
    const oldIdentity = { size: 1_000, ino: 10, birthtimeMs: 100 };
    const replacementIdentity = { size: 30, ino: 11, birthtimeMs: 200 };
    const appendedIdentity = { ...replacementIdentity, size: 60 };
    const snapshots: FeedSnapshot[] = [];
    const invoke = vi.fn()
      .mockResolvedValueOnce(detail([oldEntry], 'thread-1', oldIdentity))
      .mockResolvedValueOnce(detail([replacement], 'thread-1', replacementIdentity))
      .mockResolvedValueOnce(detail([replacement, appended], 'thread-1', appendedIdentity))
      .mockResolvedValueOnce(detail([replacement, appended], 'thread-1', appendedIdentity));
    const feed = new AgentDetailFeed(invoke, new FakeVisibilitySource(), setInterval, clearInterval, snapshot => snapshots.push(snapshot));

    feed.select('thread-1');
    await vi.waitFor(() => expect(entryTexts(snapshots.at(-1))).toEqual(['old generation']));
    await feed.refresh();
    expect(entryTexts(snapshots.at(-1))).toEqual(['replacement']);
    await feed.refresh();
    expect(entryTexts(snapshots.at(-1))).toEqual(['replacement', 'appended']);
    await feed.refresh();
    expect(entryTexts(snapshots.at(-1))).toEqual(['replacement', 'appended']);
    feed.dispose();
  });

  it('retains log identity through a missing-log poll before replacing and appending', async() => {
    // risk: activity continuity — a transient missing log must not freeze replacement rows below stale offsets.
    const oldEntry = { kind: 'event' as const, ts: '1', text: 'old generation', offset: 900 };
    const replacement = { kind: 'event' as const, ts: '2', text: 'replacement', offset: 0 };
    const appended = { kind: 'event' as const, ts: '3', text: 'appended', offset: 30 };
    const oldIdentity = { size: 1_000, ino: 10, birthtimeMs: 100 };
    const replacementIdentity = { size: 30, ino: 11, birthtimeMs: 200 };
    const missing = { ...detail([], 'thread-1'), missingLog: true };
    const snapshots: FeedSnapshot[] = [];
    const invoke = vi.fn()
      .mockResolvedValueOnce(detail([oldEntry], 'thread-1', oldIdentity))
      .mockResolvedValueOnce(missing)
      .mockResolvedValueOnce(detail([replacement], 'thread-1', replacementIdentity))
      .mockResolvedValueOnce(detail([replacement, appended], 'thread-1', { ...replacementIdentity, size: 60 }))
      .mockResolvedValueOnce(detail([replacement, appended], 'thread-1', { ...replacementIdentity, size: 60 }));
    const feed = new AgentDetailFeed(invoke, new FakeVisibilitySource(), setInterval, clearInterval, snapshot => snapshots.push(snapshot));

    feed.select('thread-1');
    await vi.waitFor(() => expect(entryTexts(snapshots.at(-1))).toEqual(['old generation']));
    await feed.refresh();
    expect(entryTexts(snapshots.at(-1))).toEqual(['old generation']);
    await feed.refresh();
    expect(entryTexts(snapshots.at(-1))).toEqual(['replacement']);
    await feed.refresh();
    expect(entryTexts(snapshots.at(-1))).toEqual(['replacement', 'appended']);
    await feed.refresh();

    expect(entryTexts(snapshots.at(-1))).toEqual(['replacement', 'appended']);
    expect(snapshots.at(-1)?.loading).toBe(false);
    feed.dispose();
  });

  it('does not replace a log when birthtime is unavailable on consecutive polls', async() => {
    // risk: activity continuity — an unavailable birth time must not remount unchanged activity every poll.
    const stable = { kind: 'event' as const, ts: '1', text: 'stable', offset: 10 };
    const unavailableBirthtime = { size: 40, ino: 10, birthtimeMs: Number.NaN };
    const snapshots: FeedSnapshot[] = [];
    const feed = new AgentDetailFeed(
      vi.fn().mockResolvedValue(detail([stable], 'thread-1', unavailableBirthtime)),
      new FakeVisibilitySource(),
      setInterval,
      clearInterval,
      snapshot => snapshots.push(snapshot),
    );

    feed.select('thread-1');
    await vi.waitFor(() => expect(entryTexts(snapshots.at(-1))).toEqual(['stable']));
    const sequence = snapshots.at(-1)?.detail?.entries[0]?.feedSequence;
    await feed.refresh();

    expect(entryTexts(snapshots.at(-1))).toEqual(['stable']);
    expect(snapshots.at(-1)?.detail?.entries[0]?.feedSequence).toBe(sequence);
    feed.dispose();
  });

  it('keeps a same-identity, same-size reread unchanged', async() => {
    // risk: activity accuracy — an unchanged poll must not duplicate already rendered records.
    const entry = { kind: 'event' as const, ts: '1', text: 'stable', offset: 10 };
    const logIdentity = { size: 40, ino: 10, birthtimeMs: 100 };
    const snapshots: FeedSnapshot[] = [];
    const feed = new AgentDetailFeed(
      vi.fn().mockResolvedValue(detail([entry], 'thread-1', logIdentity)),
      new FakeVisibilitySource(),
      setInterval,
      clearInterval,
      snapshot => snapshots.push(snapshot),
    );

    feed.select('thread-1');
    await vi.waitFor(() => expect(entryTexts(snapshots.at(-1))).toEqual(['stable']));
    const sequence = snapshots.at(-1)?.detail?.entries[0]?.feedSequence;
    await feed.refresh();

    expect(entryTexts(snapshots.at(-1))).toEqual(['stable']);
    expect(snapshots.at(-1)?.detail?.entries[0]?.feedSequence).toBe(sequence);
    feed.dispose();
  });

  it('appends legacy entries without offsets rather than dropping them', async() => {
    // risk: backward compatibility — an older IPC payload must remain visible even without source identity.
    const legacy = { kind: 'event' as const, ts: '1', text: 'legacy' };
    const snapshots: FeedSnapshot[] = [];
    const feed = new AgentDetailFeed(vi.fn().mockResolvedValue(detail([legacy])), new FakeVisibilitySource(), setInterval, clearInterval, snapshot => snapshots.push(snapshot));

    feed.select('thread-1');
    await vi.waitFor(() => expect(entryTexts(snapshots.at(-1))).toEqual(['legacy']));
    await feed.refresh();
    expect(entryTexts(snapshots.at(-1))).toEqual(['legacy', 'legacy']);
    feed.dispose();
  });

  it('keeps existing activity when a reread is shorter', async() => {
    // risk: activity continuity — a transient shorter read must not duplicate or drop history.
    const entries = ['a', 'b', 'c'].map((text, index) => ({ kind: 'event' as const, ts: `${ index }`, text, offset: index * 10 }));
    const snapshots: FeedSnapshot[] = [];
    const invoke = vi.fn().mockResolvedValueOnce(detail(entries)).mockResolvedValueOnce(detail(entries.slice(0, 2)));
    const feed = new AgentDetailFeed(invoke, new FakeVisibilitySource(), setInterval, clearInterval, snapshot => snapshots.push(snapshot));

    feed.select('thread-1');
    await vi.waitFor(() => expect(entryTexts(snapshots.at(-1))).toHaveLength(3));
    await feed.refresh();

    expect(entryTexts(snapshots.at(-1))).toEqual(['a', 'b', 'c']);
    feed.dispose();
  });

  it('ignores a stale final fetch without stopping polling for a newly selected thread', async() => {
    // risk: activity continuity — completion of the prior thread must not disable the new thread feed.
    const finalFetch = new Deferred<AgentConversationDetail>();
    const clearTimer = vi.fn();
    const setTimer = vi.fn(() => 7 as unknown as ReturnType<typeof setInterval>);
    const snapshots: FeedSnapshot[] = [];
    const invoke = vi.fn()
      .mockResolvedValueOnce(detail([{ kind: 'event', ts: '1', text: 'old', offset: 1 }]))
      .mockReturnValueOnce(finalFetch.promise)
      .mockResolvedValueOnce(detail([{ kind: 'event', ts: '2', text: 'new', offset: 2 }], 'thread-2'));
    const feed = new AgentDetailFeed(invoke, new FakeVisibilitySource(), setTimer, clearTimer, snapshot => snapshots.push(snapshot));

    feed.select('thread-1');
    await vi.waitFor(() => expect(entryTexts(snapshots.at(-1))).toEqual(['old']));
    const finishing = feed.finish();
    feed.select('thread-2');
    await vi.waitFor(() => expect(entryTexts(snapshots.at(-1))).toEqual(['new']));
    finalFetch.resolve(detail([{ kind: 'event', ts: '3', text: 'stale', offset: 3 }]));
    await finishing;

    expect(entryTexts(snapshots.at(-1))).toEqual(['new']);
    expect(clearTimer).not.toHaveBeenCalled();
    feed.dispose();
  });

  it('pauses while hidden and refreshes immediately when visible', async() => {
    // risk: resource usage — hidden pages must not poll, but returning users need fresh activity.
    const visibility = new FakeVisibilitySource();
    visibility.hidden = true;
    const invoke = vi.fn().mockResolvedValue(detail([]));
    const feed = new AgentDetailFeed(invoke, visibility, setInterval, clearInterval, () => undefined);

    feed.select('thread-1');
    feed.start();
    await feed.refresh();
    expect(invoke).not.toHaveBeenCalled();

    visibility.change(false);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    feed.dispose();
  });
});
