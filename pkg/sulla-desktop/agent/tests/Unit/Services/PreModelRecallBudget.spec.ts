// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';
import { PreModelRecallBudget } from '../../../services/PreModelRecallBudget';

describe('PreModelRecallBudget', () => {
  it('returns recall results when work finishes inside the deadline', async() => {
    // risk: memory/context accuracy — fast recall must still be merged into the turn
    await expect(new PreModelRecallBudget().run(Promise.resolve('recalled facts'), 50))
      .resolves.toEqual({ status: 'completed', value: 'recalled facts' });
  });

  it('merges each on-time task and drops late tasks without permitting late mutation', async() => {
    // risk: memory/context accuracy and turn latency — a slow directory must not erase memory or mutate a live turn later
    vi.useFakeTimers();
    try {
      const live: Record<string, string> = {};
      let releaseLate!: (value: string) => void;
      const late = new Promise<string>(resolve => { releaseLate = resolve; });
      const work = new PreModelRecallBudget().runEach([
        { name: 'memory', work: Promise.resolve('memory'), apply: value => { live.memory = value } },
        { name: 'directory', work: late, apply: value => { live.directory = value } },
      ], 20);
      await vi.advanceTimersByTimeAsync(20);
      const result = await work;
      expect(live).toEqual({ memory: 'memory' });
      expect(result.dropped).toEqual(['directory']);
      releaseLate('late');
      await Promise.resolve();
      expect(live).toEqual({ memory: 'memory' });
    } finally { vi.useRealTimers(); }
  });

  it('reports a timeout instead of waiting for late recall', async() => {
    // risk: turn latency — slow recall must not hold up model handoff past its budget
    vi.useFakeTimers();
    try {
      const pending = new PreModelRecallBudget().run(new Promise<string>(() => undefined), 25);
      await vi.advanceTimersByTimeAsync(25);
      await expect(pending).resolves.toEqual({ status: 'timeout' });
    } finally { vi.useRealTimers(); }
  });
});
