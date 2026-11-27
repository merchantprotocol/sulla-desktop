// Sulla Desktop · https://sulladesktop.com
// SPDX-License-Identifier: GPL-2.0-or-later
import fc from 'fast-check';
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

describe('runner-owned graphs', () => {
  const minute = 60_000;

  it('checkpoints an expired parked runner once per TTL without dropping it', async() => {
    let now = 0;
    const save = vi.fn(async() => {});
    const cache = new ThreadGraphCache(save, () => false, () => now);
    const entry = record({ runtimeRunnerActive: true });

    try {
      cache.set('manager', entry);
      now = 16 * minute;
      await cache.evictIdle();
      expect(save).toHaveBeenCalledTimes(1);
      expect(cache.has('manager')).toBe(true); // get() would refresh lastAccessAt
      now += minute;
      await cache.evictIdle();
      expect(save).toHaveBeenCalledTimes(1);
      expect(save).toHaveBeenCalledWith(entry.state);
      expect(cache.get('manager')).toBe(entry);
    } finally {
      cache.clear();
    }
  });

  it('keeps the original entry if a runner acquires it during a save', async() => {
    let now = 0;
    let finishSave!: () => void;
    const save = vi.fn(() => new Promise<void>(resolve => { finishSave = resolve }));
    const cache = new ThreadGraphCache(save, () => false, () => now);
    const entry = record();

    try {
      cache.set('manager', entry);
      now = 16 * minute;
      const sweep = cache.evictIdle();
      expect(save).toHaveBeenCalledOnce();
      entry.state.metadata.runtimeRunnerActive = true;
      finishSave();
      await expect(sweep).resolves.toEqual([]);
      expect(cache.get('manager')).toBe(entry);
    } finally {
      cache.clear();
    }
  });

  it('reserves the full idle capacity for unowned graphs', async() => {
    const cache = new ThreadGraphCache(async() => {}, () => false, () => 0);

    try {
      cache.set('manager', record({ delegatedRunActive: true }));
      for (let i = 0; i < 14; i++) cache.set(String(i), record());
      await expect(cache.evictIdle()).resolves.toEqual(['0', '1']);
      expect(cache.has('manager')).toBe(true);
      expect(cache.size).toBe(13);
    } finally {
      cache.clear();
    }
  });

  it('retains live owners across park/resume churn and releases ended owners', async() => {
    const event = fc.record({
      id:     fc.integer({ min: 0, max: 29 }).map(String),
      action: fc.constantFrom('start', 'park', 'end', 'advance', 'sweep'),
      ticks:  fc.integer({ min: 1, max: 20 }),
    });

    await fc.assert(fc.asyncProperty(fc.array(event, { minLength: 50, maxLength: 120 }), async(events) => {
      let now = 0;
      const cache = new ThreadGraphCache(async() => {}, () => false, () => now);
      const owners = new Map<string, ReturnType<typeof record>>();
      const ended = new Map<string, number>();
      const start = (id: string) => {
        const entry = owners.get(id) ?? cache.get(id) ?? record();
        entry.state.metadata.runtimeRunnerActive = true;
        entry.state.metadata.delegatedRunActive = true;
        owners.set(id, entry);
        if (!cache.has(id)) cache.set(id, entry);
        ended.delete(id);
      };
      const end = (id: string) => {
        const entry = owners.get(id);
        if (!entry) return;
        entry.state.metadata.runtimeRunnerActive = false;
        entry.state.metadata.delegatedRunActive = false;
        owners.delete(id);
        ended.set(id, now);
      };
      const sweep = async() => {
        await cache.evictIdle();
        for (const id of owners.keys()) expect(cache.has(id)).toBe(true);
        for (const [id, at] of ended) {
          if (now - at > 15 * minute) expect(cache.has(id)).toBe(false);
        }
        expect(cache.size - owners.size).toBeLessThanOrEqual(12);
      };

      try {
        for (let i = 0; i < 20; i++) {
          start(String(i));
          cache.set(`other-${ i }`, record());
        }
        await sweep();
        for (const { action, id, ticks } of events) {
          if (action === 'start') start(id);
          if (action === 'park' && owners.has(id)) owners.get(id)!.state.metadata.delegatedRunActive = false;
          if (action === 'end') end(id);
          if (action === 'advance') now += ticks * minute;
          if (action === 'sweep') await sweep();
        }
        for (const id of owners.keys()) end(id);
        now += 16 * minute;
        await sweep();
        expect(cache.size).toBe(0);
      } finally {
        cache.clear();
      }
    }), { numRuns: 30 });
  });

  it.each([1, 5, 20])('measures retained graphs with %i parked managers', async(count) => {
    let now = 0;
    const cache = new ThreadGraphCache(async() => {}, () => false, () => now);

    try {
      global.gc?.();
      const before = process.memoryUsage().heapUsed;
      for (let i = 0; i < count; i++) {
        const entry = record({ threadId: String(i), runtimeRunnerActive: true });
        // Independent, materialized 2 KiB strings (not shared string ropes).
        entry.state.messages = Array.from({ length: 200 }, (_, j) => ({
          role:    j % 2 ? 'assistant' : 'user',
          content: Buffer.alloc(1536, (i + j) % 256).toString('base64'),
        }));
        cache.set(String(i), entry);
      }
      now = 16 * minute;
      for (let i = 0; i < 14; i++) cache.set(`idle-${ i }`, record());
      await cache.evictIdle();
      global.gc?.();
      const heapDelta = process.memoryUsage().heapUsed - before;
      const retained = cache.entries().filter(([id]) => !id.startsWith('idle-')).length;
      console.log(`parked=${ count } retained=${ retained } idle=${ cache.size - retained } heapDeltaBytes=${ heapDelta }`);
      expect(retained).toBe(count);
      expect(cache.size - retained).toBeLessThanOrEqual(12);
    } finally {
      cache.clear();
    }
  });
});
