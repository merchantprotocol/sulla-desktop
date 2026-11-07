// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { AgentJobMessagingRepository } from '../Repositories/AgentJobMessagingRepository';
import type { LeadReplacementOperation } from '../Repositories/LeadHandoffRepository';
import type { VerifiedCustodyActor } from './CustodyCallerVerifier';
import type { CustodyOwner,JobCustodyPort } from './JobCustodyTypes';
import type { LeadHandoffPacketAssembler } from './LeadHandoffPacketAssembler';
import type { LeadTaskExecutionPort } from './LeadTaskExecutionPort';
import type { ReplacementTargetValidationPort } from './ReplacementTargetValidator';

export interface ReplaceLeadInput {jobId:string;taskIndex:number;agentId:string;model?:string;provider?:string;note?:string;actor:VerifiedCustodyActor}
export interface LeadWrapUpPort { request(jobId:string,taskIndex:number,actor:VerifiedCustodyActor,reason:string):Promise<void> }
export class ReplaceLeadService {
 constructor(private readonly custody:JobCustodyPort,private readonly packets:LeadHandoffPacketAssembler,private readonly launcher:LeadTaskExecutionPort,private readonly messaging:AgentJobMessagingRepository,private readonly wrapUp:LeadWrapUpPort,private readonly targets:ReplacementTargetValidationPort){}
 async replace(input:ReplaceLeadInput):Promise<any>{
   input.actor.assertVerified();
   try{await this.targets.validate(input.agentId,input.model,input.provider);}catch(error){return {ok:false,message:(error as Error).message};}
   const packet=await this.packets.assemble(input.jobId,input.taskIndex,input.note);
   if(!packet)return {ok:false,message:`Job "${input.jobId}" task ${input.taskIndex} not found.`};
   const locked=await this.custody.withOwner(input.jobId,input.taskIndex,input.actor,async(client,pinned)=>{
     const refusal=await this.custody.authorizeReplacement(pinned,input.actor);if(refusal)return {refusal};
     return {operation:await this.packets.operation(client,input.jobId,input.taskIndex,input.agentId),owner:pinned};
   });
   if(!locked)return {ok:false,message:`Job "${input.jobId}" task ${input.taskIndex} not found.`};
   if('refusal' in locked)return locked.refusal;
   let operation:LeadReplacementOperation=locked.operation;const owner=locked.owner;
   if(operation.phase==='intent'){
     try{
       const launchOwner:CustodyOwner={channel:owner.channel,threadId:owner.threadId,agentId:owner.agentId};
       const launched=await this.launcher.launchReplacement({oldJobId:input.jobId,oldTaskIndex:input.taskIndex,agentId:input.agentId,model:input.model,provider:input.provider,prompt:packet.prompt,owner:launchOwner,launchKey:operation.launchKey});
       operation=await this.packets.saveLaunched(operation,launched);
     }catch(error){return {ok:false,message:`Replacement launch failed: ${(error as Error).message}`};}
   }
   operation=await this.packets.loadOperation(input.jobId,input.taskIndex)??operation;
   const launched={jobId:operation.replacementJobId!,taskIndex:operation.replacementTaskIndex!,threadId:operation.replacementThreadId!};
   const replacementOwner:CustodyOwner={channel:owner.channel,threadId:launched.threadId,agentId:input.agentId};
   const oldLeadThread=packet.snapshot.lead.tasks[input.taskIndex]?.threadId??owner.threadId;
   const moved:any[]=[];const failed:any[]=[];
   if(operation.phase==='launched'){
     while(true){
       const children=await this.custody.withOwner(input.jobId,input.taskIndex,input.actor,async(client)=>{
         operation=await this.packets.lockOperation(client,operation!);
         const current=await this.packets.listDirectChildren(oldLeadThread,client);
         if(current.length===0)await this.packets.markChildrenMoved(client,operation!);
         return current;
       });
       if(!children?.length)break;
       failed.length=0;
       for(const {job:child,taskIndex} of children){
         const result=await this.custody.move({jobId:child.jobId,taskIndex,to:replacementOwner,actor:input.actor,reason:`re-parented by replace_lead from ${input.jobId}:${input.taskIndex}`});
         const target={jobId:child.jobId,taskIndex};
         if(result.ok||result.code==='no-op'){operation.childProgress[`${child.jobId}:${taskIndex}`]={moved:true};if(!moved.some(item=>item.jobId===child.jobId&&item.taskIndex===taskIndex))moved.push(target);}
         else failed.push({...target,error:result.message});
       }
       if(failed.length)break;
     }
   }
   const actor=input.actor.agentId;const audit=`replaced by ${launched.jobId} by ${actor}${input.note?.trim()?`: ${input.note.trim()}`:''}`;
   if(!failed.length&&operation.phase==='children_moved'){
     // stopAgentJob(mode=wrap_up) is idempotent: terminal/non-running tasks return a
     // successful no-op. Therefore a retry may safely repeat this request if the
     // process exits before the durable wrapped phase is recorded.
     await this.wrapUp.request(input.jobId,input.taskIndex,input.actor,audit);
     await this.packets.finishWrapUp(operation);
   }
   if(!failed.length&&operation.phase==='wrapped'){
     const claimed=await this.custody.withOwner(input.jobId,input.taskIndex,input.actor,client=>this.packets.claimAudit(client,operation!,audit));
     if(claimed){const target=(await this.messaging.targetsForJob(input.jobId,input.taskIndex))[0];if(target)await this.messaging.queueMessage(target,`[Lead replacement] ${audit}`);}
   }
   return {ok:failed.length===0,replacement:launched,moved,failed,prompt:packet.prompt,message:failed.length?`Replacement launched; ${moved.length} children moved and ${failed.length} failed.`:`Replacement launched and ${moved.length} child tasks moved.`};
 }
}
