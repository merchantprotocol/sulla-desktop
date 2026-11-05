// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { Clock } from '@sulla/foundation';
import { AgentJobCustodyRepository } from '../Repositories/AgentJobCustodyRepository';
import { JobCustodyAuthorityPolicy } from './JobCustodyAuthorityPolicy';
import type { CustodyAuditRecord,CustodyChangeNotifier,CustodyMoveInput,CustodyMoveResult,CustodyRecord,JobCustodyPort } from './JobCustodyTypes';

export class JobCustodyService implements JobCustodyPort {
  constructor(private readonly repository:AgentJobCustodyRepository,private readonly policy:JobCustodyAuthorityPolicy,private readonly notifier:CustodyChangeNotifier,private readonly clock:Clock){}
  async authorizeManagement(jobId:string,taskIndex:number|undefined,actor:import('./JobCustodyTypes').CustodyActor):Promise<CustodyMoveResult|undefined>{
    const current=await this.repository.resolveOwner(jobId,taskIndex);
    if(!current)return {ok:false,code:'not-found',message:`Job ${jobId} was not found.`};
    return this.policy.authorizeManagement(current,actor);
  }
  async move(input:CustodyMoveInput):Promise<CustodyMoveResult>{
    const changedAt=this.clock.now();
    const result=await this.repository.move(input,async current=>this.policy.authorize({jobId:input.jobId,taskIndex:input.taskIndex,current,destination:input.to,actor:input.actor}),changedAt);
    if(result.ok){await this.notifier.changed({jobId:input.jobId,...(input.taskIndex===undefined?{}:{taskIndex:input.taskIndex}),from:result.previous,to:result.current,actor:input.actor,reason:input.reason,version:result.current.version,changedAt});}
    return result;
  }
  resolveOwner(jobId:string,taskIndex?:number):Promise<CustodyRecord|undefined>{return this.repository.resolveOwner(jobId,taskIndex);}
  history(jobId:string):Promise<CustodyAuditRecord[]>{return this.repository.history(jobId);}
}
