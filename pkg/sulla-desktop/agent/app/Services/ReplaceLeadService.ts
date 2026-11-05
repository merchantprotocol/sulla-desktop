// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { AgentJobMessagingRepository } from '../Repositories/AgentJobMessagingRepository';
import type { VerifiedCustodyActor } from './CustodyCallerVerifier';
import type { CustodyOwner,JobCustodyPort } from './JobCustodyTypes';
import type { LeadHandoffPacketAssembler } from './LeadHandoffPacketAssembler';
import type { LeadTaskExecutionPort } from './LeadTaskExecutionPort';

export interface ReplaceLeadInput {jobId:string;taskIndex:number;agentId:string;model?:string;provider?:string;note?:string;actor:VerifiedCustodyActor}
export interface LeadWrapUpPort { request(jobId:string,taskIndex:number,actor:VerifiedCustodyActor,reason:string):Promise<void> }
export class ReplaceLeadService {
 constructor(private readonly custody:JobCustodyPort,private readonly packets:LeadHandoffPacketAssembler,private readonly launcher:LeadTaskExecutionPort,private readonly messaging:AgentJobMessagingRepository,private readonly wrapUp:LeadWrapUpPort){}
 async replace(input:ReplaceLeadInput):Promise<any>{
   input.actor.assertVerified();
   const packet=await this.packets.assemble(input.jobId,input.taskIndex,input.note); if(!packet)return {ok:false,message:`Job "${input.jobId}" task ${input.taskIndex} not found.`};
   let operation:any; let owner:any;
   try{const locked=await this.custody.withOwner(input.jobId,input.taskIndex,input.actor,async(client,pinned)=>{
     const current=await this.packets.operation(client,input.jobId,input.taskIndex);
     if(!current.replacementJobId){
       const launchOwner:CustodyOwner={channel:pinned.channel,threadId:pinned.threadId,agentId:pinned.agentId};
       const launched=await this.launcher.launchReplacement({oldJobId:input.jobId,oldTaskIndex:input.taskIndex,agentId:input.agentId,model:input.model,provider:input.provider,prompt:packet.prompt,owner:launchOwner,launchKey:current.launchKey});
       Object.assign(current,{replacementJobId:launched.jobId,replacementTaskIndex:launched.taskIndex,replacementThreadId:launched.threadId}); await this.packets.saveOperation(client,current);
     }
     return {operation:current,owner:pinned};
   }); if(!locked)return {ok:false,message:`Job "${input.jobId}" task ${input.taskIndex} not found.`}; ({operation,owner}=locked);}catch(error){return {ok:false,message:`Replacement launch failed: ${(error as Error).message}`};}
   const launched={jobId:operation.replacementJobId,taskIndex:operation.replacementTaskIndex,threadId:operation.replacementThreadId};
   const replacementOwner:CustodyOwner={channel:owner.channel,threadId:launched.threadId,agentId:input.agentId};
   const oldLeadThread=packet.snapshot.lead.tasks[input.taskIndex]?.threadId??owner.threadId;
   const moved:any[]=[]; const failed:any[]=[];
   const moveChildren=async(children:any[])=>{for(const {job:child,taskIndex} of children){const key=`${child.jobId}:${taskIndex}`; if(operation.childProgress[key]?.moved){if(!moved.some(x=>x.jobId===child.jobId&&x.taskIndex===taskIndex))moved.push({jobId:child.jobId,taskIndex});continue;}
     const result=await this.custody.move({jobId:child.jobId,taskIndex,to:replacementOwner,actor:input.actor,reason:`re-parented by replace_lead from ${input.jobId}:${input.taskIndex}`});
     const success=result.ok||result.code==='no-op'; operation.childProgress[key]=success?{moved:true}:{moved:false,error:result.message}; (success?moved:failed).push({jobId:child.jobId,taskIndex,...(!success?{error:result.message}:{})});
   }};
   await moveChildren(packet.snapshot.children);
   // Re-enumerate under the old lead's custody lock. Children adopted during the first pass
   // must move before wrap-up can be claimed.
   await this.custody.withOwner(input.jobId,input.taskIndex,input.actor,async client=>{await moveChildren(await this.packets.listDirectChildren(oldLeadThread,client));await this.packets.saveOperation(client,operation);});
   const actor=input.actor.agentId; const audit=`replaced by ${launched.jobId} by ${actor}${input.note?.trim()?`: ${input.note.trim()}`:''}`;
   if(failed.length===0){
     const claimedAudit=await this.custody.withOwner(input.jobId,input.taskIndex,input.actor,client=>this.packets.claimAudit(client,operation,audit));
     if(claimedAudit){const target=(await this.messaging.targetsForJob(input.jobId,input.taskIndex))[0];if(target)await this.messaging.queueMessage(target,`[Lead replacement] ${audit}`);}
     const remaining=await this.packets.listDirectChildren(oldLeadThread);
     const outside=remaining.filter(({job,taskIndex}:any)=>!operation.childProgress[`${job.jobId}:${taskIndex}`]?.moved);
     if(outside.length){await moveChildren(outside);await this.custody.withOwner(input.jobId,input.taskIndex,input.actor,client=>this.packets.saveOperation(client,operation));}
     if(failed.length===0){const claim=await this.custody.withOwner(input.jobId,input.taskIndex,input.actor,client=>this.packets.claimWrapUp(client,operation));if(claim){await this.wrapUp.request(input.jobId,input.taskIndex,input.actor,audit);await this.custody.withOwner(input.jobId,input.taskIndex,input.actor,client=>this.packets.finishWrapUp(client,operation));}}
   }
   return {ok:failed.length===0,replacement:launched,moved,failed,prompt:packet.prompt,message:failed.length?`Replacement launched; ${moved.length} children moved and ${failed.length} failed.`:`Replacement launched and ${moved.length} child tasks moved.`};
 }
}
