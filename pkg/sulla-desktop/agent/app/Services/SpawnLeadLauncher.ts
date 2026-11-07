// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { SpawnAgentWorker } from '../../tools/agents/spawn_agent';
import type { AgentJobRepository } from '../Repositories/AgentJobRepository';
import type { LeadReplacementLaunch,LeadReplacementLaunchInput,LeadTaskExecutionPort } from './LeadTaskExecutionPort';

export class SpawnLeadLauncher implements LeadTaskExecutionPort {
  constructor(private readonly jobs:AgentJobRepository,private readonly workerFactory:()=>SpawnAgentWorker=()=>new SpawnAgentWorker()){}
  async launchReplacement(input:LeadReplacementLaunchInput):Promise<LeadReplacementLaunch>{
    const label=`Replacement ${input.launchKey}`;
    const worker=this.workerFactory();
    const response=await worker.runValidated({tasks:[{agentId:input.agentId,model:input.model,provider:input.provider,prompt:input.prompt,label,visibility:'hidden'}],parallel:true,async:true,launchKey:input.launchKey},{metadata:{wsChannel:input.owner.channel,threadId:input.owner.threadId,routedAgentId:input.owner.agentId,agentId:input.owner.agentId}});
    if(!response.successBoolean) throw new Error(response.responseString);
    const jobId=String((response.result as any)?.jobId??'');
    const job=jobId?await this.jobs.job(jobId):undefined; const task=job?.tasks[0];
    if(!jobId||!task?.threadId||!task.agentConfigChannel||!task.agentId) throw new Error('Replacement launch did not persist its complete routing identity.');
    return {jobId,taskIndex:0,channel:task.agentConfigChannel,threadId:task.threadId,agentId:task.agentId};
  }
}
