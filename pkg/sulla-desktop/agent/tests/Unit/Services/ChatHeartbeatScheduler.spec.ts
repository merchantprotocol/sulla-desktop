// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatHeartbeatScheduler } from '../../../services/ChatHeartbeatScheduler';
import { HeartbeatNoticeBuilder } from '../../../services/HeartbeatNoticeBuilder';

const MINUTE = 60_000;
const SIX_HOURS_MS = 6 * 60 * 60_000;
const START = Date.UTC(2026, 10, 24, 20, 0, 0);

function schedulerHarness(
  hasPendingWait?: (target: { jobId: string; taskIndex: number }) => Promise<boolean>,
  deliver: any = vi.fn(async() => true),
) {
  const beats: any[] = [];
  const configs: any[] = [];
  const statuses: any[] = [];
  const jobHeartbeatChanged = vi.fn();
  const scheduler = new ChatHeartbeatScheduler({
    now:         () => Date.now(), // Injected clock; Vitest advances it with the timers.
    isGraphBusy: () => false,
    deliver,
    noticeBuilder: new HeartbeatNoticeBuilder('America/Los_Angeles'),
    hasPendingWait,
    jobHeartbeatChanged,
  });
  return { scheduler, deliver, beats, configs, statuses, jobHeartbeatChanged };
}

