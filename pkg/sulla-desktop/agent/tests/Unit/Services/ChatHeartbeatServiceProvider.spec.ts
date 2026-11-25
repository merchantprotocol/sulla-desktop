// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it, vi } from 'vitest';

vi.mock('@pkg/main/SleepPreventionService', () => ({ acquireChatActivity: vi.fn(), releaseChatActivity: vi.fn() }));
vi.mock('@pkg/agent/services/GraphRegistry', () => ({ GraphRegistry: { get: vi.fn() } }));
vi.mock('@pkg/agent/services/WebSocketClientService', () => ({ getWebSocketClientService: vi.fn() }));
const waits = vi.hoisted(() => ({ pending: vi.fn(async() => ({ id: 'wait-1' })), wake: vi.fn(async() => true) }));
vi.mock('@pkg/agent/services/AgentWaitServices', () => ({
  agentWaitProvider: { repository: { pending: waits.pending } },
}));
vi.mock('@pkg/agent/services/BackendGraphWebSocketService', () => ({
  getBackendGraphWebSocketService: () => ({ wakeParkedAgent: waits.wake }),
}));

import { ChatHeartbeatServiceProvider, chatHeartbeatProvider } from '@pkg/agent/app/Providers/ChatHeartbeatServiceProvider';
import type { ChatHeartbeatJobRecord } from '@pkg/agent/app/Repositories/ChatHeartbeatJobRepository';
import { HeartbeatNoticeBuilder } from '@pkg/agent/services/HeartbeatNoticeBuilder';
import { MemoryHeartbeatStore } from '../../Support/MemoryHeartbeatStore';
import { getChatHeartbeatService } from '@pkg/agent/services/ChatHeartbeatService';

