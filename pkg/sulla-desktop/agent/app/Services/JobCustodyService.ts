// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { Clock } from '@sulla/foundation';
import { AgentJobCustodyRepository } from '../Repositories/AgentJobCustodyRepository';
import { JobCustodyAuthorityPolicy } from './JobCustodyAuthorityPolicy';
import type { CustodyAuditRecord,CustodyChangeNotifier,CustodyMoveInput,CustodyMoveResult,CustodyRecord,CustodyTransactionClient,JobCustodyPort } from './JobCustodyTypes';

export class JobCustodyService implements JobCustodyPort {
  constructor(private readonly repository:AgentJobCustodyRepository,private readonly policy:JobCustodyAuthorityPolicy,private readonly notifier:CustodyChangeNotifier,private readonly clock:Clock){}
  async move(input:CustodyMoveInput):Promise<CustodyMoveResult>{
    const changedAt=this.clock.now();
    const snapshot=await this.repository.resolveOwner(input.jobId,input.taskIndex);
    if(!snapshot)return {ok:false,code:'not-found',message:`Job ${input.jobId} was not found.`};
    const refusal=await this.policy.authorize({jobId:input.jobId,taskIndex:input.taskIndex,current:snapshot,destination:input.to,actor:input.actor});
    if(refusal)return refusal;
    const result=await this.repository.move(input,snapshot,changedAt);
    if(result.ok){void this.notifier.changed({jobId:input.jobId,...(input.taskIndex===undefined?{}:{taskIndex:input.taskIndex}),from:result.previous,to:result.current,actor:input.actor,reason:input.reason,version:result.current.version,changedAt}).catch(error=>console.warn('[JobCustodyService] post-commit notification dispatch failed:',(error as Error).message));}
    return result;
  }
  resolveOwner(jobId:string,taskIndex?:number):Promise<CustodyRecord|undefined>{return this.repository.resolveOwner(jobId,taskIndex);}
  withOwner<T>(jobId:string,taskIndex:number|undefined,operation:(client:CustodyTransactionClient,owner:CustodyRecord)=>Promise<T>):Promise<T|undefined>{return this.repository.withCustodyLock(jobId,taskIndex,operation);}
  history(jobId:string):Promise<CustodyAuditRecord[]>{return this.repository.history(jobId);}
}