/** A delivery that stays in flight until released, like a job beat awaiting the whole woken turn. */
function heldDelivery() {
  const releases: Array<(result: any) => void> = [];
  const deliver = vi.fn(() => new Promise<any>((resolve) => { releases.push(resolve) }));
  return { deliver, release: (result: any = { delivered: true }) => releases.shift()?.(result) };
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

  it('tells a woken job that its own agents/wait timer is still pending', async() => {
    // risk: an agent woken by a beat believes its wait was consumed and schedules a duplicate.
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

  it('only mentions agents/wait when the durable wait lookup says one is pending', async() => {
    // risk: a heartbeat can claim a wait exists after it was cancelled or consumed.
    const { scheduler, deliver } = schedulerHarness(async() => false);
    scheduler.register({
      threadId: 'job-no-wait-thread', channel: 'sulla-desktop', jobId: 'job-no-wait', taskIndex: 0,
      config: { intervalMinutes: 5, message: 'Check.' },
    });

    await vi.advanceTimersByTimeAsync(5 * MINUTE);

    expect(String(deliver.mock.calls[0]?.[2])).not.toContain('Your agents/wait timer is still pending');
  });

  it('preserves a restored deadline and starts off without a beat when it has passed', async() => {
    // risk: renderer or process restarts silently restart the six-hour expiration window.
    const { scheduler, deliver } = schedulerHarness();
    scheduler.register({
      threadId: 'expired-restore', channel: 'sulla-desktop',
      config: {
        intervalMinutes: 5, message: 'Resume.', setBy: 'agent',
        startedAt: START - SIX_HOURS_MS, expiresAt: START - 1,
      },
    });

    expect(scheduler.status('expired-restore')).toMatchObject({
      enabled: false, intervalMinutes: null, startedAt: null, expiresAt: null, setBy: 'agent',
    });
    await vi.advanceTimersByTimeAsync(2 * SIX_HOURS_MS);
    expect(deliver).not.toHaveBeenCalled();
  });

  it('restarts the full interval after a skipped delegated beat instead of sending a retry turn', async() => {
    // risk: busy or child-owned work causes repeated one-second wake attempts instead of a clean next interval.
    const deliver = vi.fn(async() => ({ delivered: false, skipped: true }));
    const { scheduler } = schedulerHarness(undefined, deliver);
    scheduler.register({
      threadId: 'skip-job-thread', channel: 'sulla-desktop', jobId: 'skip-job', taskIndex: 0,
      config: { intervalMinutes: 5, message: 'Check children.' },
    });

    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(scheduler.status('skip-job-thread')).toMatchObject({ pending: false, nextAt: Date.now() + 5 * MINUTE });
    await vi.advanceTimersByTimeAsync(5 * MINUTE - 1);
    expect(deliver).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(deliver).toHaveBeenCalledTimes(2);
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
    expect(finalBeats[0].message).toContain('System: your heartbeat was switched off automatically after 6 hours.');
    // Registered from the composer (no setBy), so the human owns the decision to restart it.
    expect(finalBeats[0].message).toContain('The human set this heartbeat. Leave it off unless they ask you to turn it back on.');
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

  it('stops for good when switched off while a beat is still being delivered', async() => {
    // risk: irreversible side effect — a heartbeat that ignores "off" keeps waking the agent and burning tokens forever.
    // A job beat's delivery awaits the whole woken turn, and that turn is where the agent turns the heartbeat off.
    const held = heldDelivery();
    const { scheduler } = schedulerHarness(undefined, held.deliver);
    const registration = {
      threadId: 'off-mid-beat', channel: 'sulla-desktop', jobId: 'off-job', taskIndex: 0,
      config: { intervalMinutes: 5, message: 'Keep working.' },
    };
    scheduler.register(registration);
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(held.deliver).toHaveBeenCalledTimes(1);

    // Mid-delivery: the thread is registered again (a tab re-attaching, or the tool binding its job) and switched off.
    scheduler.register({ ...registration, config: scheduler.status('off-mid-beat')! });
    scheduler.configure('off-mid-beat', { intervalMinutes: null, message: 'Keep working.' });
    held.release();
    await vi.advanceTimersByTimeAsync(SIX_HOURS_MS);

    expect(held.deliver).toHaveBeenCalledTimes(1);
    expect(scheduler.status('off-mid-beat')).toMatchObject({ enabled: false, nextAt: null, pending: false });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never revives a heartbeat that was unregistered and registered again during a delivery', async() => {
    // risk: an orphaned runtime keeps its own timer that no unregister, configure or auto-off can reach.
    const held = heldDelivery();
    const { scheduler } = schedulerHarness(undefined, held.deliver);
    scheduler.register({ threadId: 'replaced', channel: 'sulla-desktop', config: { intervalMinutes: 5, message: 'Check.' } });
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(held.deliver).toHaveBeenCalledTimes(1);

    scheduler.unregister('replaced');
    scheduler.register({ threadId: 'replaced', channel: 'sulla-desktop', config: { intervalMinutes: null, message: 'Check.' } });
    held.release(true);
    await vi.advanceTimersByTimeAsync(SIX_HOURS_MS);

    expect(held.deliver).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps a delegated job heartbeat when its tab closes, and drops a plain chat heartbeat', async() => {
    // risk: closing a tab silently cancels the heartbeat a hidden job is relying on to be woken.
    const { scheduler, deliver, statuses } = schedulerHarness();
    scheduler.register({
      threadId: 'tabbed-job', channel: 'sulla-desktop', jobId: 'tab-job', taskIndex: 1,
      config: { intervalMinutes: 5, message: 'Keep working.' }, onStatus: status => statuses.push(status),
    });
    scheduler.register({ threadId: 'plain-chat', channel: 'sulla-desktop', config: { intervalMinutes: 5, message: 'Check.' } });

    scheduler.unregisterFromUi('tabbed-job');
    scheduler.unregisterFromUi('plain-chat');
    const seenByClosedTab = statuses.length;
    await vi.advanceTimersByTimeAsync(5 * MINUTE);

    expect(scheduler.has('plain-chat')).toBe(false);
    expect(scheduler.status('tabbed-job')).toMatchObject({ enabled: true, intervalMinutes: 5 });
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0]?.[1]).toBe('tabbed-job');
    expect(deliver.mock.calls[0]?.[4]).toEqual({ jobId: 'tab-job', taskIndex: 1 });
    // The closed tab's listeners are gone; nothing is sent to a destroyed renderer.
    expect(statuses).toHaveLength(seenByClosedTab);
  });

  it('keeps the job binding and the original deadline when a tab registers the thread again', async() => {
    // risk: a tab re-attach turns a job heartbeat into a chat heartbeat, or grants it a fresh six hours.
    const { scheduler, deliver } = schedulerHarness();
    scheduler.register({
      threadId: 'reattach', channel: 'sulla-desktop', jobId: 'reattach-job', taskIndex: 2,
      config: { intervalMinutes: 10, message: 'Keep working.', setBy: 'agent' },
    });
    const original = scheduler.status('reattach')!;

    await vi.advanceTimersByTimeAsync(3 * 60 * MINUTE);
    const beatsBefore = deliver.mock.calls.length;
    // The renderer knows no jobId and offers its own saved config with a later window.
    scheduler.register({
      threadId: 'reattach', channel: 'sulla-desktop',
      config: { intervalMinutes: 1, message: 'Tab copy.', startedAt: Date.now(), expiresAt: Date.now() + SIX_HOURS_MS },
    });

    expect(scheduler.jobTarget('reattach')).toEqual({ jobId: 'reattach-job', taskIndex: 2 });
    expect(scheduler.status('reattach')).toMatchObject({
      intervalMinutes: 10, message: 'Keep working.', setBy: 'agent',
      startedAt: original.startedAt, expiresAt: original.expiresAt,
    });
    await vi.advanceTimersByTimeAsync(3 * 60 * MINUTE);
    expect(scheduler.status('reattach')?.enabled).toBe(false);
    expect(deliver.mock.calls.length).toBeGreaterThan(beatsBefore);
    expect(deliver.mock.calls.at(-1)?.[5]).toEqual({ final: true });
  });

  it('enforces the five-minute minimum on any job-bound heartbeat, however it was set', async() => {
    // risk: a composer-set one-minute heartbeat on a delegated job wakes a whole agent turn every minute.
    const { scheduler } = schedulerHarness();
    scheduler.register({
      threadId: 'min-job', channel: 'sulla-desktop', jobId: 'min-job-id', taskIndex: 0,
      config: { intervalMinutes: 1, message: 'Check.' },
    });
    expect(scheduler.status('min-job')?.intervalMinutes).toBe(5);
    expect(scheduler.configure('min-job', { intervalMinutes: 2, message: 'Check.' })?.intervalMinutes).toBe(5);
    expect(scheduler.configure('min-job', { intervalMinutes: 30, message: 'Check.' })?.intervalMinutes).toBe(30);

    scheduler.register({ threadId: 'min-chat', channel: 'sulla-desktop', config: { intervalMinutes: 1, message: 'Check.' } });
    expect(scheduler.status('min-chat')?.intervalMinutes).toBe(1);
    scheduler.bindJob('min-chat', { jobId: 'late-bound', taskIndex: 0 });
    expect(scheduler.configure('min-chat', { intervalMinutes: 1, message: 'Check.' })?.intervalMinutes).toBe(5);
  });

  it('reports a job heartbeat change when it is set and again the moment it auto-expires', async() => {
    // risk: an expired heartbeat's durable record survives and is restored by the next restart.
    const { scheduler, deliver, jobHeartbeatChanged } = schedulerHarness();
    scheduler.register({
      threadId: 'durable-job', channel: 'sulla-desktop', jobId: 'durable', taskIndex: 0,
      config: { intervalMinutes: null, message: 'Check.' },
    });
    scheduler.configure('durable-job', { intervalMinutes: 60, message: 'Check.' });
    expect(jobHeartbeatChanged).toHaveBeenCalledTimes(1);

    let recordAtExpiryCall: unknown = 'not-called';
    jobHeartbeatChanged.mockImplementation(() => { recordAtExpiryCall = scheduler.jobHeartbeatRecord('durable-job') });
    await vi.advanceTimersByTimeAsync(SIX_HOURS_MS);

    expect(jobHeartbeatChanged).toHaveBeenCalledTimes(2);
    expect(jobHeartbeatChanged).toHaveBeenLastCalledWith('durable-job');
    // Already off when reported, so the provider deletes the row rather than re-saving it.
    expect(recordAtExpiryCall).toBeNull();
    expect(deliver.mock.calls.at(-1)?.[5]).toEqual({ final: true });

    // A chat heartbeat has no durable record to keep in step.
    scheduler.register({ threadId: 'plain', channel: 'sulla-desktop', config: { intervalMinutes: null, message: 'Check.' } });
    scheduler.configure('plain', { intervalMinutes: 60, message: 'Check.' });
    expect(jobHeartbeatChanged).toHaveBeenCalledTimes(2);
  });
});
