// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@pkg/main/SleepPreventionService', () => ({ acquireChatActivity: vi.fn(), releaseChatActivity: vi.fn() }));
vi.mock('../../../database/models/SullaSettingsModel', () => ({
  SullaSettingsModel: { get: vi.fn(async() => 1) },
}));

import { watchForDeadRun } from '../../../services/RunActivity';

describe('SpawnAgentDeadRunWatcher liveness floor', () => {
  afterEach(() => vi.useRealTimers());

  it('does not stop a no-check-in spawn at the configured one-minute threshold', async() => {
    // risk: orchestration liveness — a fresh worker can be killed before its first progress report.
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const onDead = vi.fn();
    const stop = watchForDeadRun('fresh-spawn', onDead, async() => false, { createdAt: 0, hasCheckin: async() => false });
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(onDead).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(8 * 60_000);
    expect(onDead).toHaveBeenCalledOnce();
    stop();
  });
});
