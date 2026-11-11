// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';
import { TeamRecallDirectoryCache } from '../../../services/TeamRecallDirectoryCache';

describe('TeamRecallDirectoryCache', () => {
  it('reuses a directory read within the TTL and reloads after invalidation', async() => {
    // risk: stale team directory — a changed agent card must show up after invalidation
    let card = 'old';
    const load = vi.fn(async() => card);
    let clock = 0;
    const cache = new TeamRecallDirectoryCache(60_000, () => clock);
    expect(await cache.get('agent:lead', load)).toBe('old');
    expect(await cache.get('agent:lead', load)).toBe('old');
    expect(load).toHaveBeenCalledTimes(1);
    card = 'new';
    cache.invalidate();
    expect(await cache.get('agent:lead', load)).toBe('new');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('reloads once the TTL expires and never caches a failed read', async() => {
    // risk: a transient DB error must not pin an empty team roster for a minute
    let clock = 0;
    const cache = new TeamRecallDirectoryCache(1_000, () => clock);
    const load = vi.fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('db busy'))
      .mockResolvedValue('ok');
    await expect(cache.get('directory:a', load)).rejects.toThrow('db busy');
    expect(await cache.get('directory:a', load)).toBe('ok');
    clock = 1_000;
    expect(await cache.get('directory:a', load)).toBe('ok');
    expect(load).toHaveBeenCalledTimes(3);
  });
});
