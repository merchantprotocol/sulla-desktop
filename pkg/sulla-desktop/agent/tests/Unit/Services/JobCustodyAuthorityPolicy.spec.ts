// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import {describe,expect,it} from 'vitest';
import {JobCustodyAuthorityPolicy,type CustodyLineagePort,type CustodyOwnerLiveness,type CustodyOwnerLivenessPort} from '../../../app/Services/JobCustodyAuthorityPolicy';
import type {CustodyActor,CustodyOwner,CustodyRecord} from '../../../app/Services/JobCustodyTypes';

class FakeLiveness implements CustodyOwnerLivenessPort { constructor(private readonly states:Record<string,CustodyOwnerLiveness>){} async status(owner:CustodyOwner){return this.states[owner.threadId]??'unknown';} }
class FakeLineage implements CustodyLineagePort { constructor(private readonly ancestors:string[]=[],private readonly cycle=false){} async isAncestor(a:string,d:string){return this.ancestors.includes(`${a}>${d}`);} async wouldCreateCycle(){return this.cycle;} }
const current:CustodyRecord={jobId:'job',channel:'owner-channel',threadId:'owner-thread',agentId:'owner-agent',version:1,changedAt:new Date(0)};
const destination:CustodyOwner={channel:'new-channel',threadId:'new-thread',agentId:'new-agent'};
const actor=(threadId:string,agentId=threadId):CustodyActor=>({kind:'agent',channel:`${threadId}-channel`,threadId,agentId});
const policy=(states:Record<string,CustodyOwnerLiveness>,lineage=new FakeLineage())=>new JobCustodyAuthorityPolicy(new FakeLiveness(states),lineage);
const input=(who:CustodyActor,to=destination)=>({jobId:'job',current,destination:to,actor:who});

describe('JobCustodyAuthorityPolicy',()=>{
 it('allows the current owner',async()=>expect(await policy({'new-thread':'alive'}).authorize(input({kind:'agent',channel:'owner-channel',threadId:'owner-thread',agentId:'owner-agent'}))).toBeUndefined()); // risk: authority
 it('allows an ancestor',async()=>expect(await policy({'new-thread':'alive'},new FakeLineage(['parent>owner-thread'])).authorize(input(actor('parent')))).toBeUndefined()); // risk: authority
 it('allows the human',async()=>expect(await policy({'new-thread':'alive'}).authorize(input({kind:'human'}))).toBeUndefined()); // risk: human recovery
 it('refuses a peer while owner is alive and names the owner',async()=>{const result=await policy({'new-thread':'alive','owner-thread':'alive'}).authorize(input(actor('peer')));expect(result).toMatchObject({ok:false,code:'forbidden',current:{agentId:'owner-agent',channel:'owner-channel',threadId:'owner-thread'}});expect((result as any)?.message).toContain('owner-agent');}); // risk: unauthorized handoff
 for(const state of ['terminal','lost','stranded'] as const) it(`allows a peer when owner is ${state}`,async()=>expect(await policy({'new-thread':'alive','owner-thread':state}).authorize(input(actor('peer')))).toBeUndefined()); // risk: recovery
 it('treats parked as alive and unknown as alive',async()=>{for(const state of ['parked','unknown'] as const)expect((await policy({'new-thread':'alive','owner-thread':state}).authorize(input(actor('peer'))))?.ok).toBe(false);}); // risk: stealing parked work
 it('refuses a cycle',async()=>expect(await policy({'new-thread':'alive'},new FakeLineage([],true)).authorize(input({kind:'human'}))).toMatchObject({ok:false,code:'cycle'})); // risk: cyclic ownership
 for(const state of ['missing','terminal'] as const) it(`refuses a ${state} destination`,async()=>expect(await policy({'new-thread':state}).authorize(input({kind:'human'}))).toMatchObject({ok:false,code:'invalid-destination'})); // risk: orphaning
 it('refuses a no-op',async()=>expect(await policy({}).authorize(input({kind:'human'},{channel:current.channel,threadId:current.threadId,agentId:current.agentId}))).toMatchObject({ok:false,code:'no-op'})); // risk: duplicate audit
});
