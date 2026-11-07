// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { AgentJobRepository } from '../Repositories/AgentJobRepository';
import type { CompletionInboxStore } from '../../services/AgentCompletionInbox';
import type { CustodyAuditRecord,CustodyChangeNotifier } from './JobCustodyTypes';

export class CustodyChangeNotificationService implements CustodyChangeNotifier {
  constructor(private readonly jobs:AgentJobRepository,private readonly inbox:CompletionInboxStore){}
  async changed(change:CustodyAuditRecord):Promise<void>{
    const job=await this.jobs.job(change.jobId); if(!job)return;
    const actor=change.actor.kind==='human'?'human':change.actor.agentId;
    const scope=change.taskIndex===undefined?'all tasks':`task ${change.taskIndex}`;
    const moved=this.inbox.move(change.from.channel,change.from.threadId,change.to.channel,change.to.threadId,change.jobId,change.taskIndex);
    this.inbox.enqueue(change.from.channel,change.from.threadId,{jobId:change.jobId,taskIndex:change.taskIndex??0,results:[],notice:`Job ${change.jobId} (${scope}) moved to ${change.to.agentId} by ${actor}: ${change.reason}`,dedupeKey:`custody-old:${change.jobId}:${change.taskIndex??'all'}:${change.version}`});
    const statuses=job.tasks.map((task,index)=>`${index}:${task.status}`).join(', ');
    this.inbox.enqueue(change.to.channel,change.to.threadId,{jobId:change.jobId,taskIndex:change.taskIndex??0,results:[],notice:`[Custody handoff] Job ${change.jobId} (${scope}); tasks ${statuses}; ${moved} undelivered item(s) moved from ${change.from.agentId}.`,dedupeKey:`custody-new:${change.jobId}:${change.taskIndex??'all'}:${change.version}`});
  }
}
