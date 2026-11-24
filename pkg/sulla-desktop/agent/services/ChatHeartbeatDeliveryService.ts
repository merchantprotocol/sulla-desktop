// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { ChatHeartbeatDeliveryResult, ChatHeartbeatJobTarget } from './ChatHeartbeatScheduler';

export interface HeartbeatJobTask {
  threadId?: string;
  agentId:   string;
  status:    string;
}

export interface HeartbeatJob {
  status: 'running' | 'parked' | 'completed' | 'failed' | 'stopped';
  parentChannel?: string;
  tasks: HeartbeatJobTask[];
}

export interface ChatHeartbeatDeliveryPorts {
  getJob(jobId: string): Promise<HeartbeatJob | undefined>;
  wakeParkedAgent(channel: string, threadId: string, message: string, agentId: string, metadata: Record<string, unknown>): Promise<boolean>;
  send(channel: string, message: {
    type: 'user_message';
    data: { role: 'user'; content: string; threadId: string; metadata: Record<string, unknown> };
    timestamp: number;
  }): Promise<boolean | void>;
  now(): number;
}

/** Routes chat heartbeats and delegated-job heartbeats to their existing wake paths. */
export class ChatHeartbeatDeliveryService {
  constructor(private readonly ports: ChatHeartbeatDeliveryPorts) {}

  async deliver(channel: string, threadId: string, message: string, intervalMinutes: number,
    target?: ChatHeartbeatJobTarget): Promise<ChatHeartbeatDeliveryResult> {
    if (!target) return this.send(channel, threadId, message, intervalMinutes);

    const job = await this.ports.getJob(target.jobId);
    const task = job?.tasks[target.taskIndex];
    if (!job || !task || task.threadId !== threadId || !['running', 'parked'].includes(task.status)
        || !['running', 'parked'].includes(job.status)) {
      return { delivered: false, terminal: true };
    }

    const effectiveChannel = job.parentChannel || channel;
    if (task.status === 'parked') {
      // Keep the existing agents/wait timer: the heartbeat is an additional wake, not a replacement.
      const delivered = await this.ports.wakeParkedAgent(effectiveChannel, threadId, message, task.agentId, {
        source: 'agent_heartbeat', inputSource: 'system', intervalMinutes,
        delegatedJobId: target.jobId, delegatedTaskIndex: target.taskIndex,
      });
      return { delivered };
    }

    return this.send(effectiveChannel, threadId, message, intervalMinutes, target);
  }

  private async send(channel: string, threadId: string, message: string, intervalMinutes: number,
    target?: ChatHeartbeatJobTarget): Promise<ChatHeartbeatDeliveryResult> {
    const sent = await this.ports.send(channel, {
      type: 'user_message',
      data: {
        role: 'user', content: message, threadId,
        metadata: {
          source: 'agent_heartbeat', inputSource: 'system', intervalMinutes,
          ...(target ? { delegatedJobId: target.jobId, delegatedTaskIndex: target.taskIndex } : {}),
        },
      },
      timestamp: this.ports.now(),
    });
    return sent !== false;
  }
}
