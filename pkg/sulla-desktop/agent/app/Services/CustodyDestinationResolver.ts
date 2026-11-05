// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { JobTaskLocator } from './JobTaskLocator';
import type { AgentInboxReceiverResolver } from '../../services/AgentInboxReceiverResolver';
import type { CustodyOwner } from './JobCustodyTypes';

export type CustodyDestinationResult={ok:true;owner:CustodyOwner}|{ok:false;message:string};
export class CustodyDestinationResolver {
  constructor(private readonly locator:JobTaskLocator,private readonly receivers:AgentInboxReceiverResolver,private readonly activeThread: (channel:string)=>Promise<string|undefined>=async()=>undefined){}
  async resolve(to:string,caller?:CustodyOwner):Promise<CustodyDestinationResult>{
    const destination=to.trim();
    if(destination==='me') return caller?{ok:true,owner:caller}:{ok:false,message:'Cannot resolve "me": this call has no agent/thread identity.'};
    const located=await this.locator.findTaskByThread(destination);
    if(located){
      const task=located.job.tasks[located.taskIndex];
      if(!['queued','running','parked'].includes(task.status))return {ok:false,message:`Destination thread ${destination} is terminal.`};
      return {ok:true,owner:{channel:task.agentId,threadId:destination,agentId:task.agentId}};
    }
    const target=await this.receivers.resolve(destination);
    target.threadId??=await this.activeThread(destination);
    if(!target.threadId||!target.agentId)return {ok:false,message:`Destination "${destination}" is not a unique live agent channel or thread.`};
    return {ok:true,owner:{channel:target.channel,threadId:target.threadId,agentId:target.agentId}};
  }
}
