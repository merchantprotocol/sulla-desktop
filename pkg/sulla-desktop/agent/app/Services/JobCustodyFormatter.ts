// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { AgentJob } from '../../tools/agents/jobRegistry';
import type { JobCustodyPort } from './JobCustodyTypes';
export class JobCustodyFormatter {
  constructor(private readonly custody:Pick<JobCustodyPort,'resolveOwner'|'history'>){}
  async format(job:AgentJob):Promise<Record<string,unknown>|undefined>{
    const owner=await this.custody.resolveOwner(job.jobId);
    if(!owner)return undefined;
    const history=await this.custody.history(job.jobId);
    return {owner:{channel:owner.channel,threadId:owner.threadId,agentId:owner.agentId},launchedBy:{channel:job.parentChannel,threadId:job.parentThreadId,agentId:job.parentAgentId},history:history.map(item=>({from:item.from,to:item.to,by:item.actor,reason:item.reason,at:item.changedAt.toISOString(),...(item.taskIndex===undefined?{}:{taskIndex:item.taskIndex})}))};
  }
}
