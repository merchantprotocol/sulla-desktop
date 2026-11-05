// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlaybookController } from '../../../controllers/PlaybookController';

describe('PlaybookController sub-agent watchdog liveness floor', () => {
  afterEach(() => vi.useRealTimers());

  it('never declares a no-check-in sub-agent truly stalled before ten minutes', async() => {
    // risk: orchestration liveness — three two-minute bumps must not kill a fresh worker at six minutes.
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const controller = new PlaybookController({} as any);
    const state = { metadata: {} };
    const execution = (controller as any).raceWithSubAgentWatchdog(state, 'fresh worker', () => new Promise(() => undefined));
    let settled = false;
    void execution.finally(() => { settled = true; }).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(61_000);
    await expect(execution).rejects.toThrow('truly stalled');
  });
});
