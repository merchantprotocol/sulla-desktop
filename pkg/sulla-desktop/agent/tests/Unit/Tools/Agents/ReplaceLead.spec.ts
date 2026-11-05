// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import {describe,expect,it,vi} from 'vitest';
import {agentToolManifests} from '../../../../tools/agents/manifests';
import {ToolRegistry} from '../../../../tools/registry';
import {ReplaceLeadService} from '../../../../app/Services/ReplaceLeadService';

const owner={channel:'sulla-desktop',threadId:'parent-thread',agentId:'coding-manager-sol'};
const actor={kind:'agent' as const,...owner};
class ReplaceLeadHarness {
 readonly moves:any[]=[]; readonly wrapped:any[]=[];
 readonly custody={authorizeManagement:vi.fn(async()=>undefined),resolveOwner:vi.fn(async()=>({...owner,jobId:'lead',taskIndex:0,version:1,changedAt:new Date()})),history:vi.fn(),move:vi.fn(async(input:any)=>{this.moves.push(input);return input.to.threadId===owner.threadId?{ok:false,code:'no-op',message:'unchanged',current:owner}:{ok:true,previous:owner,current:{...input.to,jobId:input.jobId,taskIndex:input.taskIndex,version:2,changedAt:new Date()}}})};
 readonly snapshot:any={lead:{jobId:'lead',status:'failed',tasks:[{label:'Lead',prompt:'Ship F-5',status:'error',threadId:'old-lead'}]},taskIndex:0,checkins:[{step:'push',summary:'PR https://github.test/pull/7 head abcdef1',blockers:[]}],messages:[{message:'Fix CI'}],inbox:[{kind:'contract',payload:{summary:'worker done'}}],children:Array.from({length:3},(_,i)=>({jobId:`child-${i}`,status:'running',results:[],tasks:[{label:`Worker ${i+1}`,status:'running',threadId:`worker-${i}`}]}))};
 readonly packets={recordReplacementAudit:vi.fn(async()=>{}),assemble:vi.fn(async()=>({prompt:'# Lead replacement handoff\n## Your team: 3 workers\n- Worker 1 — running; heads: abcdef1\n- Worker 2 — running\n- Worker 3 — running',snapshot:this.snapshot}))};
 readonly launcher={launchReplacement:vi.fn(async()=>({jobId:'replacement',taskIndex:0,threadId:'new-lead'}))};
 readonly messaging={targetsForJob:vi.fn(async()=>[{jobId:'lead',taskIndex:0}]),queueMessage:vi.fn(async()=>({}))};
 readonly wrapUp={request:vi.fn(async(...args:any[])=>{this.wrapped.push(args)})};
 readonly service=new ReplaceLeadService(this.custody as any,this.packets as any,this.launcher,this.messaging as any,this.wrapUp);
}

