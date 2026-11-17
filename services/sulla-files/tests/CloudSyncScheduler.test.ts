// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudSyncScheduler } from '../src/cloudSync/CloudSyncScheduler.js';

describe('CloudSyncScheduler', () => {
  afterEach(() => vi.useRealTimers());

  it('starts a pass immediately after a debounced local version wakeup', async() => {
    vi.useFakeTimers();
    let passes = 0;
    const scheduler = new CloudSyncScheduler(async() => { passes += 1 }, 1_000);
    scheduler.start();
    scheduler.nudge();
    await vi.advanceTimersByTimeAsync(0);
    expect(passes).toBe(1);
    scheduler.stop();
  });

  it('coalesces nudges arriving during a pass into one follow-up', async() => {
    vi.useFakeTimers();
    let finish!:() => void;
    let passes = 0;
    const scheduler = new CloudSyncScheduler(() => {
      passes += 1;
      if (passes === 1) return new Promise<void>(resolve => { finish = resolve });
      return Promise.resolve();
    }, 1_000);
    scheduler.start();
    const first = scheduler.kick();
    scheduler.nudge();
    scheduler.nudge();
    finish();
    await first;
    await vi.advanceTimersByTimeAsync(0);
    expect(passes).toBe(2);
    scheduler.stop();
  });
});
