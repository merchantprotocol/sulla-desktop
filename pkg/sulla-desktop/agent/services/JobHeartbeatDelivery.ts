// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { AgentHeartbeatPolicy } from './AgentHeartbeatPolicy';

import type { AgentJob, AgentJobTask } from '../tools/agents/jobRegistry';

export interface JobThreadOwner { job: AgentJob; taskIndex: number; }
export interface JobThreadLookup { findTaskByThread(threadId: string): Promise<JobThreadOwner | undefined>; }
export interface JobHeartbeatOutcome { applicable: boolean; delivered: boolean; }

const TERMINAL_JOB_STATUSES: AgentJob['status'][] = ['completed', 'failed', 'stopped'];
const TERMINAL_TASK_STATUSES: AgentJobTask['status'][] = ['completed', 'blocked', 'error', 'stopped'];
const NOT_APPLICABLE: JobHeartbeatOutcome = { applicable: false, delivered: false };

/**
 * Delivers a chat heartbeat to a hidden spawned job's own agent, instead of
 * the generic WebSocket send a visible tab heartbeat uses. The destination is
 * resolved fresh from the live job registry on every beat (not cached on the
 * scheduler registration), so a park/resume/restart between beats is always
 * picked up correctly, and a human re-registering the same thread through the
 * tab IPC path never has to carry job identity through that call too.
 */
export class JobHeartbeatDelivery {
  constructor(
    private readonly jobs: JobThreadLookup,
    private readonly policy: AgentHeartbeatPolicy,
    private readonly wakeParkedAgent: (channelId: string, threadId: string, message: string, agentId: string, messageMeta?: Record<string, unknown>) => Promise<boolean>,
    private readonly unregister: (threadId: string) => void,
    private readonly log: (message: string) => void,
  ) {}

  /**
   * Not applicable for a thread that owns no hidden job task (a plain chat,
   * or a job explicitly opened as a visible tab) — the caller falls back to
   * its own tab delivery in that case, unchanged.
   */
  async tryDeliver(channelId: string, threadId: string, message: string, intervalMinutes: number): Promise<JobHeartbeatOutcome> {
    const owner = await this.jobs.findTaskByThread(threadId);
    const task = owner?.job.tasks[owner.taskIndex];
    if (!owner || task?.visibility !== 'hidden') return NOT_APPLICABLE;

    if (TERMINAL_JOB_STATUSES.includes(owner.job.status) || TERMINAL_TASK_STATUSES.includes(task.status)) {
      this.log(`[JobHeartbeatDelivery] Job ${ owner.job.jobId } task ${ owner.taskIndex } is terminal; dropping its heartbeat for thread ${ threadId }.`);
      this.unregister(threadId);
      return { applicable: true, delivered: false };
    }

    const decision = await this.policy.decide(task.agentId, intervalMinutes);
    if (!decision.allowed) {
      this.log(`[JobHeartbeatDelivery] Policy no longer allows a heartbeat for agent ${ task.agentId } (thread ${ threadId }): ${ decision.reason } Dropping it.`);
      this.unregister(threadId);
      return { applicable: true, delivered: false };
    }

    try {
      // Covers every live state in one call: a manager parked mid in-process
      // wait for its children gets the message injected and is woken in
      // place; a dormant parked job (no live waiter, e.g. after a restart) is
      // dispatched a fresh turn; a turn already busy for this thread declines
      // without throwing, which the caller correctly treats as "wait".
      const delivered = await this.wakeParkedAgent(channelId, threadId, message, task.agentId, { intervalMinutes });
      return { applicable: true, delivered };
    } catch {
      // Not parked at all: the agent is actively mid-turn on real work, not
      // waiting on anything. That is busy, not an error — wait and retry.
      return { applicable: true, delivered: false };
    }
  }
}
