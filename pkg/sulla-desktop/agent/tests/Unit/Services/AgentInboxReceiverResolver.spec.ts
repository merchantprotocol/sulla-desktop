// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe,expect,it } from 'vitest';
import { DurableAgentInboxReceiverResolver } from '../../../services/AgentInboxReceiverResolver';
import type { AgentJob } from '../../../tools/agents/jobRegistry';

const parked=(agentId:string,threadId:string,parent=false):AgentJob=>({jobId:`job-${agentId}`,status:'parked',createdAt:2,finishedAt:null,taskCount:parent?0:1,results:[],tasks:parent?[]:[{agentId,label:'worker',prompt:'',status:'parked',threadId}],parentAgentId:parent?agentId:'manager',parentChannel:'sulla-desktop',parentThreadId:parent?threadId:'parent',visibility:'hidden'});

describe('DurableAgentInboxReceiverResolver',()=>{
  it.each(['sulla-desktop','mobile-relay','heartbeat','researcher'])('keeps %s on its own agent identity',async channel=>{ // risk: cross-agent routing
    const resolver=new DurableAgentInboxReceiverResolver({allJobs:async()=>[]},()=>undefined);expect(await resolver.resolve(channel)).toEqual({channel,agentId:channel});
  });
  it('selects the intended active thread instead of the first thread on another channel',async()=>{ // risk: cross-thread delivery
    const resolver=new DurableAgentInboxReceiverResolver({allJobs:async()=>[]},channel=>channel==='mobile-relay'?'mobile-thread':undefined);expect(await resolver.resolve('mobile-relay')).toEqual({channel:'mobile-relay',agentId:'mobile-relay',threadId:'mobile-thread'});
  });
  it('resolves a custom named parked worker',async()=>{ // risk: parked worker direction
    const resolver=new DurableAgentInboxReceiverResolver({allJobs:async()=>[parked('researcher','research-thread')]},()=>undefined);expect((await resolver.resolve('researcher')).threadId).toBe('research-thread');
  });
  it('resolves a parked manager parent thread',async()=>{ // risk: manager fleet control
    const resolver=new DurableAgentInboxReceiverResolver({allJobs:async()=>[parked('coding-manager-sol','manager-thread',true)]},()=>undefined);expect((await resolver.resolve('coding-manager-sol')).threadId).toBe('manager-thread');
  });
  it('returns every live candidate so custody cannot silently choose an ambiguous channel',async()=>{ // risk: custody theft by arbitrary destination selection
    const resolver=new DurableAgentInboxReceiverResolver({allJobs:async()=>[parked('researcher','parked-thread')]},()=>['live-thread']);
    expect((await resolver.resolveAll('researcher')).map(item=>item.threadId)).toEqual(['live-thread','parked-thread']);
  });
});
