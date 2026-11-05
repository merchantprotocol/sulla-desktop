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

function detail(entries: AgentConversationDetail['entries']): AgentConversationDetail {
  return { id: 'thread-1', channel: 'worker', title: 'Run', status: 'running', createdAt: '', lastActiveAt: '', entries, truncated: false, missingLog: false };
}

describe('AgentDetailFeed', () => {
  it('shows loading only on the first load and appends only new stable entries', async() => {
    // risk: activity continuity — a background poll must not remount or duplicate the feed.
    const first = new Deferred<AgentConversationDetail>();
    const secondEntry = { kind: 'assistant' as const, ts: '2026-11-05T01:00:01Z', text: 'second' };
    const firstEntry = { kind: 'user' as const, ts: '2026-11-05T01:00:00Z', text: 'first' };
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
    await vi.waitFor(() => expect(snapshots.at(-1)?.detail?.entries).toEqual([firstEntry]));

    const loadingEventsBeforeRefresh = snapshots.filter(snapshot => snapshot.loading).length;
    await feed.refresh();
    expect(snapshots.filter(snapshot => snapshot.loading)).toHaveLength(loadingEventsBeforeRefresh);
    expect(snapshots.at(-1)?.detail?.entries).toEqual([firstEntry, secondEntry]);

    await feed.refresh();
    expect(snapshots.at(-1)?.detail?.entries).toEqual([firstEntry, secondEntry]);
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
