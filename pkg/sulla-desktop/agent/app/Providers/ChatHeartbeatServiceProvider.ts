// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { ChatHeartbeatScheduler } from '../../services/ChatHeartbeatScheduler';
import { ChatHeartbeatDeliveryService } from '../../services/ChatHeartbeatDeliveryService';
import { GraphRegistry } from '../../services/GraphRegistry';
import { getWebSocketClientService } from '../../services/WebSocketClientService';
import { acquireChatActivity, releaseChatActivity } from '@pkg/main/SleepPreventionService';
import type { AgentJob } from '../../tools/agents/jobRegistry';

interface AgentJobChangeSource {
  onJobChange(listener: (previous: AgentJob, next: AgentJob) => void): () => void;
}

/** Owns the one chat-heartbeat scheduler; built on first use so importing has no side effects. */
export class ChatHeartbeatServiceProvider {
  private instance: ChatHeartbeatScheduler | null = null;
  private subscribedToJobLifecycle = false;
  private subscriptionStart: Promise<void> | null = null;

  constructor(private readonly jobChanges?: AgentJobChangeSource) {}

  scheduler(): ChatHeartbeatScheduler {
    if (this.instance) return this.instance;
    const delivery = new ChatHeartbeatDeliveryService({
      getJob: async(jobId) => {
        const { getJob } = await import('../../tools/agents/jobRegistry');
        return getJob(jobId);
      },
      cancelWait: async(jobId, taskIndex) => {
        const { agentWaitProvider } = await import('../../services/AgentWaitServices');
        return agentWaitProvider.cancel(jobId, taskIndex);
      },
      wakeParkedAgent: async(channel, threadId, message, agentId, metadata) => {
        const { getBackendGraphWebSocketService } = await import('../../services/BackendGraphWebSocketService');
        return getBackendGraphWebSocketService().wakeParkedAgent(channel, threadId, message, agentId, metadata);
      },
      send: (channel, message) => getWebSocketClientService().send(channel, message),
      now: Date.now,
    });
    this.instance = new ChatHeartbeatScheduler({
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
    });
    void this.ensureJobLifecycleSubscription().catch(error => console.warn('[ChatHeartbeat] job lifecycle subscription failed:', error));
    return this.instance;
  }

  async ensureJobLifecycleSubscription(): Promise<void> {
    if (this.subscribedToJobLifecycle) return;
    if (this.subscriptionStart) return this.subscriptionStart;
    this.subscriptionStart = (async() => {
      const source = this.jobChanges ?? (await import('./AgentJobServiceProvider')).agentJobProvider.states;
      source.onJobChange((previous, next) => this.clearSettledJobHeartbeats(previous, next));
      this.subscribedToJobLifecycle = true;
    })().finally(() => { this.subscriptionStart = null });
    return this.subscriptionStart;
  }

  private clearSettledJobHeartbeats(previous: import('../../tools/agents/jobRegistry').AgentJob,
    next: import('../../tools/agents/jobRegistry').AgentJob): void {
    if (!this.instance) return;
    for (let index = 0; index < previous.tasks.length; index++) {
      const before = previous.tasks[index];
      const after = next.tasks[index];
      if (this.isOpenTask(before) && !this.isOpenTask(after)) this.instance.unregisterJobTask(next.jobId, index);
    }
    if (!['running', 'parked'].includes(next.status)) {
      for (let index = 0; index < next.tasks.length; index++) this.instance.unregisterJobTask(next.jobId, index);
    }
  }

  private isOpenTask(task: import('../../tools/agents/jobRegistry').AgentJobTask | undefined): boolean {
    if (!task) return false;
    return ['queued', 'running', 'parked'].includes(task.status)
      || (task.status === 'blocked' && !task.returnedAt && !task.finishedAt);
  }
}
export const chatHeartbeatProvider = new ChatHeartbeatServiceProvider();
