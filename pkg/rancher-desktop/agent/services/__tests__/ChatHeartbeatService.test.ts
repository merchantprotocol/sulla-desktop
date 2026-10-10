/**
 * @jest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { ChatHeartbeatScheduler } from '../ChatHeartbeatScheduler';

import { DEFAULT_CHAT_HEARTBEAT_MESSAGE } from '@pkg/shared/chatHeartbeat';

describe('ChatHeartbeatScheduler', () => {
  beforeEach(() => { jest.useFakeTimers() });
  afterEach(() => { jest.useRealTimers() });

  it('never pings a running graph and restarts the full countdown once it stops', async() => {
    const busy = new Map([['thread-a', true]]);
    const deliver = jest.fn<(channel: string, threadId: string, message: string, intervalMinutes: number) => Promise<boolean>>(() => Promise.resolve(true));
    const scheduler = new ChatHeartbeatScheduler({
      isGraphBusy: threadId => busy.get(threadId) ?? false,
      deliver,
    });

    scheduler.register({
      threadId: 'thread-a',
      channel:  'sulla-desktop',
      config:   { intervalMinutes: 1, message: DEFAULT_CHAT_HEARTBEAT_MESSAGE },
    });
    await jest.advanceTimersByTimeAsync(60_000);

    expect(deliver).not.toHaveBeenCalled();
    expect(scheduler.status('thread-a')?.paused).toBe(true);
    expect(scheduler.status('thread-a')?.nextAt).toBeNull();

    busy.set('thread-a', false);
    scheduler.updateBusy('thread-a', false);
    await Promise.resolve();

    // Stopping does not fire a queued beat — the idle countdown starts over.
    expect(deliver).not.toHaveBeenCalled();
    expect(scheduler.status('thread-a')?.paused).toBe(false);
    expect(scheduler.status('thread-a')?.nextAt).not.toBeNull();

    await jest.advanceTimersByTimeAsync(60_000);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith('sulla-desktop', 'thread-a', DEFAULT_CHAT_HEARTBEAT_MESSAGE, 1);
  });

  it('pauses the countdown as soon as the renderer reports the graph running', async() => {
    const deliver = jest.fn<(channel: string, threadId: string, message: string, intervalMinutes: number) => Promise<boolean>>(() => Promise.resolve(true));
    const scheduler = new ChatHeartbeatScheduler({ isGraphBusy: () => false, deliver });

    scheduler.register({
      threadId: 'thread-a',
      channel:  'sulla-desktop',
      config:   { intervalMinutes: 1, message: 'tick' },
    });
    await jest.advanceTimersByTimeAsync(45_000);
    scheduler.updateBusy('thread-a', true);
    await jest.advanceTimersByTimeAsync(5 * 60_000);
    expect(deliver).not.toHaveBeenCalled();

    scheduler.updateBusy('thread-a', false);
    await jest.advanceTimersByTimeAsync(59_000);
    expect(deliver).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1_000);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('resumes on its own when the graph stops without a renderer signal', async() => {
    let busy = true;
    const deliver = jest.fn<(channel: string, threadId: string, message: string, intervalMinutes: number) => Promise<boolean>>(() => Promise.resolve(true));
    const scheduler = new ChatHeartbeatScheduler({ isGraphBusy: () => busy, deliver });

    scheduler.register({
      threadId: 'thread-a',
      channel:  'sulla-desktop',
      config:   { intervalMinutes: 1, message: 'tick' },
    });
    await jest.advanceTimersByTimeAsync(5 * 60_000);
    expect(scheduler.status('thread-a')?.paused).toBe(true);

    busy = false;
    await jest.advanceTimersByTimeAsync(1_000);
    expect(scheduler.status('thread-a')?.paused).toBe(false);
    expect(deliver).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('isolates schedules and busy state per thread', async() => {
    const busy = new Map([['thread-a', true], ['thread-b', false]]);
    const deliver = jest.fn<(channel: string, threadId: string, message: string, intervalMinutes: number) => Promise<boolean>>(() => Promise.resolve(true));
    const scheduler = new ChatHeartbeatScheduler({
      isGraphBusy: threadId => busy.get(threadId) ?? false,
      deliver,
    });

    scheduler.register({ threadId: 'thread-a', channel: 'a', config: { intervalMinutes: 1, message: 'A' } });
    scheduler.register({ threadId: 'thread-b', channel: 'b', config: { intervalMinutes: 2, message: 'B' } });

    await jest.advanceTimersByTimeAsync(60_000);
    expect(deliver).not.toHaveBeenCalled();
    expect(scheduler.status('thread-a')?.paused).toBe(true);
    expect(scheduler.status('thread-b')?.paused).toBe(false);

    await jest.advanceTimersByTimeAsync(60_000);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith('b', 'thread-b', 'B', 2);
  });
});