describe('ChatHeartbeatServiceProvider', () => {
  // risk: duplicate side effects — two schedulers would each fire heartbeat messages and split thread registrations.
  it('hands every caller, including the deprecated getter, the same scheduler', () => {
    const scheduler = chatHeartbeatProvider.scheduler();
    expect(chatHeartbeatProvider.scheduler()).toBe(scheduler);
    expect(getChatHeartbeatService()).toBe(scheduler);
  });

  it('keeps registrations visible through the deprecated getter', () => {
    const provider = new ChatHeartbeatServiceProvider();
    expect(provider.scheduler()).not.toBe(chatHeartbeatProvider.scheduler());
    expect(getChatHeartbeatService().has('thread-not-registered')).toBe(false);
  });

  it('clears a delegated task heartbeat when its job task settles', () => {
    // risk: a completed/stopped hidden task remains timer-owned after the job lifecycle has ended.
    let onJobChange: ((previous: any, next: any) => void | Promise<void>) | undefined;
    const heartbeats = new MemoryHeartbeatStore();
    const provider = new ChatHeartbeatServiceProvider({
      jobChanges: { onJobChange: listener => { onJobChange = listener; return () => undefined } },
      jobHeartbeats: heartbeats,
    });
    const scheduler = provider.scheduler();
    scheduler.register({
      threadId: 'terminal-thread', channel: 'sulla-desktop', jobId: 'terminal-job', taskIndex: 0,
      config: { intervalMinutes: 10, message: 'Keep checking.' },
    });
    expect(scheduler.has('terminal-thread')).toBe(true);

    const cleanup = onJobChange?.({
      jobId: 'terminal-job', status: 'running', tasks: [{ status: 'running' }],
    }, {
      jobId: 'terminal-job', status: 'completed', tasks: [{ status: 'completed', finishedAt: Date.now() }],
    });

    expect(cleanup).toBeInstanceOf(Promise);
    return Promise.resolve(cleanup).then(() => {
      expect(scheduler.has('terminal-thread')).toBe(false);
      expect(heartbeats.deleted).toContainEqual({ jobId: 'terminal-job', taskIndex: 0 });
    });
  });

  it('includes the wait repository state in a parked-job heartbeat notice', async() => {
    // risk: a heartbeat tells a worker that an agents/wait timer is pending after it was consumed or cancelled.
    vi.useFakeTimers();
    try {
      const provider = new ChatHeartbeatServiceProvider({
        jobChanges: { onJobChange: () => () => undefined },
        jobHeartbeats: new MemoryHeartbeatStore(),
        getJob: async() => ({
          jobId: 'wait-job', status: 'parked', parentChannel: 'sulla-desktop',
          tasks: [{ threadId: 'wait-thread', agentId: 'codex-sol-worker', status: 'parked' }],
        }) as any,
        hasRunningChildren: async() => false,
        now: () => Date.now(),
      });
      provider.scheduler().register({
        threadId: 'wait-thread', channel: 'sulla-desktop', jobId: 'wait-job', taskIndex: 0,
        config: { intervalMinutes: 5, message: 'Check the work.', setBy: 'agent' },
      });

      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(waits.wake).toHaveBeenCalledTimes(1);
      expect(waits.pending).toHaveBeenCalledWith('wait-job', 0);
      expect(String(waits.wake.mock.calls[0]?.[2])).toContain('Your agents/wait timer is still pending and will still wake you.');
      waits.pending.mockResolvedValueOnce(null as any);
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(waits.wake).toHaveBeenCalledTimes(2);
      expect(String(waits.wake.mock.calls[1]?.[2])).not.toContain('agents/wait timer is still pending');
      provider.scheduler().unregister('wait-thread');
    } finally { vi.useRealTimers() }
  });

  it('rehydrates a job heartbeat without extending its deadline and removes expired or finished records', async() => {
    // risk: app restarts must not reset a job heartbeat's original six-hour safety bound.
    const now = 10_000;
    const activeRecord: ChatHeartbeatJobRecord = {
      jobId: 'active-job', taskIndex: 0, threadId: 'active-thread', channel: 'sulla-desktop',
      config: { intervalMinutes: 5, message: 'Resume work.', startedAt: 1_000, expiresAt: 21_600_001, setBy: 'agent' },
      startedAt: 1_000, expiresAt: 21_600_001, setBy: 'agent',
    };
    const expiredRecord: ChatHeartbeatJobRecord = {
      ...activeRecord, jobId: 'expired-job', threadId: 'expired-thread',
      config: { ...activeRecord.config, setBy: 'human', startedAt: 2_000, expiresAt: now }, startedAt: 2_000, expiresAt: now,
    };
    const finishedRecord: ChatHeartbeatJobRecord = { ...activeRecord, jobId: 'finished-job', threadId: 'finished-thread' };
    const heartbeats = new MemoryHeartbeatStore([activeRecord, expiredRecord, finishedRecord]);
    const events: string[] = [];
    const queued: Array<{ target: unknown; threadId: string; message: string }> = [];
    const originalDelete = heartbeats.delete.bind(heartbeats);
    vi.spyOn(heartbeats, 'delete').mockImplementation(async(jobId, taskIndex) => {
      events.push(`delete:${ jobId }`);
      await originalDelete(jobId, taskIndex);
    });
    const jobs: Record<string, any> = {
      'active-job': { jobId: 'active-job', status: 'parked', parentChannel: 'sulla-desktop', tasks: [{ threadId: 'active-thread', status: 'parked' }] },
      'expired-job': { jobId: 'expired-job', status: 'running', tasks: [{ threadId: 'expired-thread', status: 'running' }] },
      'finished-job': { jobId: 'finished-job', status: 'completed', tasks: [{ threadId: 'finished-thread', status: 'completed' }] },
    };
    const provider = new ChatHeartbeatServiceProvider({
      jobChanges: { onJobChange: () => () => undefined },
      jobHeartbeats: heartbeats,
      getJob: async jobId => jobs[jobId],
      hasRunningChildren: async() => false,
      queueJobMessage: async(target, threadId, message) => {
        events.push(`queue:${ target.jobId }`);
        queued.push({ target, threadId, message });
        return { id: 'queued-expired-final' };
      },
      noticeBuilder: new HeartbeatNoticeBuilder('UTC'),
      now: () => now,
    });

    await provider.rehydrateJobHeartbeats();

    expect(provider.scheduler().status('active-thread')).toMatchObject({
      enabled: true, startedAt: activeRecord.startedAt, expiresAt: activeRecord.expiresAt, setBy: 'agent',
    });
    expect(provider.scheduler().status('expired-thread')).toMatchObject({ enabled: false, intervalMinutes: null });
    expect(heartbeats.deleted).toEqual(expect.arrayContaining([
      { jobId: 'expired-job', taskIndex: 0 }, { jobId: 'finished-job', taskIndex: 0 },
    ]));
    expect(heartbeats.records.map(record => record.jobId)).toEqual(['active-job']);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ target: { jobId: 'expired-job', taskIndex: 0 }, threadId: 'expired-thread' });
    expect(queued[0].message).toContain('System: your heartbeat was switched off automatically after 6 hours.');
    expect(queued[0].message).toContain('Heartbeat notice: This message was sent automatically by your heartbeat');
    expect(queued[0].message).toContain('by you and switches itself off');
    expect(queued[0].message).not.toContain('The human set this heartbeat.');
    expect(events.indexOf('queue:expired-job')).toBeLessThan(events.indexOf('delete:expired-job'));
    provider.scheduler().unregister('active-thread');
  });

  it('restores the remaining job heartbeats when one record cannot be read, and never fails startup recovery', async() => {
    // risk: one bad heartbeat row blocks runtime recovery, so finished sub-agent results are never redelivered.
    const record = (jobId: string): ChatHeartbeatJobRecord => ({
      jobId, taskIndex: 0, threadId: `${ jobId }-thread`, channel: 'sulla-desktop',
      config: { intervalMinutes: 5, message: 'Resume work.', startedAt: 1_000, expiresAt: 21_601_000, setBy: 'agent' },
      startedAt: 1_000, expiresAt: 21_601_000, setBy: 'agent',
    });
    const heartbeats = new MemoryHeartbeatStore([record('broken-job'), record('healthy-job')]);
    const provider = new ChatHeartbeatServiceProvider({
      jobChanges: { onJobChange: () => () => undefined },
      jobHeartbeats: heartbeats,
      getJob: async(jobId) => {
        if (jobId === 'broken-job') throw new Error('job row unreadable');
        return { jobId, status: 'parked', tasks: [{ threadId: `${ jobId }-thread`, status: 'parked' }] } as any;
      },
      hasRunningChildren: async() => false,
      now: () => 10_000,
    });

    await expect(provider.rehydrateJobHeartbeats()).resolves.toBeUndefined();

    expect(provider.scheduler().status('healthy-job-thread')).toMatchObject({ enabled: true, expiresAt: 21_601_000 });
    expect(provider.scheduler().has('broken-job-thread')).toBe(false);
    // The unreadable record is kept for the next recovery rather than destroyed on a transient error.
    expect(heartbeats.records.map(row => row.jobId)).toEqual(['broken-job', 'healthy-job']);
    provider.scheduler().unregister('healthy-job-thread');

    const unreachable = new ChatHeartbeatServiceProvider({
      jobChanges: { onJobChange: () => () => undefined },
      jobHeartbeats: { save: async() => undefined, delete: async() => undefined, all: async() => { throw new Error('table unreachable') } },
      getJob: async() => undefined,
    });
    await expect(unreachable.rehydrateJobHeartbeats()).resolves.toBeUndefined();
  });

  it('deletes the job heartbeat record at auto-off and queues the final beat for a task that is mid-turn', async() => {
    // risk: an expired heartbeat is restored by the next restart; a busy agent is never told its heartbeat is gone.
    vi.useFakeTimers();
    try {
      waits.wake.mockClear();
      const heartbeats = new MemoryHeartbeatStore();
      const queued: Array<{ target: unknown; threadId: string; message: string }> = [];
      const provider = new ChatHeartbeatServiceProvider({
        jobChanges: { onJobChange: () => () => undefined },
        jobHeartbeats: heartbeats,
        getJob: async() => ({
          jobId: 'busy-job', status: 'running', parentChannel: 'sulla-desktop',
          tasks: [{ threadId: 'busy-thread', agentId: 'codex-sol-worker', status: 'running' }],
        }) as any,
        hasRunningChildren: async() => false,
        queueJobMessage: async(target, threadId, message) => { queued.push({ target, threadId, message }); return { id: 'queued-final' } },
        now: () => Date.now(),
      });
      const scheduler = provider.scheduler();
      scheduler.register({
        threadId: 'busy-thread', channel: 'sulla-desktop', jobId: 'busy-job', taskIndex: 0,
        config: { intervalMinutes: null, message: 'Keep going.', setBy: 'agent' },
      });
      scheduler.configure('busy-thread', { intervalMinutes: 60, message: 'Keep going.', setBy: 'agent' });
      await vi.advanceTimersByTimeAsync(0);
      expect(heartbeats.records.map(row => row.jobId)).toEqual(['busy-job']);

      await vi.advanceTimersByTimeAsync(6 * 60 * 60_000);

      expect(scheduler.status('busy-thread')?.enabled).toBe(false);
      expect(heartbeats.records).toEqual([]);
      expect(heartbeats.deleted).toContainEqual({ jobId: 'busy-job', taskIndex: 0 });
      // Regular beats to the running task were dropped; only the final notice was queued, once.
      expect(queued).toHaveLength(1);
      expect(queued[0]).toMatchObject({ target: { jobId: 'busy-job', taskIndex: 0 }, threadId: 'busy-thread' });
      expect(queued[0].message).toContain('System: your heartbeat was switched off automatically after 6 hours.');
      expect(waits.wake).not.toHaveBeenCalled();
      scheduler.unregister('busy-thread');
    } finally { vi.useRealTimers() }
  });
});
