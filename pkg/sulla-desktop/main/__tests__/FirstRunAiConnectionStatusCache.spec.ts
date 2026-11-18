// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { FirstRunAiConnectionStatusCache } from '../FirstRunAiConnectionStatusCache';

describe('FirstRunAiConnectionStatusCache', () => {
  it('reuses a fresh result and refreshes it after the TTL', async() => {
    // risk: availability — sends must not repeatedly wait on slow vault account lookups.
    let now = 0;
    const read = vi.fn(async() => ({ pending: [], connected: true, loading: false }));
    const cache = new FirstRunAiConnectionStatusCache(read, 30, () => now);
    await cache.get();
    await cache.get();
    expect(read).toHaveBeenCalledTimes(1);
    now = 31;
    await cache.get();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('deduplicates concurrent reads and invalidates after account changes', async() => {
    // risk: availability — concurrent sends share one status lookup and account changes are not masked.
    let resolve!: (value: { pending: string[]; connected: boolean; loading: boolean }) => void;
    const read = vi.fn(() => new Promise<{ pending: string[]; connected: boolean; loading: boolean }>(r => { resolve = r; }));
    const cache = new FirstRunAiConnectionStatusCache(read);
    const one = cache.get();
    const two = cache.get();
    expect(read).toHaveBeenCalledTimes(1);
    resolve({ pending: [], connected: true, loading: false });
    await Promise.all([one, two]);
    cache.invalidate();
    const refreshed = cache.get();
    expect(read).toHaveBeenCalledTimes(2);
    resolve({ pending: [], connected: false, loading: false });
    await refreshed;
  });
});
