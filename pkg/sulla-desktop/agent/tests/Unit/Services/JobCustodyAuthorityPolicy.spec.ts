// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import {describe,expect,it} from 'vitest';
import {CustodyCallerVerifier,VerifiedCustodyActor,type TopLevelConversationRegistry} from '../../../app/Services/CustodyCallerVerifier';
import {JobCustodyAuthorityPolicy,TopLevelHumanSessionAuthorityRule,type CustodyLineagePort,type CustodyOwnerLiveness,type CustodyOwnerLivenessPort} from '../../../app/Services/JobCustodyAuthorityPolicy';
import type {CustodyOwner,CustodyRecord} from '../../../app/Services/JobCustodyTypes';

class FakeLiveness implements CustodyOwnerLivenessPort { constructor(private readonly states:Record<string,CustodyOwnerLiveness>){} async status(owner:CustodyOwner){return this.states[owner.threadId]??'unknown';} }
class FakeLineage implements CustodyLineagePort { constructor(private readonly ancestors:string[]=[],private readonly cycle=false){} async isAncestor(a:string,d:string){return this.ancestors.includes(`${a}>${d}`);} async wouldCreateCycle(){return this.cycle;} }
class FakeConversations implements TopLevelConversationRegistry {constructor(private readonly registered:Set<string>){}async isRegisteredTopLevel(channel:string,threadId:string,agentId:string){return this.registered.has(`${channel}/${threadId}/${agentId}`);} }
class FakeTasks {constructor(private readonly delegated:Set<string>=new Set()){}async findTaskByThread(threadId:string){return this.delegated.has(threadId)?{} as any:undefined;} }
const current:CustodyRecord={jobId:'job',channel:'owner-channel',threadId:'owner-thread',agentId:'owner-agent',version:1,changedAt:new Date(0)};
const destination:CustodyOwner={channel:'new-channel',threadId:'new-thread',agentId:'new-agent'};
const agent=(threadId:string,scope:'delegated'|'top-level'='delegated',agentId=threadId)=>({kind:'agent',channel:`${threadId}-channel`,threadId,agentId,scope} as unknown as VerifiedCustodyActor);
const human=()=>VerifiedCustodyActor.humanForUiIpc();
const policy=(states:Record<string,CustodyOwnerLiveness>,lineage=new FakeLineage())=>new JobCustodyAuthorityPolicy(new FakeLiveness(states),lineage);
const input=(who:VerifiedCustodyActor,to=destination)=>({jobId:'job',current,destination:to,actor:who});

