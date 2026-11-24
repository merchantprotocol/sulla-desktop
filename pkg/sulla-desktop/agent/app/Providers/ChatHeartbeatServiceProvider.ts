// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { ChatHeartbeatScheduler } from '../../services/ChatHeartbeatScheduler';
import { ChatHeartbeatDeliveryService } from '../../services/ChatHeartbeatDeliveryService';
import { ChatHeartbeatJobRepository, type ChatHeartbeatJobRecordStore } from '../Repositories/ChatHeartbeatJobRepository';
import { GraphRegistry } from '../../services/GraphRegistry';
import { getWebSocketClientService } from '../../services/WebSocketClientService';
import { acquireChatActivity, releaseChatActivity } from '@pkg/main/SleepPreventionService';
import { postgresClient } from '../../database/PostgresClient';
import { normalizeChatHeartbeatConfig } from '@pkg/shared/chatHeartbeat';
import type { AgentJob } from '../../tools/agents/jobRegistry';

interface AgentJobChangeSource {
  onJobChange(listener: (previous: AgentJob, next: AgentJob) => void | Promise<void>): () => void;
}

interface ChatHeartbeatProviderDependencies {
  jobChanges?: AgentJobChangeSource;
  jobHeartbeats?: ChatHeartbeatJobRecordStore;
  getJob?: (jobId: string) => Promise<AgentJob | undefined>;
  hasRunningChildren?: (jobId: string, taskIndex: number) => Promise<boolean>;
  now?: () => number;
}

/** Owns the one chat-heartbeat scheduler; built on first use so importing has no side effects. */
export class ChatHeartbeatServiceProvider {
  private instance: ChatHeartbeatScheduler | null = null;
  private subscribedToJobLifecycle = false;
  private subscriptionStart: Promise<void> | null = null;
  private readonly jobHeartbeats: ChatHeartbeatJobRecordStore;
  private readonly getJob: (jobId: string) => Promise<AgentJob | undefined>;
  private readonly hasRunningChildren: (jobId: string, taskIndex: number) => Promise<boolean>;
  private readonly now: () => number;

  constructor(private readonly dependencies: ChatHeartbeatProviderDependencies = {}) {
    this.jobHeartbeats = dependencies.jobHeartbeats ?? new ChatHeartbeatJobRepository(postgresClient);
    this.getJob = dependencies.getJob ?? (async(jobId) => {
      const { getJob } = await import('../../tools/agents/jobRegistry');
      return getJob(jobId);
    });
    this.hasRunningChildren = dependencies.hasRunningChildren ?? (async(jobId, taskIndex) => {
      const { agentJobProvider } = await import('./AgentJobServiceProvider');
      return agentJobProvider.jobs.hasRunningChildren(jobId, taskIndex);
    });
    this.now = dependencies.now ?? Date.now;
  }

  scheduler(): ChatHeartbeatScheduler {
    if (this.instance) return this.instance;
    const delivery = new ChatHeartbeatDeliveryService({
      getJob: jobId => this.getJob(jobId),
      hasRunningChildren: (jobId, taskIndex) => this.hasRunningChildren(jobId, taskIndex),
      wakeParkedAgent: async(channel, threadId, message, agentId, metadata) => {
        const { getBackendGraphWebSocketService } = await import('../../services/BackendGraphWebSocketService');
        return getBackendGraphWebSocketService().wakeParkedAgent(channel, threadId, message, agentId, metadata);
      },
      send: (channel, message) => getWebSocketClientService().send(channel, message),
      now: this.now,
    });
    this.instance = new ChatHeartbeatScheduler({
      now: this.now,
      setActive: (threadId, active) => {
        const key = `chat-heartbeat:${ threadId }`;
        if (active) acquireChatActivity(key);
        else releaseChatActivity(key);
      },
      isGraphBusy: (threadId) => {
        const record = GraphRegistry.get(threadId);
        return !!record && record.state?.metadata?.cycleComplete !== true;
      },
      deliver: (channel, threadId, message, intervalMinutes, target) => delivery.deliver(channel, threadId, message, intervalMinutes, target),
      hasPendingWait: async({ jobId, taskIndex }) => {
        const { agentWaitProvider } = await import('../../services/AgentWaitServices');
        return Boolean(await agentWaitProvider.repository.pending(jobId, taskIndex));
      },
    });
    void this.ensureJobLifecycleSubscription().catch(error => console.warn('[ChatHeartbeat] job lifecycle subscription failed:', error));
    return this.instance;
  }

