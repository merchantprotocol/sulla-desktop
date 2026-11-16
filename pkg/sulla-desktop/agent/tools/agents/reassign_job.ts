// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { BaseTool,type ToolResponse } from '../base';
import { agentJobProvider } from '../../app/Providers/AgentJobServiceProvider';

export class ReassignJobWorker extends BaseTool {
  name=''; description='';
  protected async _validatedCall(input:any):Promise<ToolResponse>{
    const taskIndex=input.taskIndex===undefined?undefined:Number(input.taskIndex);
    if(taskIndex!==undefined&&(!Number.isInteger(taskIndex)||taskIndex<0))return {successBoolean:false,responseString:'taskIndex must be a non-negative integer.'};
    const actor=await agentJobProvider.custodyCallerVerifier.verify((this.state as any)?.metadata);
    const destination=await agentJobProvider.custodyDestinations.resolve(String(input.to??''),actor);
    if(!destination.ok)return {successBoolean:false,responseString:destination.message};
    const result=await agentJobProvider.custody.move({jobId:String(input.jobId),...(taskIndex===undefined?{}:{taskIndex}),to:destination.owner,actor,reason:String(input.reason).trim()});
    return result.ok?{successBoolean:true,responseString:JSON.stringify({jobId:input.jobId,taskIndex,previous:result.previous,current:result.current})}:{successBoolean:false,responseString:result.message};
  }
}
