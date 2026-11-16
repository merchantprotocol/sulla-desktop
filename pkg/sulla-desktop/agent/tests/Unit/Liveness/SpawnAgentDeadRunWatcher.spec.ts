// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@pkg/main/SleepPreventionService', () => ({ acquireChatActivity: vi.fn(), releaseChatActivity: vi.fn() }));
vi.mock('../../../database/models/SullaSettingsModel', () => ({
  SullaSettingsModel: { get: vi.fn(async() => 1) },
}));

import { RunActivity, watchForDeadRun } from '../../../services/RunActivity';
import { runTools } from '../../../services/RunToolTracker';
import { SullaSettingsModel } from '../../../database/models/SullaSettingsModel';

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

  it('keeps a streaming worker with no check-in alive past ten minutes and kills it only after the real threshold', async() => {
    // risk: orchestration liveness — live Opus workers were stopped at ~600 s with "no activity for 30 minutes".
    vi.mocked(SullaSettingsModel.get).mockResolvedValue(30 as any);
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const onDead = vi.fn();
    const stop = watchForDeadRun('streaming-spawn', onDead, async() => false, { createdAt: 0, hasCheckin: async() => false });
    const metadata = { activityKeys: ['streaming-spawn'] };
    for (let minute = 1; minute <= 12; minute++) {
      await vi.advanceTimersByTimeAsync(60_000);
      RunActivity.touch(metadata); // model tokens / tool calls
    }
    expect(onDead).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(29 * 60_000);
    expect(onDead).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(onDead).toHaveBeenCalledOnce();
    expect(onDead.mock.calls[0][0]).toBe('no agent activity for 30 minute(s) (limit 30)');
    stop();
  });

  it('treats a long-running tool call as activity', async() => {
    // risk: orchestration liveness — a worker running a long shell command emits nothing until it ends.
    vi.mocked(SullaSettingsModel.get).mockResolvedValue(30 as any);
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const onDead = vi.fn();
    const stop = watchForDeadRun('tool-spawn', onDead, async() => false, { createdAt: 0, hasCheckin: async() => true });
    const metadata = { activityKeys: ['tool-spawn'] };
    runTools.started(metadata, 'call-1', 'a command');
    await vi.advanceTimersByTimeAsync(45 * 60_000);
    expect(onDead).not.toHaveBeenCalled();
    runTools.finished(metadata, 'call-1');
    stop();
  });
});
