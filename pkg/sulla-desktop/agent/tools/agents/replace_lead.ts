// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { DesktopPostgresConnection } from '../../app/Database/DesktopPostgresConnection';
import { LeadHandoffRepository } from '../../app/Repositories/LeadHandoffRepository';
import { LeadHandoffPacketAssembler } from '../../app/Services/LeadHandoffPacketAssembler';
import { ReplaceLeadService,type LeadWrapUpPort } from '../../app/Services/ReplaceLeadService';
import { SpawnLeadLauncher } from '../../app/Services/SpawnLeadLauncher';
import { StopPrincipal } from '../../app/ValueObjects/StopPrincipal';
import { agentJobProvider } from '../../app/Providers/AgentJobServiceProvider';
import { postgresClient } from '../../database/PostgresClient';
import { resolveAgentIdentity } from '../../utils/agentIdentity';
import { BaseTool,type ToolResponse } from '../base';
import { stopAgentJob } from './stop_agent_job';
import type { CustodyActor } from '../../app/Services/JobCustodyTypes';

class StopPathLeadWrapUp implements LeadWrapUpPort {
 async request(jobId:string,taskIndex:number,actor:CustodyActor,reason:string):Promise<void>{
   const principal=actor.kind==='human'?StopPrincipal.human():StopPrincipal.agent(actor.agentId,actor.threadId);
   const result=await stopAgentJob(jobId,principal,reason,{taskIndex,mode:'wrap_up'});
   if(!result.successBoolean&&!/not running|already completed/i.test(result.responseString)) throw new Error(result.responseString);
 }
}
export class ReplaceLeadWorker extends BaseTool {
 name=''; description='';
 constructor(private readonly service=new ReplaceLeadService(agentJobProvider.custody,new LeadHandoffPacketAssembler(new LeadHandoffRepository(new DesktopPostgresConnection(postgresClient),agentJobProvider.jobs,agentJobProvider.messaging)),new SpawnLeadLauncher(agentJobProvider.jobs),agentJobProvider.messaging,new StopPathLeadWrapUp())){super();}
 protected async _validatedCall(input:any):Promise<ToolResponse>{
   const metadata=this.state?.metadata; const agentId=resolveAgentIdentity(metadata)||metadata?.routedAgentId; const threadId=metadata?.threadId;
   if(!agentId||!threadId)return {successBoolean:false,responseString:'Cannot replace lead: cannot verify caller.'};
   const result=await this.service.replace({jobId:input.jobId,taskIndex:Number(input.taskIndex),agentId:input.agentId,model:input.model,provider:input.provider,note:input.note,actor:{kind:'agent',channel:metadata?.wsChannel||'sulla-desktop',threadId,agentId}});
   return {successBoolean:result.ok===true,responseString:result.message??JSON.stringify(result),result};
 }
}
