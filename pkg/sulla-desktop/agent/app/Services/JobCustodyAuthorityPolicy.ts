// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { CustodyActor, CustodyMoveResult, CustodyOwner, CustodyRecord } from './JobCustodyTypes';

export type CustodyOwnerLiveness = 'alive'|'parked'|'terminal'|'lost'|'stranded'|'missing'|'unknown';
export interface CustodyOwnerLivenessPort { status(owner: CustodyOwner): Promise<CustodyOwnerLiveness> }
export interface CustodyLineagePort {
  isAncestor(ancestorThreadId:string, descendantThreadId:string):Promise<boolean>;
  wouldCreateCycle(jobId:string, taskIndex:number|undefined, destinationThreadId:string):Promise<boolean>;
}
export interface CustodyAuthorityInput { jobId:string; taskIndex?:number; current:CustodyRecord; destination:CustodyOwner; actor:CustodyActor }

export class JobCustodyAuthorityPolicy {
  constructor(private readonly liveness:CustodyOwnerLivenessPort,private readonly lineage:CustodyLineagePort) {}
  async authorizeManagement(current:CustodyRecord,actor:CustodyActor):Promise<CustodyMoveResult|undefined>{
    if(actor.kind==='human'||this.same(current,actor)) return undefined;
    if(await this.lineage.isAncestor(actor.threadId,current.threadId)) return undefined;
    const ownerStatus=await this.liveness.status(current);
    if(['terminal','lost','stranded'].includes(ownerStatus)) return undefined;
    return this.refuse('forbidden',`Custody belongs to ${current.agentId} (${current.channel}/${current.threadId}).`,current);
  }
  async authorize(input:CustodyAuthorityInput):Promise<CustodyMoveResult|undefined>{
    const current=input.current;
    if(this.same(current,input.destination)) return this.refuse('no-op','Destination already owns this job.',current);
    const destinationStatus=await this.liveness.status(input.destination);
    if(['missing','terminal','lost','stranded'].includes(destinationStatus)) return this.refuse('invalid-destination','Destination is missing or terminal.',current);
    if(await this.lineage.wouldCreateCycle(input.jobId,input.taskIndex,input.destination.threadId)) return this.refuse('cycle','Destination is the moved task or one of its descendants.',current);
    if(input.actor.kind==='human') return undefined;
    if(this.same(current,input.actor)) return undefined;
    if(await this.lineage.isAncestor(input.actor.threadId,current.threadId)) return undefined;
    const ownerStatus=await this.liveness.status(current);
    if(['terminal','lost','stranded'].includes(ownerStatus)) return undefined;
    return this.refuse('forbidden',`Custody belongs to ${current.agentId} (${current.channel}/${current.threadId}).`,current);
  }
  private same(left:CustodyOwner,right:CustodyOwner):boolean{return left.channel===right.channel&&left.threadId===right.threadId&&left.agentId===right.agentId;}
  private refuse(code:'forbidden'|'invalid-destination'|'cycle'|'no-op',message:string,current:CustodyOwner):CustodyMoveResult{return {ok:false,code,message,current};}
}
