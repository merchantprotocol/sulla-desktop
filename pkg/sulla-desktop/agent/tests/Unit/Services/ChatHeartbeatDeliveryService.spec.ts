// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it, vi } from 'vitest';
import { ChatHeartbeatDeliveryService } from '../../../services/ChatHeartbeatDeliveryService';

describe('ChatHeartbeatDeliveryService', () => {
  it('frames a chat beat as an orchestrator message on the user_message path', async() => {
    // risk: a chat agent reads its own heartbeat as something the human typed.
    const send = vi.fn(async() => true);
    const service = new ChatHeartbeatDeliveryService({
      getJob: async() => undefined,
      wakeParkedAgent: async() => true,
      send,
      now: () => 123,
    });

    await expect(service.deliver('sulla-desktop', 'chat-thread', 'Check work.\n\n--- HEARTBEAT NOTICE ---', 10))
      .resolves.toBe(true);

    expect(send).toHaveBeenCalledWith('sulla-desktop', {
      type: 'user_message',
      data: {
        role: 'user', content: '[Message from orchestrator]\nCheck work.\n\n--- HEARTBEAT NOTICE ---', threadId: 'chat-thread',
        metadata: { source: 'agent_heartbeat', inputSource: 'system', intervalMinutes: 10 },
      },
      timestamp: 123,
    });
  });

  it('wakes a parked job without overriding the orchestrator wake source that protects a live run', async() => {
    // risk: irreversible side effect — a beat carrying its own `source` is treated by dispatchToAgent as a new
    // human turn and aborts the agent's live work. wakeParkedAgent spreads this metadata over
    // source:'orchestrator_job_message', so the beat must not carry a `source` key at all.
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
    // The raw message: wakeParkedAgent adds the '[Message from orchestrator]' framing itself.
    expect(wakeParkedAgent).toHaveBeenCalledWith('sulla-desktop', 'hidden-thread', message, 'codex-sol-worker', {
      origin: 'agent_heartbeat', inputSource: 'system', intervalMinutes: 15,
      delegatedJobId: 'job-1', delegatedTaskIndex: 0,
    });
    const metadata = wakeParkedAgent.mock.calls[0]?.[4] as Record<string, unknown>;
    expect({ source: 'orchestrator_job_message', ...metadata }.source).toBe('orchestrator_job_message');
    expect(send).not.toHaveBeenCalled();
  });

  it('queues the final auto-off beat instead of dropping it when the task is running or has open children', async() => {
    // risk: the agent is never told its heartbeat switched off, and waits on a wake that will not come.
    for (const state of [{ taskStatus: 'running', children: false }, { taskStatus: 'parked', children: true }]) {
      const wakeParkedAgent = vi.fn(async() => true);
      const queueJobMessage = vi.fn(async() => ({ id: 'queued-1' }));
      const service = new ChatHeartbeatDeliveryService({
        getJob: async() => ({
          status: 'running', parentChannel: 'sulla-desktop',
          tasks: [{ threadId: 'busy-thread', agentId: 'codex-sol-worker', status: state.taskStatus }],
        }),
        hasRunningChildren: async() => state.children,
        wakeParkedAgent, queueJobMessage, send: async() => true, now: () => 123,
      });

      await expect(service.deliver('sulla-desktop', 'busy-thread', 'final notice', 5, { jobId: 'job-1', taskIndex: 0 }, { final: true }))
        .resolves.toEqual({ delivered: true, queued: true });
      expect(queueJobMessage).toHaveBeenCalledTimes(1);
      expect(queueJobMessage).toHaveBeenCalledWith({ jobId: 'job-1', taskIndex: 0 }, 'busy-thread', 'final notice');
      expect(wakeParkedAgent).not.toHaveBeenCalled();
    }
  });

  it('wakes an idle parked task with the queued final beat so the woken turn acknowledges it exactly once', async() => {
    // risk: the final notice is delivered twice — once by the wake and again from the queue on the next turn.
    const wakeParkedAgent = vi.fn(async() => true);
    const queueJobMessage = vi.fn(async() => ({ id: 'queued-7' }));
    const service = new ChatHeartbeatDeliveryService({
      getJob: async() => ({
        status: 'parked', parentChannel: 'sulla-desktop',
        tasks: [{ threadId: 'idle-thread', agentId: 'codex-sol-worker', status: 'parked' }],
      }),
      hasRunningChildren: async() => false,
      wakeParkedAgent, queueJobMessage, send: async() => true, now: () => 123,
    });

    await expect(service.deliver('sulla-desktop', 'idle-thread', 'final notice', 5, { jobId: 'job-1', taskIndex: 0 }, { final: true }))
      .resolves.toEqual({ delivered: true });
    expect(wakeParkedAgent.mock.calls[0]?.[4]).toMatchObject({
      jobId: 'job-1', taskIndex: 0, jobMessageId: 'queued-7', jobMessageThreadId: 'idle-thread',
    });
    expect(wakeParkedAgent.mock.calls[0]?.[4]).not.toHaveProperty('source');
  });

  it('falls through to the parked-task wake when queuing a final notice throws', async() => {
    // risk: queue storage failures must not silently discard the only auto-off notice.
    const queueJobMessage = vi.fn(async() => { throw new Error('queue unavailable') });
    const wakeParkedAgent = vi.fn(async() => true);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const service = new ChatHeartbeatDeliveryService({
        getJob: async() => ({
          status: 'parked', parentChannel: 'sulla-desktop',
          tasks: [{ threadId: 'queue-fallback-thread', agentId: 'codex-sol-worker', status: 'parked' }],
        }),
        hasRunningChildren: async() => false,
        queueJobMessage, wakeParkedAgent, send: async() => true, now: () => 123,
      });

      await expect(service.deliver('sulla-desktop', 'queue-fallback-thread', 'final notice', 5,
        { jobId: 'job-fallback', taskIndex: 0 }, { final: true })).resolves.toEqual({ delivered: true });
      expect(queueJobMessage).toHaveBeenCalledTimes(1);
      expect(wakeParkedAgent).toHaveBeenCalledTimes(1);
      expect(wakeParkedAgent.mock.calls[0]?.[2]).toBe('final notice');
    } finally { warning.mockRestore() }
  });

  it('keeps the queued final beat when the wake loses a race with another turn', async() => {
    // risk: a declined wake silently discards the only notice that the heartbeat is off.
    const queueJobMessage = vi.fn(async() => ({ id: 'queued-9' }));
    const service = new ChatHeartbeatDeliveryService({
      getJob: async() => ({
        status: 'parked', parentChannel: 'sulla-desktop',
        tasks: [{ threadId: 'race-thread', agentId: 'codex-sol-worker', status: 'parked' }],
      }),
      wakeParkedAgent: async() => false, queueJobMessage, send: async() => true, now: () => 123,
    });

    await expect(service.deliver('sulla-desktop', 'race-thread', 'final notice', 5, { jobId: 'job-1', taskIndex: 0 }, { final: true }))
      .resolves.toEqual({ delivered: true, queued: true });
  });

  it('skips a heartbeat while its target task is already running without creating a user turn', async() => {
    // risk: sending user_message to a busy worker starts a disconnected turn and strands its spawn_agent waiter.
    const wakeParkedAgent = vi.fn(async() => true);
    const send = vi.fn(async() => true);
    const hasRunningChildren = vi.fn(async() => false);
    const queueJobMessage = vi.fn(async() => ({ id: 'never' }));
    const service = new ChatHeartbeatDeliveryService({
      getJob: async() => ({
        status: 'running', parentChannel: 'sulla-desktop',
        tasks: [{ threadId: 'busy-thread', agentId: 'codex-sol-worker', status: 'running' }],
      }),
      hasRunningChildren, wakeParkedAgent, queueJobMessage, send, now: () => 123,
    });

    await expect(service.deliver('sulla-desktop', 'busy-thread', 'heartbeat', 5, { jobId: 'job-1', taskIndex: 0 }))
      .resolves.toEqual({ delivered: false, skipped: true });
    expect(wakeParkedAgent).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(hasRunningChildren).not.toHaveBeenCalled();
    // A regular beat is disposable; only the final one may pile up in the job's message queue.
    expect(queueJobMessage).not.toHaveBeenCalled();
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
