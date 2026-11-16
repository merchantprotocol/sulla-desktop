// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { AgentJob, AgentJobResult, AgentJobTask } from '../tools/agents/jobRegistry';

export interface ReturnedTaskSettlementPorts {
  getJob(jobId: string): Promise<AgentJob | undefined>;
  liveJobs(): Promise<AgentJob[]>;
  resultFor(task: AgentJobTask, label: string, threadId: string): AgentJobResult;
  recordTaskCompletion(jobId: string, taskIndex: number, result: AgentJobResult): Promise<void>;
  deliver(job: AgentJob, results: AgentJobResult[], taskIndex: number, failureReason?: string): Promise<boolean>;
  completeJob(jobId: string, results: AgentJobResult[]): Promise<void>;
  /** True while a spawn_agent runner in this process still owns the thread and will settle it itself. */
  hasLiveRunner(threadId: string): boolean;
}

const OPEN_TASK_STATUSES: readonly AgentJobTask['status'][] = ['queued', 'running', 'parked', 'blocked'];

/**
 * Settles a hidden delegated task that called return_result after its
 * original spawn_agent runner was gone (a dormant parked task woken by a
 * timer or message, typically after an app restart). The live runner is the
 * normal settlement owner; without one, the recorded return would otherwise
 * sit on a task that is re-parked forever and never reaches the parent.
 */
export class ReturnedTaskSettlement {
  constructor(private readonly ports: ReturnedTaskSettlementPorts) {}

  /** True when the task returned but no completion was ever recorded for it. */
  static isUnsettledReturn(task: AgentJobTask | undefined): boolean {
    return Boolean(task?.returnedAt) && !task?.completion && (task?.status === 'running' || task?.status === 'parked');
  }

  /** Settle one task if it returned and nobody else will; returns true when it settled. */
  async settle(jobId: string, taskIndex: number): Promise<boolean> {
    const job = await this.ports.getJob(jobId);
    const task = job?.tasks[taskIndex];
    if (!job || !task || job.visibility === 'tab' || !ReturnedTaskSettlement.isUnsettledReturn(task)) return false;
    if (task.threadId && this.ports.hasLiveRunner(task.threadId)) return false;

    const threadId = task.threadId ?? '';
    const result = this.ports.resultFor(task, task.label || task.agentId || `task-${ taskIndex }`, threadId);
    await this.ports.recordTaskCompletion(jobId, taskIndex, result);
    const settled = await this.ports.getJob(jobId);
    if (!settled) return true;
    await this.ports.deliver(settled, [result], taskIndex, result.status === 'error' ? result.output : undefined);

    // The runner that would have called completeJob after every sibling
    // settled is gone too, so close the job once nothing is left open.
    if (['running', 'parked'].includes(settled.status) && settled.tasks.every(sibling => !OPEN_TASK_STATUSES.includes(sibling.status))) {
      const results = settled.tasks.map((sibling, index) => sibling.completion ?? settled.results[index] ?? {
        label: sibling.label || sibling.agentId, status: sibling.status === 'stopped' ? 'stopped' : 'error', output: '', threadId: sibling.threadId ?? '',
      } as AgentJobResult);
      await this.ports.completeJob(jobId, results);
    }
    return true;
  }

  /** Startup sweep: no runner survives a restart, so every unsettled return is settled here. */
  async settleStranded(): Promise<number> {
    let settled = 0;
    for (const job of await this.ports.liveJobs()) {
      for (let index = 0; index < job.tasks.length; index++) {
        if (!ReturnedTaskSettlement.isUnsettledReturn(job.tasks[index])) continue;
        try {
          if (await this.settle(job.jobId, index)) settled++;
        } catch (error) {
          console.warn(`[ReturnedTaskSettlement] Failed to settle returned task ${ job.jobId }#${ index }:`, error);
        }
      }
    }
    return settled;
  }
}
