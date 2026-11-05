// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { AgentJobRepository } from '../Repositories/AgentJobRepository';
import { AgentJobTaskStatusPolicy } from '../../services/AgentJobTaskStatusPolicy';
import { JobTaskLocator } from './JobTaskLocator';
import type { CustodyLineagePort, CustodyOwnerLiveness, CustodyOwnerLivenessPort } from './JobCustodyAuthorityPolicy';
import type { CustodyOwner } from './JobCustodyTypes';

export interface ActiveGraphPresence { has(threadId:string):boolean }
export interface StrandedCustodyDetector { isStranded(threadId:string):Promise<boolean> }
export class NoopStrandedCustodyDetector implements StrandedCustodyDetector { async isStranded():Promise<boolean>{return false;} }

export class MainCustodyOwnerLiveness implements CustodyOwnerLivenessPort {
  constructor(private readonly locator:JobTaskLocator,private readonly statuses:AgentJobTaskStatusPolicy,private readonly graphs:ActiveGraphPresence,private readonly stranded:StrandedCustodyDetector=new NoopStrandedCustodyDetector()){}
  async status(owner:CustodyOwner):Promise<CustodyOwnerLiveness>{
    const located=await this.locator.findTaskByThread(owner.threadId);
    if(!located) return this.graphs.has(owner.threadId)?'alive':'unknown';
    const task=located.job.tasks[located.taskIndex];
    if(task.status==='parked') return 'parked';
    if(task.status==='lost') return 'lost';
    if(this.statuses.isTerminal(task.status)) return 'terminal';
    if(await this.stranded.isStranded(owner.threadId)) return 'stranded';
    return 'alive';
  }
}

export class JobTaskCustodyLineage implements CustodyLineagePort {
  constructor(private readonly jobs:AgentJobRepository,private readonly locator:JobTaskLocator){}
  async isAncestor(ancestorThreadId:string,descendantThreadId:string):Promise<boolean>{
    if(ancestorThreadId===descendantThreadId)return false;
    const located=await this.locator.findTaskByThread(descendantThreadId);
    return located?this.locator.isAncestorThread(located.job,ancestorThreadId):false;
  }
  async wouldCreateCycle(jobId:string,taskIndex:number|undefined,destinationThreadId:string):Promise<boolean>{
    const job=await this.jobs.job(jobId); if(!job)return false;
    const movedThread=taskIndex===undefined?undefined:job.tasks[taskIndex]?.threadId;
    if(!movedThread)return job.tasks.some(task=>task.threadId===destinationThreadId);
    if(movedThread===destinationThreadId)return true;
    return this.isAncestor(movedThread,destinationThreadId);
  }
}
