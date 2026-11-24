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
import { TurnToolActivity } from '../../../services/TurnToolActivity';
import { LONG_TOOL_CEILING_MS } from '../../../services/RunLivenessClock';
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

  // Jonathon (2026-11-24): judge liveness by the whole agent loop, not chat messages.
  it('keeps a job alive that sends no chat or check-in but keeps making provider tool calls', async() => {
    // risk: orchestration liveness — busy workers were reaped because tool calls never touched the job clock
    vi.mocked(SullaSettingsModel.get).mockResolvedValue(30 as any);
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const onDead = vi.fn();
    const stop = watchForDeadRun('tools-only-spawn', onDead, async() => false, { createdAt: 0, hasCheckin: async() => false });
    const turn = new TurnToolActivity({ activityKeys: ['tools-only-spawn'] });
    for (let call = 0; call < 6; call++) {
      await vi.advanceTimersByTimeAsync(20 * 60_000);
      turn.started(`call-${ call }`, 'command_execution');
      await vi.advanceTimersByTimeAsync(60_000);
      turn.finished(`call-${ call }`);
    }
    expect(onDead).not.toHaveBeenCalled();
    turn.close();
    stop();
  });

  it('keeps a job alive while a provider tool runs for 90 minutes, then reports a hung tool past the ceiling', async() => {
    // risk: orchestration liveness — a long build is reaped as a dead agent instead of a running tool
    vi.mocked(SullaSettingsModel.get).mockResolvedValue(30 as any);
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const onDead = vi.fn();
    const stop = watchForDeadRun('long-tool-spawn', onDead, async() => false, { createdAt: 0, hasCheckin: async() => true });
    const turn = new TurnToolActivity({ activityKeys: ['long-tool-spawn'] });
    turn.started('build-1', 'yarn build');
    await vi.advanceTimersByTimeAsync(90 * 60_000);
    expect(onDead).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(LONG_TOOL_CEILING_MS - 90 * 60_000 + 60_000);
    expect(onDead).toHaveBeenCalledOnce();
    expect(onDead.mock.calls[0][1]).toBe('tool_hung');
    expect(onDead.mock.calls[0][0]).toMatch(/^tool still running for 120m: yarn build/);
    turn.close();
    stop();
  });

  it('stops a job with no events of any kind for the limit', async() => {
    // risk: orchestration liveness — a truly dead run must still be reaped
    vi.mocked(SullaSettingsModel.get).mockResolvedValue(30 as any);
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const onDead = vi.fn();
    const stop = watchForDeadRun('dead-spawn', onDead, async() => false, { createdAt: 0, hasCheckin: async() => true });
    const turn = new TurnToolActivity({ activityKeys: ['dead-spawn'] });
    turn.started('call-1', 'command_execution');
    turn.finished('call-1');
    await vi.advanceTimersByTimeAsync(29 * 60_000);
    expect(onDead).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(onDead).toHaveBeenCalledOnce();
    expect(onDead.mock.calls[0]).toEqual(['no agent activity for 30 minute(s) (limit 30)', 'idle']);
    stop();
  });
});
