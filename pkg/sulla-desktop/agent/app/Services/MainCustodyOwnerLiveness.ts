// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { AgentJobRepository } from '../Repositories/AgentJobRepository';
import { AgentJobCustodyRepository } from '../Repositories/AgentJobCustodyRepository';
import type { AgentJobTaskStatus } from '../../tools/agents/jobRegistry';
import { JobTaskLocator } from './JobTaskLocator';
import type { CustodyLineagePort, CustodyOwnerLiveness, CustodyOwnerLivenessPort } from './JobCustodyAuthorityPolicy';
import type { CustodyOwner } from './JobCustodyTypes';

export interface CustodyTaskStatusClassifier { isTerminal(status:AgentJobTaskStatus):boolean }
export interface ActiveGraphPresence { matches(owner:CustodyOwner):Promise<boolean> }
export interface StrandedOwnerDetectorPort { isStranded(owner:CustodyOwner):Promise<boolean> }
export class MainStrandedOwnerDetector implements StrandedOwnerDetectorPort {
  constructor(private readonly locator:JobTaskLocator,private readonly jobs:AgentJobRepository){}
  async isStranded(owner:CustodyOwner):Promise<boolean>{
    const located=await this.locator.findTaskByThread(owner.threadId);
    if(!located||!['completed','blocked','error','stopped','lost'].includes(located.job.tasks[located.taskIndex].status))return false;
    return (await this.jobs.allJobs()).some(job=>job.parentThreadId===owner.threadId&&job.tasks.some(task=>['queued','running','parked'].includes(task.status)));
  }
}

export class MainCustodyOwnerLiveness implements CustodyOwnerLivenessPort {
  constructor(private readonly locator:JobTaskLocator,private readonly statuses:CustodyTaskStatusClassifier,private readonly graphs:ActiveGraphPresence,private readonly stranded:StrandedOwnerDetectorPort){}
  async status(owner:CustodyOwner):Promise<CustodyOwnerLiveness>{
    const located=await this.locator.findTaskByThread(owner.threadId);
    if(!located)return await this.graphs.matches(owner)?'alive':'missing';
    const task=located.job.tasks[located.taskIndex];
    if(task.agentId!==owner.agentId)return 'missing';
    if(task.status==='parked')return 'parked';
    if(task.status==='lost')return 'lost';
    if(await this.stranded.isStranded(owner))return 'stranded';
    if(this.statuses.isTerminal(task.status))return 'terminal';
    return 'alive';
  }
}

/** Walks effective custody, not immutable launch ancestry. */
export class JobTaskCustodyLineage implements CustodyLineagePort {
  constructor(private readonly jobs:AgentJobRepository,private readonly locator:JobTaskLocator,private readonly custody:AgentJobCustodyRepository){}
  async isAncestor(ancestorThreadId:string,descendantThreadId:string):Promise<boolean>{
    if(ancestorThreadId===descendantThreadId)return false;
    let threadId:string|undefined=descendantThreadId;
    const visited=new Set<string>();
    while(threadId&&!visited.has(threadId)){
      visited.add(threadId);
      const located=await this.locator.findTaskByThread(threadId);
      if(!located)return false;
      const owner=await this.custody.resolveOwner(located.job.jobId,located.taskIndex);
      if(!owner)return false;
      if(owner.threadId===ancestorThreadId)return true;
      threadId=owner.threadId;
    }
    return false;
  }
  async wouldCreateCycle(jobId:string,taskIndex:number|undefined,destinationThreadId:string):Promise<boolean>{
    const job=await this.jobs.job(jobId);if(!job)return false;
    const roots=taskIndex===undefined?job.tasks.map(task=>task.threadId).filter((value):value is string=>Boolean(value)):[job.tasks[taskIndex]?.threadId].filter((value):value is string=>Boolean(value));
    for(const root of roots)if(root===destinationThreadId||await this.isAncestor(root,destinationThreadId))return true;
    return false;
  }
}
