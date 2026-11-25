// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { AgentOrchestratorMessageFormatter } from './AgentOrchestratorMessageFormatter';
import type { ChatHeartbeatDeliveryOptions, ChatHeartbeatDeliveryResult, ChatHeartbeatJobTarget } from './ChatHeartbeatScheduler';

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
  /** Durable agent_job_messages queue: the task reads it at its next turn or model-call boundary. */
  queueJobMessage?(target: ChatHeartbeatJobTarget, threadId: string, message: string): Promise<{ id: string }>;
  send(channel: string, message: {
    type: 'user_message';
    data: { role: 'user'; content: string; threadId: string; metadata: Record<string, unknown> };
    timestamp: number;
  }): Promise<boolean | void>;
  now(): number;
}

/** Routes chat heartbeats and delegated-job heartbeats to their existing wake paths. */
export class ChatHeartbeatDeliveryService {
  constructor(
    private readonly ports: ChatHeartbeatDeliveryPorts,
    private readonly formatter = new AgentOrchestratorMessageFormatter(),
  ) {}

  async deliver(channel: string, threadId: string, message: string, intervalMinutes: number,
    target?: ChatHeartbeatJobTarget, options: ChatHeartbeatDeliveryOptions = {}): Promise<ChatHeartbeatDeliveryResult> {
    if (!target) return this.send(channel, threadId, message, intervalMinutes);

    const job = await this.ports.getJob(target.jobId);
    const task = job?.tasks[target.taskIndex];
    if (!job || !task || task.threadId !== threadId || !['running', 'parked'].includes(task.status)
        || !['running', 'parked'].includes(job.status)) {
      return { delivered: false, terminal: true };
    }

    // The auto-off beat is the agent's only notice that its heartbeat is gone, so it is written to
    // the job's durable message queue first, the way send_job_message does. A regular beat is
    // disposable: the next interval brings another.
    const queued = options.final && this.ports.queueJobMessage
      ? await this.ports.queueJobMessage(target, threadId, message)
      : undefined;
    const busy: ChatHeartbeatDeliveryResult = queued ? { delivered: true, queued: true } : { delivered: false, skipped: true };

    // A live turn will consume no injected user turn, and child completions
    // are already a durable wake for a parent parked on their results.
    if (task.status === 'running') return busy;
    if (await this.ports.hasRunningChildren?.(target.jobId, target.taskIndex)) return busy;

    const effectiveChannel = job.parentChannel || channel;
    // A wake race means another turn won; do not create a disconnected user_message turn.
    // `source` is deliberately left to wakeParkedAgent ('orchestrator_job_message'): that source is
    // what makes dispatchToAgent defer behind a live run instead of aborting it.
    try {
      const delivered = await this.ports.wakeParkedAgent(effectiveChannel, threadId, message, task.agentId, {
        origin: 'agent_heartbeat', inputSource: 'system', intervalMinutes,
        delegatedJobId: target.jobId, delegatedTaskIndex: target.taskIndex,
        ...(queued ? { jobId: target.jobId, taskIndex: target.taskIndex, jobMessageId: queued.id, jobMessageThreadId: threadId } : {}),
      });
      return delivered ? { delivered: true } : busy;
    } catch {
      return busy;
    }
  }

  private async send(channel: string, threadId: string, message: string, intervalMinutes: number): Promise<ChatHeartbeatDeliveryResult> {
    const sent = await this.ports.send(channel, {
      type: 'user_message',
      data: {
        role: 'user', content: this.formatter.format(message), threadId,
        metadata: {
          source: 'agent_heartbeat', inputSource: 'system', intervalMinutes,
        },
      },
      timestamp: this.ports.now(),
    });
    return sent !== false;
  }
}