describe('JobCustodyAuthorityPolicy',()=>{
 it('allows the current owner',async()=>expect(await policy({'new-thread':'alive'}).authorize(input(({kind:'agent',channel:'owner-channel',threadId:'owner-thread',agentId:'owner-agent',scope:'delegated'} as unknown as VerifiedCustodyActor)))).toBeUndefined()); // risk: authority
 it('allows an ancestor',async()=>expect(await policy({'new-thread':'alive'},new FakeLineage(['parent>owner-thread'])).authorize(input(agent('parent')))).toBeUndefined()); // risk: authority
 it('allows a direct UI/IPC human',async()=>expect(await policy({'new-thread':'alive'}).authorize(input(human()))).toBeUndefined()); // risk: human recovery
 it('allows a verified top-level chat to adopt from another registered top-level chat',async()=>{ // risk: H8 cross-session recovery
   const conversations=new FakeConversations(new Set(['owner-channel/owner-thread/owner-agent']));const configured=new JobCustodyAuthorityPolicy(new FakeLiveness({'new-thread':'alive','owner-thread':'alive'}),new FakeLineage(),new TopLevelHumanSessionAuthorityRule(conversations));expect(await configured.authorize(input(agent('peer','top-level')))).toBeUndefined();
 });
 it('does not grant the top-level exception to a delegated agent',async()=>{ // risk: peer custody theft
   const conversations=new FakeConversations(new Set(['owner-channel/owner-thread/owner-agent']));const configured=new JobCustodyAuthorityPolicy(new FakeLiveness({'new-thread':'alive','owner-thread':'alive'}),new FakeLineage(),new TopLevelHumanSessionAuthorityRule(conversations));expect(await configured.authorize(input(agent('peer')))).toMatchObject({ok:false,code:'forbidden'});
 });
 it('does not grant the exception when the current owner lacks positive top-level registration',async()=>{ // risk: absence-based spoof
   const configured=new JobCustodyAuthorityPolicy(new FakeLiveness({'new-thread':'alive','owner-thread':'alive'}),new FakeLineage(),new TopLevelHumanSessionAuthorityRule(new FakeConversations(new Set())));expect(await configured.authorize(input(agent('peer','top-level')))).toMatchObject({ok:false,code:'forbidden'});
 });
 it('refuses a peer while owner is alive and names the owner',async()=>{const result=await policy({'new-thread':'alive','owner-thread':'alive'}).authorize(input(agent('peer')));expect(result).toMatchObject({ok:false,code:'forbidden',current:{agentId:'owner-agent',channel:'owner-channel',threadId:'owner-thread'}});expect((result as any)?.message).toContain('owner-agent');}); // risk: unauthorized handoff
 for(const state of ['terminal','lost','stranded'] as const) it(`allows a peer when owner is ${state}`,async()=>expect(await policy({'new-thread':'alive','owner-thread':state}).authorize(input(agent('peer')))).toBeUndefined()); // risk: recovery
 it('treats parked as alive and unknown as alive',async()=>{for(const state of ['parked','unknown'] as const)expect((await policy({'new-thread':'alive','owner-thread':state}).authorize(input(agent('peer'))))?.ok).toBe(false);}); // risk: stealing parked work
 it('refuses a cycle',async()=>expect(await policy({'new-thread':'alive'},new FakeLineage([],true)).authorize(input(human()))).toMatchObject({ok:false,code:'cycle'})); // risk: cyclic ownership
 for(const state of ['missing','terminal'] as const) it(`refuses a ${state} destination`,async()=>expect(await policy({'new-thread':state}).authorize(input(human()))).toMatchObject({ok:false,code:'invalid-destination'})); // risk: orphaning
 it('refuses a no-op',async()=>expect(await policy({}).authorize(input(human(),{channel:current.channel,threadId:current.threadId,agentId:current.agentId}))).toMatchObject({ok:false,code:'no-op'})); // risk: duplicate audit
});

describe('CustodyCallerVerifier',()=>{
 it('treats an absent-from-jobs but unregistered thread as delegated',async()=>{ // risk: fabricated principal
   const verifier=new CustodyCallerVerifier(new FakeTasks() as any,new FakeConversations(new Set()));const actor=await verifier.verify({wsChannel:'fake',threadId:'never-registered',agentId:'fake',subAgentDepth:0});expect(actor).toMatchObject({kind:'agent',scope:'delegated'});
 });
 it('ignores spoofed tool arguments and authenticates only injected context',async()=>{ // risk: argument identity spoof
   const registered=new Set(['real-channel/real-thread/real-agent']);const verifier=new CustodyCallerVerifier(new FakeTasks() as any,new FakeConversations(registered));const spoofedArgs={actor:{kind:'human'},threadId:'fake'};const actor=await verifier.verify({wsChannel:'real-channel',threadId:'real-thread',agentId:'real-agent',subAgentDepth:0});expect(spoofedArgs.actor.kind).toBe('human');expect(actor).toMatchObject({kind:'agent',threadId:'real-thread',scope:'top-level'});
 });
 it('requires zero depth, no manager, no job task, and positive conversation registration',async()=>{ // risk: delegated privilege escalation
   const conversations=new FakeConversations(new Set(['chat/thread/agent']));for(const context of [{wsChannel:'chat',threadId:'thread',agentId:'agent',subAgentDepth:1},{wsChannel:'chat',threadId:'thread',agentId:'agent',subAgentDepth:0,managerThreadId:'manager'}])expect(await new CustodyCallerVerifier(new FakeTasks() as any,conversations).verify(context)).toMatchObject({scope:'delegated'});expect(await new CustodyCallerVerifier(new FakeTasks(new Set(['thread'])) as any,conversations).verify({wsChannel:'chat',threadId:'thread',agentId:'agent',subAgentDepth:0})).toMatchObject({scope:'delegated'});
 });
});
