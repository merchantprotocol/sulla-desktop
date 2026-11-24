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
  hasRunningChildren?(jobId: string, taskIndex: number): Promise<boolean>;
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

    // A live turn will consume no injected user turn, and child completions
    // are already a durable wake for a parent parked on their results.
    if (task.status === 'running') return { delivered: false, skipped: true };
    if (await this.ports.hasRunningChildren?.(target.jobId, target.taskIndex)) return { delivered: false, skipped: true };

    const effectiveChannel = job.parentChannel || channel;
    // A wake race means another turn won; do not create a disconnected
    // user_message turn or cancel the independent agents/wait timer.
    try {
      const delivered = await this.ports.wakeParkedAgent(effectiveChannel, threadId, message, task.agentId, {
        source: 'agent_heartbeat', inputSource: 'system', intervalMinutes,
        delegatedJobId: target.jobId, delegatedTaskIndex: target.taskIndex,
      });
      return delivered ? { delivered: true } : { delivered: false, skipped: true };
    } catch {
      return { delivered: false, skipped: true };
    }
  }

  private async send(channel: string, threadId: string, message: string, intervalMinutes: number): Promise<ChatHeartbeatDeliveryResult> {
    const sent = await this.ports.send(channel, {
      type: 'user_message',
      data: {
        role: 'user', content: message, threadId,
        metadata: {
          source: 'agent_heartbeat', inputSource: 'system', intervalMinutes,
        },
      },
      timestamp: this.ports.now(),
    });
    return sent !== false;
  }
}
