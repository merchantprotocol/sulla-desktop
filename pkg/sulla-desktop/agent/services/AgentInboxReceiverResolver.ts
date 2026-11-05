// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { AgentInboxTarget } from './AgentInbox';
import type { AgentJob } from '../tools/agents/jobRegistry';
import type { JobCustodyPort } from '../app/Services/JobCustodyTypes';

export interface AgentInboxReceiverResolver { resolve(channel: string): Promise<AgentInboxTarget>; resolveAll?(channel:string):Promise<AgentInboxTarget[]> }
export interface AgentInboxJobReader { allJobs(): Promise<AgentJob[]> }

/** Resolves a channel to its own persona and durable parked thread; never falls back to Sulla for named agents. */
export class DurableAgentInboxReceiverResolver implements AgentInboxReceiverResolver {
  constructor(private readonly jobs: AgentInboxJobReader, private readonly activeThreads: (channel: string) => string|string[]|undefined,private readonly custody?:Pick<JobCustodyPort,'resolveOwner'>) {}

  async resolve(channel: string): Promise<AgentInboxTarget> {
    return (await this.resolveAll(channel))[0]??{channel,agentId:channel};
  }
  async resolveAll(channel:string):Promise<AgentInboxTarget[]>{
    const candidates=new Map<string,AgentInboxTarget>();
    const active=this.activeThreads(channel);for(const threadId of Array.isArray(active)?active:active?[active]:[])candidates.set(threadId,{channel,threadId,agentId:channel});
    const jobs = await this.jobs.allJobs();
    for (const job of jobs.sort((a,b) => b.createdAt-a.createdAt)) {
      for(let index=0;index<job.tasks.length;index++){const task=job.tasks[index];if(task.agentId===channel&&task.status==='parked'&&task.threadId)candidates.set(task.threadId,{channel,threadId:task.threadId,agentId:channel});}
      if(job.status==='parked'){const owner=await this.custody?.resolveOwner(job.jobId);if(owner?.agentId===channel)candidates.set(owner.threadId,owner);else if(!this.custody&&job.parentAgentId===channel&&job.parentThreadId)candidates.set(job.parentThreadId,{channel,threadId:job.parentThreadId,agentId:channel});}
    }
    return [...candidates.values()];
  }
}
