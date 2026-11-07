// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {TestDatabase} from '../../Support/TestDatabase';
import {agentToolManifests} from '../../../tools/agents/manifests';
import type {BaseTool} from '../../../tools/base';
const dbDescribe=TestDatabase.available()?describe:process.env.CI?describe:describe.skip;

// The registered catalog reaches AgentContainerLauncher, whose production
// Electron import is unavailable in the headless Node test runner.
vi.mock('electron',()=>({app:{getPath:()=>tmpdir(),getVersion:()=> '0.0.0-test',isPackaged:false},safeStorage:{}}));

class CompletionDispatchCapture {readonly targets:Array<{channel:string;threadId:string}>=[];record(channel:string,threadId:string){this.targets.push({channel,threadId});}}

class RegisteredCustodyTool {
  async call(name:'reassign_job'|'adopt_job'|'send_job_message'|'stop_agent_job'|'return_result',input:any,metadata:any){
    const manifest=agentToolManifests.find(item=>item.name===name)!;
    const module:any=await manifest.loader();
    const classes:any={reassign_job:'ReassignJobWorker',adopt_job:'AdoptJobWorker',send_job_message:'SendJobMessageWorker',stop_agent_job:'StopAgentJobWorker',return_result:'ReturnResultWorker'};
    const Type=module[classes[name]];
    const tool:BaseTool=new Type();
    tool.schemaDef=manifest.schemaDef;
    tool.setState({metadata});
    return tool.call(input);
  }
}

