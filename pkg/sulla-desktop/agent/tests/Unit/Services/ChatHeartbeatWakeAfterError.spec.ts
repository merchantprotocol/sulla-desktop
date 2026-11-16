// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// A turn that dies on an error must not leave its chat heartbeat paused for
// good: the heartbeat is what wakes the chat back up after the failure.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isTerminalRunError } from '@pkg/agent/workflow/agentNodeError';
import { ChatHeartbeatScheduler, STALE_BUSY_LIMIT_MS } from '@pkg/agent/services/ChatHeartbeatScheduler';

const MINUTE = 60_000;

function setup(graphBusy: { value: boolean }) {
  const deliver = vi.fn(async() => true);
  const scheduler = new ChatHeartbeatScheduler({
    now:         () => Date.now(),
    isGraphBusy: () => graphBusy.value,
    deliver,
  });
  return { scheduler, deliver };
}

describe('chat heartbeat after a failed turn', () => {
  beforeEach(() => { vi.useFakeTimers() });
  afterEach(() => { vi.useRealTimers() });

  it('drops a stale renderer busy claim once the graph is idle, then fires on the interval', async() => {
    const graphBusy = { value: true };
    const { scheduler, deliver } = setup(graphBusy);
    scheduler.register({ threadId: 't1', channel: 'sulla-desktop', config: { intervalMinutes: 5, message: 'beat' }, busy: true });

    // The turn errors: the backend graph ends but the renderer never says busy=false.
    graphBusy.value = false;
    await vi.advanceTimersByTimeAsync(STALE_BUSY_LIMIT_MS + 30_000);
    expect(scheduler.status('t1')?.paused).toBe(false);
    expect(deliver).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('stays paused while the graph is genuinely running', async() => {
    const graphBusy = { value: true };
    const { scheduler, deliver } = setup(graphBusy);
    scheduler.register({ threadId: 't1', channel: 'sulla-desktop', config: { intervalMinutes: 5, message: 'beat' }, busy: true });

    await vi.advanceTimersByTimeAsync(30 * MINUTE);
    expect(scheduler.status('t1')?.paused).toBe(true);
    expect(deliver).not.toHaveBeenCalled();
  });

  it('an intentional stop gets the normal interval, not an extra early retry', async() => {
    const graphBusy = { value: true };
    const { scheduler, deliver } = setup(graphBusy);
    scheduler.register({ threadId: 't1', channel: 'sulla-desktop', config: { intervalMinutes: 5, message: 'beat' }, busy: true });

    graphBusy.value = false;
    scheduler.updateBusy('t1', false);
    await vi.advanceTimersByTimeAsync(5 * MINUTE - 1_000);
    expect(deliver).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(deliver).toHaveBeenCalledTimes(1);
  });
});

describe('isTerminalRunError', () => {
  it('treats the post-failure agent error bubble as the end of the run', () => {
    expect(isTerminalRunError({ type: 'assistant_message', data: { content: 'Agent error: timeout exceeded when trying to connect', runEnded: true } } as any)).toBe(true);
    expect(isTerminalRunError({ type: 'assistant_message', data: { content: 'Agent error: boom' } } as any)).toBe(true);
  });

  it('keeps ordinary assistant output counting as activity', () => {
    expect(isTerminalRunError({ type: 'assistant_message', data: { content: 'Working on it' } } as any)).toBe(false);
    expect(isTerminalRunError({ type: 'progress', data: { content: 'Agent error: x', runEnded: true } } as any)).toBe(false);
  });
});
