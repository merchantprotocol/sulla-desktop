// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import { ExpiringRequestCache } from '../../../app/Services/ExpiringRequestCache';

class FakeClock {
  constructor(private time = 0) {}
  now(): Date { return new Date(this.time); }
  advance(milliseconds: number): void { this.time += milliseconds; }
}

describe('ExpiringRequestCache', () => {
  it('bounds entries, expires values, and isolates service instances', async() => {
    // risk: stale or cross-instance provider catalog data
    const clock = new FakeClock();
    const first = new ExpiringRequestCache<string>(clock, 2);
    const second = new ExpiringRequestCache<string>(clock, 2);
    let loads = 0;
    const load = async(value: string) => ({ value: `${value}-${++loads}`, ttlMs: 10 });

    expect(await first.getOrLoad('a', () => load('a'))).toBe('a-1');
    expect(await first.getOrLoad('a', () => load('a'))).toBe('a-1');
    expect(await second.getOrLoad('a', () => load('a'))).toBe('a-2');
    await first.getOrLoad('b', () => load('b'));
    await first.getOrLoad('c', () => load('c'));
    expect(first.size).toBe(2);

    expect(await first.getOrLoad('a', () => load('a'))).toBe('a-5');
    clock.advance(11);
    expect(await first.getOrLoad('a', () => load('a'))).toBe('a-6');
  });

  it('deduplicates concurrent loads and clears completed and pending state', async() => {
    // risk: duplicate external provider requests
    const cache = new ExpiringRequestCache<string>(new FakeClock(), 2);
    let resolve!: (value: { value: string; ttlMs: number }) => void;
    const deferred = new Promise<{ value: string; ttlMs: number }>(done => { resolve = done; });

    const first = cache.getOrLoad('same', () => deferred);
    const second = cache.getOrLoad('same', () => deferred);
    expect(cache.pendingSize).toBe(1);
    resolve({ value: 'one request', ttlMs: 100 });
    expect(await Promise.all([first, second])).toEqual(['one request', 'one request']);
    expect(cache.pendingSize).toBe(0);
    cache.clear();
    expect(cache.size).toBe(0);
  });
});
