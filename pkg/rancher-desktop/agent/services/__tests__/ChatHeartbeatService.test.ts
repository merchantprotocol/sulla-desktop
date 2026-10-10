/**
 * @jest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { ChatHeartbeatScheduler } from '../ChatHeartbeatScheduler';

import { DEFAULT_CHAT_HEARTBEAT_MESSAGE } from '@pkg/shared/chatHeartbeat';

describe('ChatHeartbeatScheduler', () => {
  beforeEach(() => { jest.useFakeTimers() });
  afterEach(() => { jest.useRealTimers() });

  it('never injects while the target thread is running and delivers its held beat on idle', async() => {
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
    expect(scheduler.status('thread-a')?.pending).toBe(true);

    busy.set('thread-a', false);
    scheduler.updateBusy('thread-a', false);
    await Promise.resolve();

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith('sulla-desktop', 'thread-a', DEFAULT_CHAT_HEARTBEAT_MESSAGE, 1);
    expect(scheduler.status('thread-a')?.pending).toBe(false);
  });

  it('keeps at most one pending beat while a thread stays busy', async() => {
    let busy = true;
    const deliver = jest.fn<(channel: string, threadId: string, message: string, intervalMinutes: number) => Promise<boolean>>(() => Promise.resolve(true));
    const scheduler = new ChatHeartbeatScheduler({ isGraphBusy: () => busy, deliver });

    scheduler.register({
      threadId: 'thread-a',
      channel:  'sulla-desktop',
      config:   { intervalMinutes: 1, message: 'tick' },
    });
    await jest.advanceTimersByTimeAsync(5 * 60_000);
    expect(scheduler.status('thread-a')?.pending).toBe(true);
    expect(deliver).not.toHaveBeenCalled();

    busy = false;
    scheduler.updateBusy('thread-a', false);
    await Promise.resolve();
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
    expect(scheduler.status('thread-a')?.pending).toBe(true);
    expect(scheduler.status('thread-b')?.pending).toBe(false);

    await jest.advanceTimersByTimeAsync(60_000);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith('b', 'thread-b', 'B', 2);
  });
});
