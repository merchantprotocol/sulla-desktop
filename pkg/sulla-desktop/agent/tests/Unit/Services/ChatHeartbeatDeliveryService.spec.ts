// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';
import { ChatHeartbeatDeliveryService } from '../../../services/ChatHeartbeatDeliveryService';

describe('ChatHeartbeatDeliveryService', () => {
  it('sends chat heartbeat notices on the user_message path with agent_heartbeat metadata', async() => {
    // risk: chat beats bypass the same system notice/source identity used for delegated agents.
    const send = vi.fn(async() => true);
    const service = new ChatHeartbeatDeliveryService({
      getJob: async() => undefined,
      wakeParkedAgent: async() => true,
      send,
      now: () => 123,
    });

    await expect(service.deliver('sulla-desktop', 'chat-thread', 'Check work.\n\n--- HEARTBEAT NOTICE ---', 10))
      .resolves.toBe(true);

    expect(send).toHaveBeenCalledWith('sulla-desktop', expect.objectContaining({
      type: 'user_message',
      data: expect.objectContaining({
        role: 'user', content: 'Check work.\n\n--- HEARTBEAT NOTICE ---', threadId: 'chat-thread',
        metadata: expect.objectContaining({ source: 'agent_heartbeat', inputSource: 'system', intervalMinutes: 10 }),
      }),
      timestamp: 123,
    }));
  });

  it('wakes a parked job with the system heartbeat message without cancelling its agents/wait timer', async() => {
    // risk: parked hidden workers never resume for their own heartbeat, or their independent wait is lost.
    const message = 'Progress request.\n\n--- HEARTBEAT NOTICE ---\nHeartbeat notice: automatic.';
    const wakeParkedAgent = vi.fn(async() => true);
    const send = vi.fn(async() => true);
    const service = new ChatHeartbeatDeliveryService({
      getJob: async() => ({
        status: 'parked', parentChannel: 'sulla-desktop',
        tasks: [{ threadId: 'hidden-thread', agentId: 'codex-sol-worker', status: 'parked' }],
      }),
      wakeParkedAgent, send, now: () => 123,
    });

    const result = await service.deliver('other-channel', 'hidden-thread', message, 15, { jobId: 'job-1', taskIndex: 0 });

    expect(result).toEqual({ delivered: true });
    expect(wakeParkedAgent).toHaveBeenCalledWith('sulla-desktop', 'hidden-thread', message, 'codex-sol-worker', {
      source: 'agent_heartbeat', inputSource: 'system', intervalMinutes: 15,
      delegatedJobId: 'job-1', delegatedTaskIndex: 0,
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('skips a heartbeat while its target task is already running without creating a user turn', async() => {
    // risk: sending user_message to a busy worker starts a disconnected turn and strands its spawn_agent waiter.
    const wakeParkedAgent = vi.fn(async() => true);
    const send = vi.fn(async() => true);
    const hasRunningChildren = vi.fn(async() => false);
    const service = new ChatHeartbeatDeliveryService({
      getJob: async() => ({
        status: 'running', parentChannel: 'sulla-desktop',
        tasks: [{ threadId: 'busy-thread', agentId: 'codex-sol-worker', status: 'running' }],
      }),
      hasRunningChildren, wakeParkedAgent, send, now: () => 123,
    });

    await expect(service.deliver('sulla-desktop', 'busy-thread', 'heartbeat', 5, { jobId: 'job-1', taskIndex: 0 }))
      .resolves.toEqual({ delivered: false, skipped: true });
    expect(wakeParkedAgent).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(hasRunningChildren).not.toHaveBeenCalled();
  });

  it('skips a parked task while it has active child jobs because child results will wake it', async() => {
    // risk: a parent is needlessly reawakened while its own child work is still delivering results.
    const wakeParkedAgent = vi.fn(async() => true);
    const send = vi.fn(async() => true);
    const service = new ChatHeartbeatDeliveryService({
      getJob: async() => ({
        status: 'parked', parentChannel: 'sulla-desktop',
        tasks: [{ threadId: 'parent-thread', agentId: 'coding-manager', status: 'parked' }],
      }),
      hasRunningChildren: async() => true,
      wakeParkedAgent, send, now: () => 123,
    });

    await expect(service.deliver('sulla-desktop', 'parent-thread', 'heartbeat', 5, { jobId: 'parent-job', taskIndex: 0 }))
      .resolves.toEqual({ delivered: false, skipped: true });
    expect(wakeParkedAgent).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('drops a parked wake that races with another wake or a non-parked state', async() => {
    // risk: a stale heartbeat throws on a race or falsely claims delivery after the wake was declined.
    for (const wakeResult of [false, new Error('not a parked agent job')]) {
      const wakeParkedAgent = vi.fn(async() => {
        if (wakeResult instanceof Error) throw wakeResult;
        return wakeResult;
      });
      const send = vi.fn(async() => true);
      const service = new ChatHeartbeatDeliveryService({
        getJob: async() => ({
          status: 'parked', parentChannel: 'sulla-desktop',
          tasks: [{ threadId: 'racing-thread', agentId: 'codex-sol-worker', status: 'parked' }],
        }),
        wakeParkedAgent, send, now: () => 123,
      });

      await expect(service.deliver('sulla-desktop', 'racing-thread', 'heartbeat', 5, { jobId: 'job-1', taskIndex: 0 }))
        .resolves.toEqual({ delivered: false, skipped: true });
      expect(send).not.toHaveBeenCalled();
    }
  });

  it('stops delivery when its job task has already settled', async() => {
    // risk: a terminal job can be rehydrated by a timer that outlived its owner.
    const wakeParkedAgent = vi.fn(async() => true);
    const service = new ChatHeartbeatDeliveryService({
      getJob: async() => ({
        status: 'completed',
        tasks: [{ threadId: 'hidden-thread', agentId: 'codex-sol-worker', status: 'completed' }],
      }),
      wakeParkedAgent, send: async() => true, now: () => 123,
    });

    await expect(service.deliver('sulla-desktop', 'hidden-thread', 'heartbeat', 15, { jobId: 'job-1', taskIndex: 0 }))
      .resolves.toEqual({ delivered: false, terminal: true });
    expect(wakeParkedAgent).not.toHaveBeenCalled();
  });
});
