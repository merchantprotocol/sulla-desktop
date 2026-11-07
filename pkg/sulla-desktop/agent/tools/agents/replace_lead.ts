// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { DesktopPostgresConnection } from '../../app/Database/DesktopPostgresConnection';
import { LeadHandoffRepository } from '../../app/Repositories/LeadHandoffRepository';
import { LeadHandoffPacketAssembler } from '../../app/Services/LeadHandoffPacketAssembler';
import { ReplaceLeadService,type LeadWrapUpPort } from '../../app/Services/ReplaceLeadService';
import { SpawnLeadLauncher } from '../../app/Services/SpawnLeadLauncher';
import { ReplacementTargetValidator } from '../../app/Services/ReplacementTargetValidator';
import { StopPrincipal } from '../../app/ValueObjects/StopPrincipal';
import { agentJobProvider } from '../../app/Providers/AgentJobServiceProvider';
import { postgresClient } from '../../database/PostgresClient';
import { BaseTool,type ToolResponse } from '../base';
import type { VerifiedCustodyActor } from '../../app/Services/CustodyCallerVerifier';

class StopPathLeadWrapUp implements LeadWrapUpPort {
 async request(jobId:string,taskIndex:number,actor:VerifiedCustodyActor,reason:string):Promise<void>{
   const principal=StopPrincipal.agent(actor.agentId,actor.threadId);
   const message=`[Stop requested by ${actor.agentId}] Finish your current step and return your contract now with what you have`;
   // JobWrapUpService owns the idempotency boundary: it checks its per-task
   // request before queueing the message. Calling stopAgentJob here queued the
   // message first, so a retry after a durable-phase crash produced duplicates.
   await agentJobProvider.wrapUp.request(jobId,[taskIndex],principal,reason,120,message);
 }
}
export class ReplaceLeadWorker extends BaseTool {
 name=''; description='';
 constructor(private readonly service=new ReplaceLeadService(agentJobProvider.custody,new LeadHandoffPacketAssembler(new LeadHandoffRepository(new DesktopPostgresConnection(postgresClient),agentJobProvider.jobs,agentJobProvider.messaging)),new SpawnLeadLauncher(agentJobProvider.jobs),agentJobProvider.messaging,new StopPathLeadWrapUp(),new ReplacementTargetValidator())){super();}
 protected async _validatedCall(input:any):Promise<ToolResponse>{
   const actor=await agentJobProvider.custodyCallerVerifier.verify(this.state?.metadata);
   const result=await this.service.replace({jobId:input.jobId,taskIndex:Number(input.taskIndex),agentId:input.agentId,model:input.model,provider:input.provider,note:input.note,actor});
   return {successBoolean:result.ok===true,responseString:result.message??JSON.stringify(result),result};
 }
}
