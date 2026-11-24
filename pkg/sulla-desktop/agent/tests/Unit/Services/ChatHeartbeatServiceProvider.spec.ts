// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it, vi } from 'vitest';

vi.mock('@pkg/main/SleepPreventionService', () => ({ acquireChatActivity: vi.fn(), releaseChatActivity: vi.fn() }));
vi.mock('@pkg/agent/services/GraphRegistry', () => ({ GraphRegistry: { get: vi.fn() } }));
vi.mock('@pkg/agent/services/WebSocketClientService', () => ({ getWebSocketClientService: vi.fn() }));
const waits = vi.hoisted(() => ({ cancel: vi.fn(async() => true), pending: vi.fn(async() => ({ id: 'wait-1' })), wake: vi.fn(async() => true) }));
vi.mock('@pkg/agent/services/AgentWaitServices', () => ({
  agentWaitProvider: { cancel: waits.cancel, repository: { pending: waits.pending, cancel: waits.cancel }, scheduler: { cancel: waits.cancel } },
}));
vi.mock('@pkg/agent/services/BackendGraphWebSocketService', () => ({
  getBackendGraphWebSocketService: () => ({ wakeParkedAgent: waits.wake }),
}));

import { ChatHeartbeatServiceProvider, chatHeartbeatProvider } from '@pkg/agent/app/Providers/ChatHeartbeatServiceProvider';
import type { ChatHeartbeatJobRecord, ChatHeartbeatJobRecordStore } from '@pkg/agent/app/Repositories/ChatHeartbeatJobRepository';
import { getChatHeartbeatService } from '@pkg/agent/services/ChatHeartbeatService';

class MemoryHeartbeatStore implements ChatHeartbeatJobRecordStore {
  readonly records: ChatHeartbeatJobRecord[] = [];
  readonly deleted: Array<{ jobId: string; taskIndex: number }> = [];

  constructor(records: ChatHeartbeatJobRecord[] = []) { this.records.push(...records) }
  async save(record: ChatHeartbeatJobRecord): Promise<void> {
    const index = this.records.findIndex(row => row.jobId === record.jobId && row.taskIndex === record.taskIndex);
    if (index < 0) this.records.push(record);
    else this.records[index] = record;
  }
  async all(): Promise<ChatHeartbeatJobRecord[]> { return [...this.records] }
  async delete(jobId: string, taskIndex: number): Promise<void> {
    this.deleted.push({ jobId, taskIndex });
    const index = this.records.findIndex(row => row.jobId === jobId && row.taskIndex === taskIndex);
    if (index >= 0) this.records.splice(index, 1);
  }
}

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

  it('wakes a parked job on a beat without cancelling its agents/wait, and reports the wait from the wait repository', async() => {
    // risk: a heartbeat silently destroys the agent's own agents/wait timer, or claims a wait that no longer exists.
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
      expect(waits.cancel).not.toHaveBeenCalled();

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
      config: { ...activeRecord.config, startedAt: 2_000, expiresAt: now }, startedAt: 2_000, expiresAt: now,
    };
    const finishedRecord: ChatHeartbeatJobRecord = { ...activeRecord, jobId: 'finished-job', threadId: 'finished-thread' };
    const heartbeats = new MemoryHeartbeatStore([activeRecord, expiredRecord, finishedRecord]);
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
    provider.scheduler().unregister('active-thread');
  });
});
