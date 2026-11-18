// Sulla Desktop · https://sulladesktop.com
// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { ThreadGraphCache } from '../../../services/ThreadGraphCache';

const record = (metadata: Record<string, unknown> = {}) => ({
  graph: {} as any,
  state: { messages: [{ role: 'user', content: 'same state' }], metadata: { cycleComplete: true, waitingForUser: false, threadId: 't', ...metadata } } as any,
});

describe('ThreadGraphCache', () => {
  it('persists and evicts idle completed entries, retaining state for rehydration', async() => {
    // risk: data loss on cache eviction
    let now = 0;
    const saved: any[] = [];
    const cache = new ThreadGraphCache(async state => { saved.push(state); }, () => false, () => now, 15, 12);
    const entry = record();
    cache.set('t', entry);
    now = 16;
    await expect(cache.evictIdle()).resolves.toEqual(['t']);
    expect(cache.get('t')).toBeUndefined();
    expect(saved).toEqual([entry.state]);
  });

  it('never evicts running graphs, user-waiting graphs, or pinned approvals/questions', async() => {
    // risk: losing a live turn or a pending user decision
    let now = 0;
    const save = vi.fn(async() => {});
    const cache = new ThreadGraphCache(save, state => Boolean((state.metadata as any).pending), () => now, 15, 12);
    cache.set('running', record({ cycleComplete: false }));
    cache.set('waiting', record({ waitingForUser: true }));
    cache.set('pending', record({ pending: true }));
    now = 100;
    await cache.evictIdle();
    expect(cache.size).toBe(3);
    expect(save).not.toHaveBeenCalled();
  });

  it('keeps the entry when durable save fails', async() => {
    // risk: data loss on failed persistence
    let now = 0;
    const entry = record();
    const cache = new ThreadGraphCache(async() => { throw new Error('store unavailable'); }, () => false, () => now, 15, 12);
    cache.set('t', entry);
    now = 16;
    await expect(cache.evictIdle()).resolves.toEqual([]);
    expect(cache.get('t')).toBe(entry);
  });

  it('keeps a graph that becomes active while its state is being saved', async() => {
    // risk: dropping a graph after a new turn starts during persistence
    let now = 0;
    const entry = record();
    const cache = new ThreadGraphCache(async state => {
      (state.metadata as any).cycleComplete = false;
    }, () => false, () => now, 15, 12);
    cache.set('t', entry);
    now = 16;
    await expect(cache.evictIdle()).resolves.toEqual([]);
    expect(cache.get('t')).toBe(entry);
  });

  it('caps idle cache entries by evicting least-recently-used entries', async() => {
    // risk: unbounded retained thread graphs
    let now = 0;
    const cache = new ThreadGraphCache(async() => {}, () => false, () => now, 15, 2);
    cache.set('oldest', record());
    now++;
    cache.set('middle', record());
    now++;
    cache.set('newest', record());
    await cache.evictIdle();
    expect(cache.get('oldest')).toBeUndefined();
    expect(cache.size).toBe(2);
  });
});
