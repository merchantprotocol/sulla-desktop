// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Opens a running hidden task as a visible tab, bound to its existing thread.
 * Authorization is the stop rule: only the job's ancestors or the human may
 * promote. The job, task and history are not restarted or copied.
 */

import type { AgentJob } from '../tools/agents/jobRegistry';
import type { StopPrincipalValue } from '../app/ValueObjects/StopPrincipal';

/** The job-store operations a promotion needs (satisfied by the job registry). */
export interface PromotableJobStore {
  getJob(jobId: string): Promise<AgentJob | undefined>;
  authorize(jobId: string, principal: StopPrincipalValue): Promise<'allowed' | 'not-found' | 'forbidden'>;
  markTaskPromoted(jobId: string, taskIndex: number): Promise<unknown>;
}

/** Opens one task's thread in a tab; returns false when the renderer is unreachable. */
export type TaskTabOpener = (job: AgentJob, taskIndex: number, focus: boolean) => boolean;

export interface PromoteToTabResult {
  successBoolean: boolean;
  /** Renderer tab handle: the contract id the renderer keys the tab by. */
  tabId?:         string;
  alreadyVisible?: boolean;
  error?:         string;
}

export class AgentTabPromoter {
  constructor(
    private readonly jobs: PromotableJobStore,
    private readonly openTab: TaskTabOpener,
  ) {}

  async promote(jobId: string, taskIndex: number | undefined, principal: StopPrincipalValue): Promise<PromoteToTabResult> {
    const index = taskIndex ?? 0;
    if (!Number.isInteger(index) || index < 0) return this.refuse('taskIndex must be a non-negative integer.');

    const authorization = await this.jobs.authorize(jobId, principal);
    if (authorization === 'not-found') return this.refuse(`Job "${ jobId }" not found.`);
    if (authorization === 'forbidden') return this.refuse(`Cannot promote job "${ jobId }": only its ancestors or the human can open its task in a tab.`);

    const job = await this.jobs.getJob(jobId);
    const task = job?.tasks[index];
    if (!job || !task) return this.refuse(`Job "${ jobId }" has no task ${ index }.`);

    const tabId = job.visibility === 'tab' ? job.jobId : `${ job.jobId }#${ index }`;
    if (job.visibility === 'tab') return { successBoolean: true, tabId, alreadyVisible: true };
    if (!task.threadId) return this.refuse(`Task ${ index } of job "${ jobId }" has no thread to open.`);
    if (!['queued', 'running', 'parked'].includes(task.status)) {
      return this.refuse(`Task ${ index } of job "${ jobId }" is ${ task.status }; only a live task can be opened in a tab.`);
    }

    // Open first: a failed open must not leave the task marked as promoted.
    if (!this.openTab(job, index, false)) {
      return this.refuse('Sulla Desktop renderer is not available, so the tab could not be opened.');
    }
    const alreadyVisible = task.promotedToTab === true;
    if (!alreadyVisible) await this.jobs.markTaskPromoted(jobId, index);
    return { successBoolean: true, tabId, alreadyVisible };
  }

  private refuse(error: string): PromoteToTabResult {
    return { successBoolean: false, error };
  }
}
