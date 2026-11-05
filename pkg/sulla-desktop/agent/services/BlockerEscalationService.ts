// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { Service } from '@sulla/foundation';

import type { AgentJobMessagingRepository } from '../app/Repositories/AgentJobMessagingRepository';
import type { AgentJobCheckinReceipt } from '../database/models/AgentJobMessagingModel';
import type { JobCustodyPort } from '../app/Services/JobCustodyTypes';

export interface ParentNoticeInbox {
  enqueue(channel: string, threadId: string, notice: {
    jobId: string;
    taskIndex: number;
    results: [];
    notice: string;
    dedupeKey: string;
  }): boolean;
}

/** Records worker telemetry and routes new blockers through the parent's turn-safe inbox. */
export class BlockerEscalationService extends Service {
  constructor(
    private readonly messaging: AgentJobMessagingRepository,
    private readonly inbox: ParentNoticeInbox,
    private readonly custody?: Pick<JobCustodyPort, 'resolveOwner'>,
  ) { super(); }

  async record(threadId: string, input: {
    step: string;
    summary: string;
    filesTouched?: string[];
    blockers?: string[];
    percent?: number;
  }): Promise<AgentJobCheckinReceipt | null> {
    const receipt = await this.messaging.appendCheckin(threadId, input);
    if (!receipt?.blockersChanged || receipt.checkin.blockers.length === 0) return receipt;

    const { target, checkin } = receipt;
    const owner=await this.custody?.resolveOwner(target.jobId,target.taskIndex) ?? (target.parentThreadId?{channel:target.parentChannel??'sulla-desktop',threadId:target.parentThreadId}:undefined);
    if (!owner) return receipt;
    const blockers = checkin.blockers.join('; ');
    const label = target.label ?? `task ${ target.taskIndex }`;
    this.inbox.enqueue(owner.channel, owner.threadId, {
      jobId: target.jobId,
      taskIndex: target.taskIndex,
      results: [],
      notice: `[Blocker from ${ label } (job ${ target.jobId } task ${ target.taskIndex })] ${ blockers } — answer with agents/send_job_message`,
      dedupeKey: `blocker:${ target.jobId }:${ target.taskIndex }:${ JSON.stringify(checkin.blockers) }`,
    });
    return receipt;
  }
}
