// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { AgentJobMessagingRepository } from '../Repositories/AgentJobMessagingRepository';
import type { CustodyActor,CustodyOwner,JobCustodyPort } from './JobCustodyTypes';
import type { LeadHandoffPacketAssembler } from './LeadHandoffPacketAssembler';
import type { LeadTaskExecutionPort } from './LeadTaskExecutionPort';

export interface ReplaceLeadInput {jobId:string;taskIndex:number;agentId:string;model?:string;provider?:string;note?:string;actor:CustodyActor}
export interface LeadWrapUpPort { request(jobId:string,taskIndex:number,actor:CustodyActor,reason:string):Promise<void> }
export class ReplaceLeadService {
 constructor(private readonly custody:JobCustodyPort,private readonly packets:LeadHandoffPacketAssembler,private readonly launcher:LeadTaskExecutionPort,private readonly messaging:AgentJobMessagingRepository,private readonly wrapUp:LeadWrapUpPort){}
 async replace(input:ReplaceLeadInput):Promise<any>{
   const packet=await this.packets.assemble(input.jobId,input.taskIndex,input.note); if(!packet)return {ok:false,message:`Job "${input.jobId}" task ${input.taskIndex} not found.`};
   let operation:any; let owner:any;
   try{const locked=await this.custody.withOwner(input.jobId,input.taskIndex,async(client,pinned)=>{
     const refusal=await this.custody.authorizeReplacement(pinned,input.actor); if(refusal)return {refusal};
     const current=await this.packets.operation(client,input.jobId,input.taskIndex);
     if(!current.replacementJobId){
       const launchOwner:CustodyOwner={channel:pinned.channel,threadId:pinned.threadId,agentId:pinned.agentId};
       const launched=await this.launcher.launchReplacement({oldJobId:input.jobId,oldTaskIndex:input.taskIndex,agentId:input.agentId,model:input.model,provider:input.provider,prompt:packet.prompt,owner:launchOwner});
       Object.assign(current,{replacementJobId:launched.jobId,replacementTaskIndex:launched.taskIndex,replacementThreadId:launched.threadId}); await this.packets.saveOperation(client,current);
     }
     return {operation:current,owner:pinned};
   }); if(!locked)return {ok:false,message:`Job "${input.jobId}" task ${input.taskIndex} not found.`}; if('refusal' in locked)return locked.refusal; ({operation,owner}=locked);}catch(error){return {ok:false,message:`Replacement launch failed: ${(error as Error).message}`};}
   const launched={jobId:operation.replacementJobId,taskIndex:operation.replacementTaskIndex,threadId:operation.replacementThreadId};
   const replacementOwner:CustodyOwner={channel:owner.channel,threadId:launched.threadId,agentId:input.agentId};
   const moved:any[]=[]; const failed:any[]=[];
   for(const {job:child,taskIndex} of packet.snapshot.children){const key=`${child.jobId}:${taskIndex}`; if(operation.childProgress[key]?.moved){moved.push({jobId:child.jobId,taskIndex});continue;}
     const result=await this.custody.move({jobId:child.jobId,taskIndex,to:replacementOwner,actor:input.actor,reason:`re-parented by replace_lead from ${input.jobId}:${input.taskIndex}`});
     const success=result.ok||result.code==='no-op'; operation.childProgress[key]=success?{moved:true}:{moved:false,error:result.message}; (success?moved:failed).push({jobId:child.jobId,taskIndex,...(!success?{error:result.message}:{})});
   }
   await this.custody.withOwner(input.jobId,input.taskIndex,client=>this.packets.saveOperation(client,operation));
   const actor=input.actor.kind==='human'?'human':input.actor.agentId; const audit=`replaced by ${launched.jobId} by ${actor}${input.note?.trim()?`: ${input.note.trim()}`:''}`;
   if(failed.length===0&&!operation.auditDone){await this.packets.recordReplacementAudit(input.jobId,input.taskIndex,audit); const target=(await this.messaging.targetsForJob(input.jobId,input.taskIndex))[0]; if(target)await this.messaging.queueMessage(target,`[Lead replacement] ${audit}`); operation.auditDone=true;}
   if(failed.length===0&&!operation.wrapUpDone){await this.wrapUp.request(input.jobId,input.taskIndex,input.actor,audit); operation.wrapUpDone=true;}
   if(failed.length===0)await this.custody.withOwner(input.jobId,input.taskIndex,client=>this.packets.saveOperation(client,operation));
   return {ok:failed.length===0,replacement:launched,moved,failed,prompt:packet.prompt,message:failed.length?`Replacement launched; ${moved.length} children moved and ${failed.length} failed.`:`Replacement launched and ${moved.length} child tasks moved.`};
 }
}
