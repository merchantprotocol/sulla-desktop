// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatHeartbeatScheduler } from '../../../services/ChatHeartbeatScheduler';
import { HeartbeatNoticeBuilder } from '../../../services/HeartbeatNoticeBuilder';

const MINUTE = 60_000;
const SIX_HOURS_MS = 6 * 60 * 60_000;
const START = Date.UTC(2026, 10, 24, 20, 0, 0);

function schedulerHarness(hasPendingWait?: (target: { jobId: string; taskIndex: number }) => Promise<boolean>) {
  const deliver = vi.fn(async() => true);
  const beats: any[] = [];
  const configs: any[] = [];
  const statuses: any[] = [];
  const scheduler = new ChatHeartbeatScheduler({
    now:         () => Date.now(), // Injected clock; Vitest advances it with the timers.
    isGraphBusy: () => false,
    deliver,
    noticeBuilder: new HeartbeatNoticeBuilder('America/Los_Angeles'),
    hasPendingWait,
  });
  return { scheduler, deliver, beats, configs, statuses };
}

describe('ChatHeartbeatScheduler lifecycle', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(START) });
  afterEach(() => { vi.useRealTimers() });

  it('appends a system notice to each delivered beat without changing the caller message', async() => {
    // risk: a heartbeat without the system off-switch/expiry notice can run forever.
    const { scheduler, deliver, beats } = schedulerHarness();
    scheduler.register({
      threadId: 'chat-1', channel: 'sulla-desktop', config: { intervalMinutes: 2, message: 'Check my open work.' },
      onBeat: beat => beats.push(beat),
    });

    await vi.advanceTimersByTimeAsync(2 * MINUTE);

    const delivered = String(deliver.mock.calls[0]?.[2]);
    expect(delivered).toContain('Check my open work.\n\n--- HEARTBEAT NOTICE ---');
    expect(delivered).toContain('Heartbeat notice: This message was sent automatically by your heartbeat');
    expect(delivered).toContain('It fires every 2 minutes; it was set at Nov 24, 2026, 12:00 PM PST by the human');
    expect(delivered).toContain('switches itself off at Nov 24, 2026, 6:00 PM PST');
    expect(delivered).toContain('sulla chat/set_heartbeat \'{"intervalMinutes":0}\'');
    expect(scheduler.status('chat-1')?.message).toBe('Check my open work.');
    expect(beats[0]?.message).toBe(delivered);
  });

  it('keeps an existing agents/wait timer and explains that it remains pending', async() => {
    // risk: agents/wait can be silently lost or misrepresented when a heartbeat wakes a parked job.
    const hasPendingWait = vi.fn(async() => true);
    const { scheduler, deliver } = schedulerHarness(hasPendingWait);
    scheduler.register({
      threadId: 'job-wait-thread', channel: 'sulla-desktop', jobId: 'job-wait', taskIndex: 2,
      config: { intervalMinutes: 5, message: 'Continue reviewing.' },
    });

    await vi.advanceTimersByTimeAsync(5 * MINUTE);

    expect(hasPendingWait).toHaveBeenCalledWith({ jobId: 'job-wait', taskIndex: 2 });
    expect(String(deliver.mock.calls[0]?.[2])).toContain('Your agents/wait timer is still pending and will still wake you.');
  });

  it('turns itself off after six hours, delivers one final notice, then stops beating', async() => {
    // risk: forgotten heartbeat timers waste tokens indefinitely or repeatedly claim to have auto-stopped.
    const { scheduler, deliver, beats, configs, statuses } = schedulerHarness();
    scheduler.register({
      threadId: 'chat-expire', channel: 'sulla-desktop', config: { intervalMinutes: 60, message: 'Review the task.' },
      onBeat: beat => beats.push(beat), onConfig: config => configs.push(config), onStatus: status => statuses.push(status),
    });

    await vi.advanceTimersByTimeAsync(SIX_HOURS_MS);

    expect(scheduler.status('chat-expire')).toMatchObject({ enabled: false, intervalMinutes: null, startedAt: null, expiresAt: null });
    expect(configs.at(-1)).toMatchObject({ intervalMinutes: null, message: 'Review the task.' });
    const finalBeats = beats.filter(beat => beat.autoOff);
    expect(finalBeats).toHaveLength(1);
    expect(finalBeats[0].message).toContain('--- HEARTBEAT NOTICE ---');
    expect(finalBeats[0].message).toContain('Turn it off as soon as the work it watches is finished');
    expect(finalBeats[0].message).toContain('System: your heartbeat was switched off automatically after 6 hours.');
    expect(finalBeats[0].message).toContain('turn it back on with sulla chat/set_heartbeat');
    expect(statuses.at(-1)?.enabled).toBe(false);
    const deliveredAtOff = deliver.mock.calls.length;

    await vi.advanceTimersByTimeAsync(2 * SIX_HOURS_MS);

    expect(deliver).toHaveBeenCalledTimes(deliveredAtOff);
    expect(beats.filter(beat => beat.autoOff)).toHaveLength(1);
  });

  it('re-setting an active heartbeat starts a fresh six-hour window', async() => {
    // risk: repeated setup cannot extend a long-running task's intended heartbeat window.
    const { scheduler, beats } = schedulerHarness();
    scheduler.register({ threadId: 'chat-reset', channel: 'sulla-desktop', config: { intervalMinutes: 60, message: 'Check.' }, onBeat: beat => beats.push(beat) });

    await vi.advanceTimersByTimeAsync(5 * 60 * MINUTE);
    const resetAt = Date.now();
    scheduler.configure('chat-reset', { intervalMinutes: 60, message: 'Check again.' });
    expect(scheduler.status('chat-reset')?.expiresAt).toBe(resetAt + SIX_HOURS_MS);

    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(beats.filter(beat => beat.autoOff)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(5 * 60 * MINUTE - 1);
    expect(beats.filter(beat => beat.autoOff)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(Date.now()).toBe(resetAt + SIX_HOURS_MS);
    expect(scheduler.status('chat-reset')?.enabled).toBe(false);
    expect(beats.filter(beat => beat.autoOff)).toHaveLength(1);
  });

  it('cancels every timer when a delegated job task settles', async() => {
    // risk: a finished or stopped delegated task keeps waking after its work is over.
    const { scheduler, deliver } = schedulerHarness();
    scheduler.register({
      threadId: 'job-thread', channel: 'sulla-desktop', jobId: 'job-1', taskIndex: 0,
      config: { intervalMinutes: 5, message: 'Keep working.' },
    });

    scheduler.unregisterJobTask('job-1', 0);
    await vi.advanceTimersByTimeAsync(8 * 60 * MINUTE);

    expect(scheduler.has('job-thread')).toBe(false);
    expect(deliver).not.toHaveBeenCalled();
  });
});
