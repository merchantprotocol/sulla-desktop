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
   const owner=await this.custody.resolveOwner(input.jobId,input.taskIndex); if(!owner)return {ok:false,message:`Job "${input.jobId}" task ${input.taskIndex} not found.`};
   const launchOwner:CustodyOwner={channel:owner.channel,threadId:owner.threadId,agentId:owner.agentId};
   const packet=await this.packets.assemble(input.jobId,input.taskIndex,input.note); if(!packet)return {ok:false,message:`Job "${input.jobId}" task ${input.taskIndex} not found.`};
   const authority=await this.custody.move({jobId:input.jobId,taskIndex:input.taskIndex,to:owner,actor:input.actor,reason:'replace_lead authority check'});
   if(!authority.ok&&authority.code!=='no-op')return authority;
   let launched;
   try{launched=await this.launcher.launchReplacement({oldJobId:input.jobId,oldTaskIndex:input.taskIndex,agentId:input.agentId,model:input.model,provider:input.provider,prompt:packet.prompt,owner:launchOwner});}catch(error){return {ok:false,message:`Replacement launch failed: ${(error as Error).message}`};}
   const replacementOwner:CustodyOwner={channel:owner.channel,threadId:launched.threadId,agentId:input.agentId};
   const moved:any[]=[]; const failed:any[]=[];
   for(const child of packet.snapshot.children){for(let taskIndex=0;taskIndex<child.tasks.length;taskIndex++){
     const result=await this.custody.move({jobId:child.jobId,taskIndex,to:replacementOwner,actor:input.actor,reason:`re-parented by replace_lead from ${input.jobId}:${input.taskIndex}`});
     (result.ok||result.code==='no-op'?moved:failed).push({jobId:child.jobId,taskIndex,...(!result.ok?{error:result.message}:{})});
   }}
   const actor=input.actor.kind==='human'?'human':input.actor.agentId; const audit=`replaced by ${launched.jobId} by ${actor}${input.note?.trim()?`: ${input.note.trim()}`:''}`;
   const target=(await this.messaging.targetsForJob(input.jobId,input.taskIndex))[0]; if(target)await this.messaging.queueMessage(target,`[Lead replacement] ${audit}`);
   await this.wrapUp.request(input.jobId,input.taskIndex,input.actor,audit);
   return {ok:failed.length===0,replacement:launched,moved,failed,prompt:packet.prompt,message:failed.length?`Replacement launched; ${moved.length} children moved and ${failed.length} failed.`:`Replacement launched and ${moved.length} child tasks moved.`};
 }
}