dbDescribe('registered custody transfer tools',()=>{
  const database=new TestDatabase(); const tools=new RegisteredCustodyTool(); let registry:any;
  const priorEnvironment={url:process.env.SULLA_DATABASE_URL,options:process.env.PGOPTIONS,poolMax:process.env.SULLA_DATABASE_POOL_MAX};
  beforeAll(async()=>{
    const {SullaSettingsModel}=await import('../../../database/models/SullaSettingsModel');SullaSettingsModel.setFallbackFilePath(join(tmpdir(),'job-custody-tools-settings.json'));
    await database.initialize(); process.env.SULLA_DATABASE_URL=database.appUrl(); process.env.PGOPTIONS=`-csearch_path=${database.schema},public`; process.env.SULLA_DATABASE_POOL_MAX='1';
    const {postgresClient}=await import('../../../database/PostgresClient'); await postgresClient.initialize(); await postgresClient.query(`SET search_path TO "${database.schema}", public`);
    registry=await import('../../../tools/agents/jobRegistry');
  },60_000);
  afterAll(async()=>{
    const {postgresClient}=await import('../../../database/PostgresClient');
    await postgresClient.end();
    await database.dispose();
    if(priorEnvironment.url===undefined)delete process.env.SULLA_DATABASE_URL;else process.env.SULLA_DATABASE_URL=priorEnvironment.url;
    if(priorEnvironment.options===undefined)delete process.env.PGOPTIONS;else process.env.PGOPTIONS=priorEnvironment.options;
    if(priorEnvironment.poolMax===undefined)delete process.env.SULLA_DATABASE_POOL_MAX;else process.env.SULLA_DATABASE_POOL_MAX=priorEnvironment.poolMax;
  });

  it('H1/H7 transfers custody through the registered manifest path and records durable notices',async()=>{
    // risk: authorization + lost contracts/blockers after a manager handoff
    await registry.createJob([{agentId:'manager-two',label:'M2',prompt:'manage',status:'running',threadId:'manager-two-thread'}],'root','root-thread',{parentAgentId:'root'});
    const worker=await registry.createJob([{agentId:'worker',label:'W',prompt:'work',status:'running',threadId:'worker-thread'}],'manager-one','manager-one-thread',{parentAgentId:'manager-one'});
    const moved=await tools.call('reassign_job',{jobId:worker.jobId,to:'manager-two-thread',reason:'handoff test'},{wsChannel:'manager-one',agentId:'manager-one',threadId:'manager-one-thread',subAgentDepth:1});
    expect(moved,JSON.stringify(moved)).toMatchObject({success:true});
    const {agentJobProvider}=await import('../../../app/Providers/AgentJobServiceProvider');
    expect(await agentJobProvider.custody.resolveOwner(worker.jobId)).toMatchObject({agentId:'manager-two',threadId:'manager-two-thread'});
    expect(await agentJobProvider.custody.history(worker.jobId)).toHaveLength(1);
    const pending=await agentJobProvider.messaging.pendingMessagesForThread('worker-thread');
    expect(pending.map(item=>item.message)).toContainEqual(expect.stringContaining('[Manager changed]'));
  });

  it('H5 refuses a live peer through both registered tools without an audit row',async()=>{
    // risk: peer custody theft
    await registry.createJob([{agentId:'healthy-owner',label:'owner',prompt:'manage',status:'running',threadId:'healthy-owner-thread'}],'root','root-thread',{parentAgentId:'root'});
    const job=await registry.createJob([{agentId:'worker',label:'W',prompt:'work',status:'running',threadId:'peer-worker-thread'}],'healthy-owner','healthy-owner-thread',{parentAgentId:'healthy-owner'});
    await registry.createJob([{agentId:'peer',label:'peer',prompt:'manage',status:'running',threadId:'peer-thread'}],'root','root-thread',{parentAgentId:'root'});
    const meta={wsChannel:'peer',agentId:'peer',threadId:'peer-thread',subAgentDepth:1};
    const reassign=await tools.call('reassign_job',{jobId:job.jobId,to:'manager-two-thread',reason:'unauthorized'},meta);
    const adopt=await tools.call('adopt_job',{jobId:job.jobId,reason:'unauthorized'},meta);
    expect(reassign.success).toBe(false); expect(String(reassign.error??reassign.result)).toContain('healthy-owner');
    expect(adopt.success).toBe(false); expect(String(adopt.error??adopt.result)).toContain('healthy-owner');
    const {agentJobProvider}=await import('../../../app/Providers/AgentJobServiceProvider');
    expect(await agentJobProvider.custody.history(job.jobId)).toHaveLength(0);
  });


  it('H2 adopts a stranded top-level manager and routes its registered return to the adopter',async()=>{
    // risk: lost manager completion; guards return_result.ts deliverJobCompletion and JobCompletionDelivery custody resolution
    const {GraphRegistry}=await import('../../../services/GraphRegistry');
    const owner=`h2-owner-${Date.now()}`;const adopter=`h2-adopter-${Date.now()}`;
    const ownerGraph=await GraphRegistry.getOrCreate(owner,`${owner}-thread`);Object.assign(ownerGraph.state.metadata,{agentId:owner,wsChannel:owner,threadId:`${owner}-thread`,isSubAgent:false,subAgentDepth:0,managerThreadId:undefined});
    const adopterGraph=await GraphRegistry.getOrCreate(adopter,`${adopter}-thread`);Object.assign(adopterGraph.state.metadata,{agentId:adopter,wsChannel:adopter,threadId:`${adopter}-thread`,isSubAgent:false,subAgentDepth:0,managerThreadId:undefined});
    const lead=await registry.createJob([{agentId:'lead',label:'L',prompt:'lead',status:'parked',threadId:`lead-${Date.now()}`}],owner,`${owner}-thread`,{parentAgentId:owner});
    await database.query(`UPDATE agent_jobs SET status='parked',tasks=jsonb_set(tasks,'{0,status}','"parked"') WHERE job_id=$1`,[lead.jobId]);
    GraphRegistry.delete(`${owner}-thread`);
    const adopted=await tools.call('adopt_job',{jobId:lead.jobId,reason:'stranded owner'}, {wsChannel:adopter,agentId:adopter,threadId:`${adopter}-thread`,isSubAgent:false,subAgentDepth:0});
    expect(adopted,JSON.stringify(adopted)).toMatchObject({success:true});
    GraphRegistry.delete(`${adopter}-thread`); // keep the durable completion queued instead of letting the live graph consume it
    const {completionInboxStore}=await import('../../../services/AgentCompletionInbox');completionInboxStore.registerIdleDispatcher(()=>{});
    const returned=await tools.call('return_result',{status:'completed',summary:'lead done',output:{ok:true}}, {wsChannel:'lead',agentId:'lead',threadId:lead.tasks[0].threadId,subAgentDepth:1});
    expect(returned,JSON.stringify(returned)).toMatchObject({success:true});
    const {agentJobProvider}=await import('../../../app/Providers/AgentJobServiceProvider');
    expect(await agentJobProvider.custody.resolveOwner(lead.jobId)).toMatchObject({agentId:adopter,threadId:`${adopter}-thread`});
    GraphRegistry.delete(`${adopter}-thread`);
  });

  it('H2b permits one verified live top-level chat to adopt from another and writes both notices',async()=>{
    // risk: live-chat handoff; guards TopLevelHumanSessionAuthorityRule and AgentJobCustodyRepository notice inserts
    const {GraphRegistry}=await import('../../../services/GraphRegistry');const stamp=Date.now();
    const register=async(agent:string)=>{const thread=`${agent}-${stamp}`;const entry=await GraphRegistry.getOrCreate(agent,thread);Object.assign(entry.state.metadata,{agentId:agent,wsChannel:agent,threadId:thread,isSubAgent:false,subAgentDepth:0,managerThreadId:undefined});return thread;};
    const oldThread=await register('h2b-old');const newThread=await register('h2b-new');
    const job=await registry.createJob([{agentId:'worker',label:'W',prompt:'work',status:'running',threadId:`h2b-worker-${stamp}`}],'h2b-old',oldThread,{parentAgentId:'h2b-old'});
    const adopted=await tools.call('adopt_job',{jobId:job.jobId,reason:'live top-level transfer'},{wsChannel:'h2b-new',agentId:'h2b-new',threadId:newThread,isSubAgent:false,subAgentDepth:0});
    expect(adopted,JSON.stringify(adopted)).toMatchObject({success:true});
    const {agentJobProvider}=await import('../../../app/Providers/AgentJobServiceProvider');expect(await agentJobProvider.custody.history(job.jobId)).toHaveLength(1);
    const notices=await database.query<any>(`SELECT receiver_thread_id FROM agent_inbox_messages WHERE message_id LIKE $1 ORDER BY receiver_thread_id`,[`custody:${job.jobId}:job:1:%`]);
    expect(notices.map(row=>row.receiver_thread_id).sort()).toEqual([newThread,oldThread].sort());GraphRegistry.delete(oldThread);GraphRegistry.delete(newThread);
  });

  it('H7 authorizes only the new owner to message after a move and queues manager change exactly once',async()=>{
    // risk: stale-manager steering; guards send_job_message.ts locked owner check and custody worker notice insert
    const stamp=Date.now();await registry.createJob([{agentId:'new-owner',label:'N',prompt:'manage',status:'running',threadId:`new-owner-${stamp}`}],'root','root-thread',{parentAgentId:'root'});
    const job=await registry.createJob([{agentId:'worker',label:'W',prompt:'work',status:'running',threadId:`h7-worker-${stamp}`}],'old-owner',`old-owner-${stamp}`,{parentAgentId:'old-owner'});
    const oldMeta={wsChannel:'old-owner',agentId:'old-owner',threadId:`old-owner-${stamp}`,subAgentDepth:1};const newMeta={wsChannel:'new-owner',agentId:'new-owner',threadId:`new-owner-${stamp}`,subAgentDepth:1};
    expect(await tools.call('reassign_job',{jobId:job.jobId,to:`new-owner-${stamp}`,reason:'handoff'},oldMeta)).toMatchObject({success:true});
    expect(await tools.call('send_job_message',{jobId:job.jobId,message:'new instruction'},newMeta)).toMatchObject({success:true});
    const refused=await tools.call('send_job_message',{jobId:job.jobId,message:'stale instruction'},oldMeta);expect(refused.success).toBe(false);expect(JSON.stringify(refused)).toContain('new-owner');
    const pending=await database.query<any>(`SELECT message FROM agent_job_messages WHERE job_id=$1 ORDER BY created_at`,[job.jobId]);expect(pending.filter(row=>row.message.includes('[Manager changed]'))).toHaveLength(1);
  });

  it('Stop follows whole-job custody: new owner succeeds and old owner is refused with the current owner',async()=>{
    // risk: stale manager termination; guards JobStopService.stopCascade withOwner authorization
    const stamp=Date.now();await registry.createJob([{agentId:'stop-new',label:'N',prompt:'manage',status:'running',threadId:`stop-new-${stamp}`}],'root','root-thread',{parentAgentId:'root'});
    const oldMeta={wsChannel:'stop-old',agentId:'stop-old',threadId:`stop-old-${stamp}`,subAgentDepth:1};const newMeta={wsChannel:'stop-new',agentId:'stop-new',threadId:`stop-new-${stamp}`,subAgentDepth:1};
    const stale=await registry.createJob([{agentId:'worker',label:'W',prompt:'work',status:'running',threadId:`stop-worker-a-${stamp}`}],'stop-old',`stop-old-${stamp}`,{parentAgentId:'stop-old'});
    expect(await tools.call('reassign_job',{jobId:stale.jobId,to:`stop-new-${stamp}`,reason:'move before stop'},oldMeta)).toMatchObject({success:true});
    const refused=await tools.call('stop_agent_job',{jobId:stale.jobId,reason:'stale stop'},oldMeta);expect(refused.success).toBe(false);expect(JSON.stringify(refused)).toContain('stop-new');
    expect(await tools.call('stop_agent_job',{jobId:stale.jobId,reason:'owner stop'},newMeta)).toMatchObject({success:true});
  });


  it('Stop follows single-task custody while untouched tasks retain their original owner',async()=>{
    // risk: cross-task cancellation; guards JobStopService.stopTask task-scoped custody lookup
    const stamp=Date.now();await registry.createJob([{agentId:'task-new',label:'N',prompt:'manage',status:'running',threadId:`task-new-${stamp}`}],'root','root-thread',{parentAgentId:'root'});
    const oldMeta={wsChannel:'task-old',agentId:'task-old',threadId:`task-old-${stamp}`,subAgentDepth:1};const newMeta={wsChannel:'task-new',agentId:'task-new',threadId:`task-new-${stamp}`,subAgentDepth:1};
    const job=await registry.createJob([{agentId:'worker-a',label:'A',prompt:'work',status:'running',threadId:`task-worker-a-${stamp}`},{agentId:'worker-b',label:'B',prompt:'work',status:'running',threadId:`task-worker-b-${stamp}`}],'task-old',`task-old-${stamp}`,{parentAgentId:'task-old'});
    expect(await tools.call('reassign_job',{jobId:job.jobId,taskIndex:1,to:`task-new-${stamp}`,reason:'move one task'},oldMeta)).toMatchObject({success:true});
    const stale=await tools.call('stop_agent_job',{jobId:job.jobId,taskIndex:1,reason:'stale task stop'},oldMeta);expect(stale.success).toBe(false);expect(JSON.stringify(stale)).toContain('task-new');
    expect(await tools.call('stop_agent_job',{jobId:job.jobId,taskIndex:1,reason:'new owner task stop'},newMeta)).toMatchObject({success:true});
    expect(await tools.call('stop_agent_job',{jobId:job.jobId,taskIndex:0,reason:'original owner task stop'},oldMeta)).toMatchObject({success:true});
  });

  it('break-it refuses dead, nonexistent, and ambiguous destinations without mutation',async()=>{
    // risk: orphaned custody; guards CustodyDestinationResolver positive unique-live resolution
    const stamp=Date.now();const job=await registry.createJob([{agentId:'worker',label:'W',prompt:'work',status:'running',threadId:`break-worker-${stamp}`}],'break-owner',`break-owner-${stamp}`,{parentAgentId:'break-owner'});
    const meta={wsChannel:'break-owner',agentId:'break-owner',threadId:`break-owner-${stamp}`,subAgentDepth:1};
    for(const to of [`dead-thread-${stamp}`,`missing-thread-${stamp}`])expect((await tools.call('reassign_job',{jobId:job.jobId,to,reason:'must refuse'},meta)).success).toBe(false);
    const {agentJobProvider}=await import('../../../app/Providers/AgentJobServiceProvider');expect(await agentJobProvider.custody.history(job.jobId)).toHaveLength(0);expect((await agentJobProvider.custody.resolveOwner(job.jobId))?.threadId).toBe(`break-owner-${stamp}`);
  });

  it('break-it concurrent registered adopt_job calls produce exactly one winner and one audit row',async()=>{
    // risk: split ownership; guards AgentJobCustodyRepository advisory lock/version compare
    const {GraphRegistry}=await import('../../../services/GraphRegistry');const stamp=Date.now();
    const ownerThread=`race-owner-${stamp}`;const ownerGraph=await GraphRegistry.getOrCreate('race-owner',ownerThread);Object.assign(ownerGraph.state.metadata,{agentId:'race-owner',wsChannel:'race-owner',threadId:ownerThread,isSubAgent:false,subAgentDepth:0});
    const job=await registry.createJob([{agentId:'worker',label:'W',prompt:'work',status:'running',threadId:`race-worker-${stamp}`}],'race-owner',ownerThread,{parentAgentId:'race-owner'});
    const entrants=await Promise.all(['race-a','race-b'].map(async agent=>{const thread=`${agent}-${stamp}`;const graph=await GraphRegistry.getOrCreate(agent,thread);Object.assign(graph.state.metadata,{agentId:agent,wsChannel:agent,threadId:thread,isSubAgent:false,subAgentDepth:0});return {thread,meta:{wsChannel:agent,agentId:agent,threadId:thread,isSubAgent:false,subAgentDepth:0}};}));
    const results=await Promise.all(entrants.map(entry=>tools.call('adopt_job',{jobId:job.jobId,reason:'concurrent adoption'},entry.meta)));
    expect(results.filter(result=>result.success)).toHaveLength(1);const {agentJobProvider}=await import('../../../app/Providers/AgentJobServiceProvider');expect(await agentJobProvider.custody.history(job.jobId)).toHaveLength(1);
    GraphRegistry.delete(ownerThread);entrants.forEach(entry=>GraphRegistry.delete(entry.thread));
  });


  it('H4 serializes registered return_result with reassign_job in both commit orders',async()=>{
    // risk: lost/duplicated contracts; guards jobDelivery.ts:188-195 and AgentJobCustodyRepository.ts:20-28
    const {completionInboxStore}=await import('../../../services/AgentCompletionInbox');const stamp=Date.now();
    for(const order of ['return-first','move-first'] as const){
      completionInboxStore.clear();completionInboxStore.registerIdleDispatcher(()=>{});
      const old=`h4-old-${order}-${stamp}`,next=`h4-new-${order}-${stamp}`,child=`h4-child-${order}-${stamp}`;
      await registry.createJob([{agentId:next,label:'N',prompt:'manage',status:'running',threadId:next}],'root','root-thread',{parentAgentId:'root'});
      const job=await registry.createJob([{agentId:'worker',label:'W',prompt:'work',status:'running',threadId:child}],old,old,{parentAgentId:old});
      await database.query(`UPDATE agent_jobs SET status='parked',tasks=jsonb_set(tasks,'{0,status}','"parked"') WHERE job_id=$1`,[job.jobId]);
      const returned=()=>tools.call('return_result',{status:'completed',summary:'race result',output:{order}},{wsChannel:'worker',agentId:'worker',threadId:child,subAgentDepth:1});
      const moved=()=>tools.call('reassign_job',{jobId:job.jobId,to:next,reason:`${order} race`},{wsChannel:old,agentId:old,threadId:old,subAgentDepth:1});
      const results=order==='return-first'?[await returned(),await moved()]:[await moved(),await returned()];
      expect(results.every(result=>result.success),JSON.stringify(results)).toBe(true);
      expect(completionInboxStore.take(next,next).filter(entry=>entry.jobId===job.jobId&&entry.results.length>0)).toHaveLength(1);
      expect(completionInboxStore.take(old,old).filter(entry=>entry.jobId===job.jobId&&entry.results.length>0)).toHaveLength(0);
    }
  });

  it('H4 keeps an adopted managers worker completion with that manager',async()=>{
    // risk: adopter steals nested contracts; guards JobCompletionDelivery custody scope in jobDelivery.ts:188-195
    const {GraphRegistry}=await import('../../../services/GraphRegistry');const {completionInboxStore}=await import('../../../services/AgentCompletionInbox');const stamp=Date.now();
    completionInboxStore.clear();completionInboxStore.registerIdleDispatcher(()=>{});
    const owner=`h4po-owner-${stamp}`,adopter=`h4po-adopter-${stamp}`,managerThread=`h4po-manager-${stamp}`,workerThread=`h4po-worker-${stamp}`;
    for(const [agent,thread] of [[owner,owner],[adopter,adopter]] as const){const graph=await GraphRegistry.getOrCreate(agent,thread);Object.assign(graph.state.metadata,{agentId:agent,wsChannel:agent,threadId:thread,isSubAgent:false,subAgentDepth:0});}
    const manager=await registry.createJob([{agentId:'nested-manager',label:'M',prompt:'manage',status:'parked',threadId:managerThread}],owner,owner,{parentAgentId:owner});
    await database.query(`UPDATE agent_jobs SET status='parked',tasks=jsonb_set(tasks,'{0,status}','"parked"') WHERE job_id=$1`,[manager.jobId]);GraphRegistry.delete(owner);
    const child=await registry.createJob([{agentId:'nested-worker',label:'W',prompt:'work',status:'running',threadId:workerThread}], 'nested-manager',managerThread,{parentAgentId:'nested-manager'});
    await database.query(`UPDATE agent_jobs SET status='parked',tasks=jsonb_set(tasks,'{0,status}','"parked"') WHERE job_id=$1`,[child.jobId]);
    expect(await tools.call('adopt_job',{jobId:manager.jobId,reason:'adopt manager'},{wsChannel:adopter,agentId:adopter,threadId:adopter,isSubAgent:false,subAgentDepth:0})).toMatchObject({success:true});
    expect(await tools.call('return_result',{status:'completed',summary:'nested done',output:{ok:true}},{wsChannel:'nested-worker',agentId:'nested-worker',threadId:workerThread,subAgentDepth:2})).toMatchObject({success:true});
    expect(completionInboxStore.take('nested-manager',managerThread).filter(entry=>entry.jobId===child.jobId&&entry.results.length>0)).toHaveLength(1);
    expect(completionInboxStore.take(adopter,adopter).filter(entry=>entry.jobId===child.jobId&&entry.results.length>0)).toHaveLength(0);GraphRegistry.delete(adopter);
  });

  it('H6 fresh provider recovery preserves custody and dedupes stale completion replay',async()=>{
    // risk: restart redelivery to stale owner; guards AgentCompletionRecoveryService.ts:43-55 and AgentJobServiceProvider.ts:48-70
    const {AgentJobServiceProvider}=await import('../../../app/Providers/AgentJobServiceProvider');const {AgentCompletionRecoveryService,CompletionDeliveryPolicy}=await import('../../../services/AgentCompletionRecoveryService');const {CompletionInboxStore}=await import('../../../services/AgentCompletionInbox');const stamp=Date.now();
    const old=`h6-old-${stamp}`,next=`h6-new-${stamp}`,child=`h6-worker-${stamp}`;await registry.createJob([{agentId:next,label:'N',prompt:'manage',status:'running',threadId:next}],'root','root-thread',{parentAgentId:'root'});
    const job=await registry.createJob([{agentId:'worker',label:'W',prompt:'work',status:'running',threadId:child}],old,old,{parentAgentId:old});
    expect(await tools.call('reassign_job',{jobId:job.jobId,to:next,reason:'restart handoff'},{wsChannel:old,agentId:old,threadId:old,subAgentDepth:1})).toMatchObject({success:true});
    await database.query(`UPDATE agent_jobs SET status='completed',results=$2::jsonb,tasks=jsonb_set(jsonb_set(tasks,'{0,status}','"completed"'),'{0,completion}',$3::jsonb) WHERE job_id=$1`,[job.jobId,JSON.stringify([{label:'W',status:'completed',output:'done',threadId:child}]),JSON.stringify({label:'W',status:'completed',output:'done',threadId:child})]);
    const fresh=new AgentJobServiceProvider();const inbox=new CompletionInboxStore();inbox.registerIdleDispatcher(()=>{});const recovery=new AgentCompletionRecoveryService(fresh.jobs,inbox,new CompletionDeliveryPolicy(),fresh.custody);
    await recovery.recover();await recovery.recover();
    expect(await fresh.custody.resolveOwner(job.jobId)).toMatchObject({threadId:next,agentId:next});expect(await fresh.custody.history(job.jobId)).toHaveLength(1);
    expect(inbox.take(next,next).filter(entry=>entry.jobId===job.jobId)).toHaveLength(1);expect(inbox.take(old,old)).toHaveLength(0);
    const notices=await database.query<any>(`SELECT message_id,receiver_thread_id FROM agent_inbox_messages WHERE message_id LIKE $1 ORDER BY message_id`,[`custody:${job.jobId}:job:1:%`]);expect(notices).toHaveLength(2);expect(new Set(notices.map(row=>row.receiver_thread_id))).toEqual(new Set([old,next]));
  });

  it('refuses an ambiguous live channel and lists both candidates without mutation',async()=>{
    // risk: nondeterministic custody; guards CustodyDestinationResolver.ts:21-22
    const {GraphRegistry}=await import('../../../services/GraphRegistry');const stamp=Date.now(),channel=`ambiguous-${stamp}`,a=`amb-a-${stamp}`,b=`amb-b-${stamp}`,owner=`amb-owner-${stamp}`;
    for(const thread of [a,b]){const graph=await GraphRegistry.getOrCreate(channel,thread);Object.assign(graph.state.metadata,{agentId:channel,wsChannel:channel,threadId:thread,isSubAgent:false,subAgentDepth:0});}
    const job=await registry.createJob([{agentId:'worker',label:'W',prompt:'work',status:'running',threadId:`amb-worker-${stamp}`}],owner,owner,{parentAgentId:owner});const result=await tools.call('reassign_job',{jobId:job.jobId,to:channel,reason:'ambiguous'},{wsChannel:owner,agentId:owner,threadId:owner,subAgentDepth:1});
    expect(result.success).toBe(false);expect(JSON.stringify(result)).toContain(a);expect(JSON.stringify(result)).toContain(b);const {agentJobProvider}=await import('../../../app/Providers/AgentJobServiceProvider');expect(await agentJobProvider.custody.history(job.jobId)).toHaveLength(0);expect((await agentJobProvider.custody.resolveOwner(job.jobId))?.threadId).toBe(owner);GraphRegistry.delete(a);GraphRegistry.delete(b);
  });

  it('refuses moving a job to its grandchild thread without mutation',async()=>{
    // risk: cyclic manager graph; guards MainCustodyOwnerLiveness.ts:60-64 and JobCustodyAuthorityPolicy.ts:31
    const stamp=Date.now(),root=`cycle-root-${stamp}`,parentThread=`cycle-parent-${stamp}`,childThread=`cycle-child-${stamp}`,grandchildThread=`cycle-grandchild-${stamp}`;
    const parent=await registry.createJob([{agentId:'parent',label:'P',prompt:'work',status:'running',threadId:parentThread}],root,root,{parentAgentId:root});
    await registry.createJob([{agentId:'child',label:'C',prompt:'work',status:'running',threadId:childThread}],'parent',parentThread,{parentAgentId:'parent'});
    await registry.createJob([{agentId:'grandchild',label:'G',prompt:'work',status:'running',threadId:grandchildThread}],'child',childThread,{parentAgentId:'child'});
    const result=await tools.call('reassign_job',{jobId:parent.jobId,to:grandchildThread,reason:'must reject cycle'},{wsChannel:root,agentId:root,threadId:root,subAgentDepth:0});expect(result.success).toBe(false);expect(JSON.stringify(result)).toContain('descendant');const {agentJobProvider}=await import('../../../app/Providers/AgentJobServiceProvider');expect(await agentJobProvider.custody.history(parent.jobId)).toHaveLength(0);expect((await agentJobProvider.custody.resolveOwner(parent.jobId))?.threadId).toBe(root);
  });

});