  async ensureJobLifecycleSubscription(): Promise<void> {
    if (this.subscribedToJobLifecycle) return;
    if (this.subscriptionStart) return this.subscriptionStart;
    this.subscriptionStart = (async() => {
      const source = this.dependencies.jobChanges ?? (await import('./AgentJobServiceProvider')).agentJobProvider.states;
      // The job store emits synchronously; own the promise here so a failed delete never rejects unhandled.
      source.onJobChange((previous, next) => this.clearSettledJobHeartbeats(previous, next)
        .catch(error => console.warn(`[ChatHeartbeat] job heartbeat cleanup failed for ${ next.jobId }:`, error)));
      this.subscribedToJobLifecycle = true;
    })().finally(() => { this.subscriptionStart = null });
    return this.subscriptionStart;
  }

  private async clearSettledJobHeartbeats(previous: AgentJob, next: AgentJob): Promise<void> {
    const settledIndexes = new Set<number>();
    for (let index = 0; index < previous.tasks.length; index++) {
      const before = previous.tasks[index];
      const after = next.tasks[index];
      if (this.isOpenTask(before) && !this.isOpenTask(after)) settledIndexes.add(index);
    }
    if (!['running', 'parked'].includes(next.status)) {
      for (let index = 0; index < next.tasks.length; index++) settledIndexes.add(index);
    }
    for (const index of settledIndexes) this.instance?.unregisterJobTask(next.jobId, index);
    await Promise.all([...settledIndexes].map(index => this.jobHeartbeats.delete(next.jobId, index)));
  }

  async persistJobHeartbeat(threadId: string): Promise<void> {
    const scheduler = this.scheduler();
    const target = scheduler.jobTarget(threadId);
    if (!target) return;
    const record = scheduler.jobHeartbeatRecord(threadId);
    if (!record) {
      await this.jobHeartbeats.delete(target.jobId, target.taskIndex);
      return;
    }
    await this.jobHeartbeats.save({ ...record, setBy: record.config.setBy ?? 'agent' });
  }

  async rehydrateJobHeartbeats(): Promise<void> {
    await this.ensureJobLifecycleSubscription();
    for (const record of await this.jobHeartbeats.all()) {
      const job = await this.getJob(record.jobId);
      const task = job?.tasks[record.taskIndex];
      if (!job || !task || task.threadId !== record.threadId || !['running', 'parked'].includes(job.status)
          || !['running', 'parked'].includes(task.status)) {
        await this.jobHeartbeats.delete(record.jobId, record.taskIndex);
        continue;
      }
      const status = this.scheduler().register({
        threadId: record.threadId,
        channel: job.parentChannel || record.channel || 'sulla-desktop',
        jobId: record.jobId,
        taskIndex: record.taskIndex,
        config: normalizeChatHeartbeatConfig({ ...record.config, startedAt: record.startedAt, expiresAt: record.expiresAt, setBy: record.setBy }),
      });
      if (!status.enabled) await this.jobHeartbeats.delete(record.jobId, record.taskIndex);
    }
  }

  private isOpenTask(task: import('../../tools/agents/jobRegistry').AgentJobTask | undefined): boolean {
    if (!task) return false;
    return ['queued', 'running', 'parked'].includes(task.status)
      || (task.status === 'blocked' && !task.returnedAt && !task.finishedAt);
  }
}
export const chatHeartbeatProvider = new ChatHeartbeatServiceProvider();
