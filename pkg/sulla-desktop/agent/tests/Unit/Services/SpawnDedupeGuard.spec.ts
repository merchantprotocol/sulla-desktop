// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import { SpawnDedupeGuard } from '../../../app/Services/SpawnDedupeGuard';

class TestClock {
  constructor(public nowMs: number) {}
  now(): Date { return new Date(this.nowMs); }
}

describe('SpawnDedupeGuard', () => {
  it('reuses the first result for a concurrent same-key retry', async() => {
    const clock = new TestClock(10_000);
    const guard = new SpawnDedupeGuard(clock as any);
    let creates = 0;
    let existing: { createdAt: number; status: string; id: number } | undefined;
    const create = async() => {
      creates += 1;
      await new Promise(resolve => setTimeout(resolve, 0));
      existing = { createdAt: clock.nowMs, status: 'running', id: creates };
      return existing;
    };
    const find = async() => existing;

    const [first, second] = await Promise.all([
      guard.run('parent\0worker', find, create),
      guard.run('parent\0worker', find, create),
    ]);

    expect(creates).toBe(1); // risk: duplicate worker execution
    expect(first.value.id).toBe(second.value.id);
    expect(second.deduplicated).toBe(true);
  });

  it('does not reuse an absent label, a different key, or a job older than 30 seconds', async() => {
    const clock = new TestClock(100_000);
    const guard = new SpawnDedupeGuard(clock as any);
    let creates = 0;
    const create = async() => ({ createdAt: clock.nowMs, status: 'running', id: ++creates });
    const find = async() => undefined;

    await guard.run(undefined, find, create);
    await guard.run('other-parent\\0worker', find, create);
    expect(creates).toBe(2); // risk: parent/label isolation

    expect(guard.isEligible({ createdAt: clock.nowMs - 30_001, status: 'running' })).toBe(false); // risk: stale retry
    expect(guard.isEligible({ createdAt: clock.nowMs, status: 'stopped' })).toBe(false); // risk: stopped job resurrection
  });
});
