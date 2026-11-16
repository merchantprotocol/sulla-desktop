import { describe, expect, it } from 'vitest';
import { ChunkAccessTracker } from '../src/chunkCache/access.js';
import { DEFAULT_CACHE_MAX_BYTES, cacheMaxBytes } from '../src/chunkCache/budget.js';
import { chunks, MAX_EMBEDDING_BATCH_CHARS, MAX_EMBEDDING_BATCH_TEXTS } from '../src/indexing.js';

describe('files scale bounds', () => {
  it('keeps the on-disk chunk cache default and bounds queued access events', async() => {
    // risk: native-memory — event bursts cannot retain a collection-sized map.
    // The cache is disk-backed (offline availability); its default is not a memory cap and must not shrink.
    expect(DEFAULT_CACHE_MAX_BYTES).toBe(20 * 1024 ** 3);
    expect(cacheMaxBytes(String(8 * 1024 * 1024))).toBe(8 * 1024 * 1024);
    const calls:any[] = [];
    const tracker = new ChunkAccessTracker({ query: async(...args:any[]) => { calls.push(args); return { rows:[], rowCount:0 } } } as any, 60_000, 25);
    for (let i = 0; i < 250; i++) tracker.record('collection', `chunk-${i}`);
    expect(tracker.pendingSize).toBeLessThanOrEqual(25);
    await tracker.flush();
    expect(tracker.pendingSize).toBe(0);
    expect(JSON.parse(calls[0][1][0])).toHaveLength(25);
  });

  it('yields embedding inputs incrementally within both batch limits for a huge backlog', () => {
    // risk: native-memory — a large source does not allocate an array of every chunk/text batch.
    expect(MAX_EMBEDDING_BATCH_TEXTS).toBe(1);
    const iterator = chunks('x'.repeat(10 * 1024 * 1024));
    let count = 0;
    for (let next = iterator.next(); !next.done; next = iterator.next()) {
      expect(next.value.length).toBeLessThanOrEqual(MAX_EMBEDDING_BATCH_CHARS);
      count++;
    }
    expect(count).toBeGreaterThan(1_000);
  });
});
