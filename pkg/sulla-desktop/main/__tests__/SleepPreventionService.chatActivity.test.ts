// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { afterEach, describe, expect, it, jest } from '@jest/globals';

const start = jest.fn(() => 41);
const stop = jest.fn();
const isStarted = jest.fn(() => true);

const service = await import('../SleepPreventionService');

service.setPowerSaveBlockerForTests({ start, stop, isStarted } as any);

describe('SleepPreventionService chat activity', () => {
  afterEach(() => {
    service.releaseAllChatActivity();
    start.mockClear();
    stop.mockClear();
  });

  it('reference-counts stable activity keys and stops only after the last release', () => {
    service.acquireChatActivity('graph:a');
    service.acquireChatActivity('graph:a');
    service.acquireChatActivity('graph:b');
    expect(start).toHaveBeenCalledTimes(1);
    expect(service.getChatActivityHolders()).toEqual(new Set(['graph:a', 'graph:b']));

    service.releaseChatActivity('graph:a');
    expect(stop).not.toHaveBeenCalled();
    service.releaseChatActivity('graph:b');
    expect(stop).toHaveBeenCalledWith(41);
  });

  it('releases every holder during teardown without leaking the blocker', () => {
    service.acquireChatActivity('graph:a');
    service.acquireChatActivity('chat-heartbeat:b');
    service.releaseAllChatActivity();
    expect(service.getChatActivityHolders().size).toBe(0);
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
