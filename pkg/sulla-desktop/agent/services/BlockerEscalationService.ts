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
    private readonly custody?: Pick<JobCustodyPort, 'resolveOwner'|'withOwner'>,
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
    const blockers = checkin.blockers.join('; ');
    const label = target.label ?? `task ${ target.taskIndex }`;
    const enqueue=(owner:{channel:string;threadId:string})=>this.inbox.enqueue(owner.channel,owner.threadId,{
      jobId:target.jobId,taskIndex:target.taskIndex,results:[],
      notice:`[Blocker from ${label} (job ${target.jobId} task ${target.taskIndex})] ${blockers} — answer with agents/send_job_message`,
      dedupeKey:`blocker:${target.jobId}:${target.taskIndex}:${JSON.stringify(checkin.blockers)}`,
    });
    if(this.custody){await this.custody.withOwner(target.jobId,target.taskIndex,async(_client,owner)=>{enqueue(owner);});}
    else if(target.parentThreadId)enqueue({channel:target.parentChannel??'sulla-desktop',threadId:target.parentThreadId});
    return receipt;
  }
}
