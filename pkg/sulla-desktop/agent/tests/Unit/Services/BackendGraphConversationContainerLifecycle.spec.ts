// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';
import { BackendGraphWebSocketService, type ConversationIdleTimer } from '@pkg/agent/services/BackendGraphWebSocketService';

class FakeIdleTimer implements ConversationIdleTimer {
  readonly callbacks: Array<() => void> = [];
  readonly cleared: unknown[] = [];
  set(callback: () => void): ReturnType<typeof setTimeout> {
    this.callbacks.push(callback);
    return this.callbacks.length as unknown as ReturnType<typeof setTimeout>;
  }
  clear(timer: ReturnType<typeof setTimeout>): void { this.cleared.push(timer); }
}

describe('BackendGraphWebSocketService conversation container lifecycle', () => {
  it('re-arms the idle close after a finished manager turn', async() => {
    // risk: reusing a conversation clears its only timer and leaks the container forever
    const timers = new FakeIdleTimer();
    const service = new BackendGraphWebSocketService({ isTerminalDelegatedThread: async() => false }, timers) as any;
    const lifecycle = { close: vi.fn().mockResolvedValue(undefined) };
    service.conversationContainers.set('sulla-desktop|thread-a', { provider: 'openai', agentId: 'manager', lifecycle, idleTimer: 7 });
    await service.settleConversationContainer('sulla-desktop', 'thread-a');
    expect(timers.cleared).toEqual([7]);
    expect(timers.callbacks).toHaveLength(1);
    expect(lifecycle.close).not.toHaveBeenCalled();
  });

  it('closes and forgets a manager container as soon as its job is terminal', async() => {
    // risk: completed manager session containers remain up beyond their job end
    const timers = new FakeIdleTimer();
    const service = new BackendGraphWebSocketService({ isTerminalDelegatedThread: async() => true }, timers) as any;
    const lifecycle = { close: vi.fn().mockResolvedValue(undefined) };
    service.conversationContainers.set('sulla-desktop|thread-done', { provider: 'openai', agentId: 'manager', lifecycle, idleTimer: 8 });
    await service.settleConversationContainer('sulla-desktop', 'thread-done');
    expect(lifecycle.close).toHaveBeenCalledWith('agent-job-terminal', 'BackendGraphWebSocketService.settleConversationContainer');
    expect(service.conversationContainers.has('sulla-desktop|thread-done')).toBe(false);
    expect(timers.callbacks).toHaveLength(0);
  });
});