describe('agents/replace_lead',()=>{
 it('H3 launches a replacement, preserves all child ids, re-parents them, then wraps up the dead lead',async()=>{
   // risk: custody — replacing a dead lead must not orphan or relaunch its workers.
   const h=new ReplaceLeadHarness(); const result=await h.service.replace({jobId:'lead',taskIndex:0,agentId:'coding-manager-sol',note:'resume',actor});
   expect(result.ok).toBe(true); expect(result.replacement.jobId).toBe('replacement');
   expect(h.launcher.launchReplacement).toHaveBeenCalledWith(expect.objectContaining({owner,prompt:expect.stringContaining('Your team: 3 workers')}));
   expect(h.moves.map(move=>move.jobId)).toEqual(['child-0','child-1','child-2']);
   expect(h.moves.every(move=>move.to.threadId==='new-lead')).toBe(true);
   expect(h.packets.recordReplacementAudit).toHaveBeenCalledWith('lead',0,expect.stringContaining('replaced by replacement'));
   expect(h.wrapUp.request).toHaveBeenCalledAfter(h.custody.move as any);
 });
 it('keeps state unchanged when launch fails',async()=>{
   // risk: data integrity — launch failure must occur before any child custody changes.
   const h=new ReplaceLeadHarness(); h.launcher.launchReplacement.mockRejectedValueOnce(new Error('provider offline'));
   const result=await h.service.replace({jobId:'lead',taskIndex:0,agentId:'coding-manager-sol',actor});
   expect(result.ok).toBe(false); expect(h.moves).toHaveLength(0); expect(h.wrapUp.request).not.toHaveBeenCalled();
 });
 it('reports exactly which children moved after a partial re-parent failure',async()=>{
   // risk: retry safety — operators need an exact partial-move receipt.
   const h=new ReplaceLeadHarness(); (h.custody.move as any).mockImplementation(async(input:any)=>{h.moves.push(input);if(input.jobId==='child-1')return {ok:false,code:'version-conflict',message:'retry'};return {ok:true,previous:owner,current:{...input.to,jobId:input.jobId,taskIndex:input.taskIndex,version:2,changedAt:new Date()}}});
   const result=await h.service.replace({jobId:'lead',taskIndex:0,agentId:'coding-manager-sol',actor});
   expect(result.ok).toBe(false); expect(result.moved.map((x:any)=>x.jobId)).toEqual(['child-0','child-2']); expect(result.failed).toEqual([expect.objectContaining({jobId:'child-1',error:'retry'})]);
 });
 it('calls through the registered manifest and validates required args',async()=>{
   // risk: tool exposure — acceptance behavior must be reachable through the production registry.
   const registry=new ToolRegistry(); registry.registerManifests(agentToolManifests.filter(manifest=>manifest.name==='replace_lead'));
   const tool:any=await registry.createToolForCategory('agents','replace_lead'); const h=new ReplaceLeadHarness(); tool.service=h.service; tool.setState({metadata:{wsChannel:owner.channel,threadId:owner.threadId,routedAgentId:owner.agentId}});
   await expect(tool.call({jobId:'lead',taskIndex:0})).rejects.toThrow('agentId');
   const good=await tool.call({jobId:'lead',taskIndex:0,agentId:'coding-manager-sol'}); expect(good.success).toBe(true); expect(h.launcher.launchReplacement).toHaveBeenCalledOnce();
 });
 it('refuses a peer before launching and names the live owner',async()=>{
   // risk: authorization — peers cannot replace an actively owned lead.
   const h=new ReplaceLeadHarness(); h.custody.authorizeManagement.mockResolvedValueOnce({ok:false,code:'forbidden',message:'Custody belongs to coding-manager-sol (sulla-desktop/parent-thread).',current:owner} as any);
   const result=await h.service.replace({jobId:'lead',taskIndex:0,agentId:'coding-manager-sol',actor:{kind:'agent',channel:'peer',threadId:'peer-thread',agentId:'peer-lead'}});
   expect(result).toEqual(expect.objectContaining({ok:false,code:'forbidden',message:expect.stringContaining('coding-manager-sol')})); expect(h.launcher.launchReplacement).not.toHaveBeenCalled();
 });
 it('reports nonexistent tasks and disabled replacement agents without moving children',async()=>{
   // risk: operations — invalid targets must fail before custody changes.
   const missing=new ReplaceLeadHarness(); missing.custody.resolveOwner.mockResolvedValueOnce(undefined); expect((await missing.service.replace({jobId:'missing',taskIndex:9,agentId:'coding-manager-sol',actor})).message).toContain('not found');
   const disabled=new ReplaceLeadHarness(); disabled.launcher.launchReplacement.mockRejectedValueOnce(new Error('no enabled agent definition exists'));
   expect((await disabled.service.replace({jobId:'lead',taskIndex:0,agentId:'disabled-agent',actor})).message).toContain('enabled agent'); expect(disabled.moves).toHaveLength(0);
 });

});
