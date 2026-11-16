// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe,expect,it,vi } from 'vitest';
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
  it('uses main’s bounded active-job reader when present',async()=>{ // risk: parked receiver discovery regresses to an unbounded history scan
    let allReads=0;let activeReads=0;
    const resolver=new DurableAgentInboxReceiverResolver({allJobs:async()=>{allReads++;return[];},activeJobs:async()=>{activeReads++;return[parked('bounded-agent','bounded-thread')];}},()=>undefined);
    expect((await resolver.resolve('bounded-agent')).threadId).toBe('bounded-thread');
    expect(activeReads).toBe(1);expect(allReads).toBe(0);
  });
  it('resolves all parked custody owners in one batch instead of querying once per job',async()=>{ // risk: inbox resolution adds a per-job database query on every channel lookup
    const first={...parked('first','first-thread'),tasks:[]};const second={...parked('second','second-thread'),jobId:'job-second',tasks:[]};
    const resolveOwners=vi.fn(async(jobIds:string[])=>new Map(jobIds.map(jobId=>[jobId,{jobId,channel:jobId==='job-first'?'first':'second',agentId:jobId==='job-first'?'first':'second',threadId:`${jobId}-owner`,version:1,changedAt:new Date()}])));
    const resolver=new DurableAgentInboxReceiverResolver({allJobs:async()=>[first,second]},()=>undefined,{resolveOwner:async()=>undefined,resolveOwners});
    const matches=await resolver.resolveAll('first');
    expect(resolveOwners).toHaveBeenCalledTimes(1);expect(resolveOwners).toHaveBeenCalledWith(['job-first','job-second']);
    expect(matches.map(match=>match.threadId)).toEqual(['job-first-owner']);
  });
});
