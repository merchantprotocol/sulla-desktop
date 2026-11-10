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

  it('reports a timeout instead of waiting for late recall', async() => {
    // risk: turn latency — slow recall must not hold up model handoff past its budget
    vi.useFakeTimers();
    try {
      const pending = new PreModelRecallBudget().run(new Promise<string>(() => undefined), 25);
      await vi.advanceTimersByTimeAsync(25);
      await expect(pending).resolves.toEqual({ status: 'timeout' });
    } finally {
      vi.useRealTimers();
    }
  });
});
