// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {TestDatabase} from '../../Support/TestDatabase';
import {agentToolManifests} from '../../../tools/agents/manifests';
import {ToolRegistry} from '../../../tools/registry';
const dbDescribe=TestDatabase.available()?describe:process.env.CI?describe:describe.skip;

// The registered catalog reaches AgentContainerLauncher, whose production
// Electron import is unavailable in the headless Node test runner.
vi.mock('electron',()=>({app:{getPath:()=>tmpdir(),getVersion:()=> '0.0.0-test',isPackaged:false},safeStorage:{}}));

type ToolName='reassign_job'|'return_result';

/** Calls agent tools through the registered manifest/BaseTool path, as a running agent would. */
class RegisteredAgentTools {
  private readonly registry=new ToolRegistry();
  constructor(){this.registry.registerManifests(agentToolManifests);}
  async call(name:ToolName,input:any,metadata:any){
    const tool=await this.registry.createToolForCategory('agents',name);
    tool.setState({metadata});
    return tool.call(input);
  }
}

/** A manager or worker identity used as tool caller metadata. */
class Caller {
  constructor(readonly agentId:string,readonly threadId:string){}
  get meta(){return {wsChannel:this.agentId,agentId:this.agentId,threadId:this.threadId,subAgentDepth:1};}
}

dbDescribe('custody-aware completion redelivery (B regression gaps)',()=>{
  const database=new TestDatabase();const tools=new RegisteredAgentTools();let registry:any;
  const priorEnvironment={url:process.env.SULLA_DATABASE_URL,options:process.env.PGOPTIONS,poolMax:process.env.SULLA_DATABASE_POOL_MAX};
  beforeAll(async()=>{
    const {SullaSettingsModel}=await import('../../../database/models/SullaSettingsModel');SullaSettingsModel.setFallbackFilePath(join(tmpdir(),'job-custody-redelivery-settings.json'));
    await database.initialize();process.env.SULLA_DATABASE_URL=database.appUrl();process.env.PGOPTIONS=`-csearch_path=${database.schema},public`;process.env.SULLA_DATABASE_POOL_MAX='4';
    const {postgresClient}=await import('../../../database/PostgresClient');await postgresClient.initialize();await postgresClient.query(`SET search_path TO "${database.schema}", public`);
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

  const quietInbox=async()=>{const {completionInboxStore}=await import('../../../services/AgentCompletionInbox');completionInboxStore.clear();completionInboxStore.registerIdleDispatcher(()=>{});return completionInboxStore;};
  const resultsFor=(entries:Array<{jobId:string;results:unknown[]}>,jobId:string)=>entries.filter(entry=>entry.jobId===jobId&&entry.results.length>0);

  it('H4 same-instant return_result and reassign_job (no barrier) land the result once, at the final owner',async()=>{
    // risk: lost or duplicated contract when a worker returns in the same instant its manager hands it off
    const inbox=await quietInbox();const stamp=Date.now();
    for(let round=0;round<3;round++){
      const old=new Caller(`h4s-old-${round}-${stamp}`,`h4s-old-${round}-${stamp}`);const next=new Caller(`h4s-new-${round}-${stamp}`,`h4s-new-${round}-${stamp}`);const worker=new Caller('worker',`h4s-worker-${round}-${stamp}`);
      await registry.createJob([{agentId:next.agentId,label:'N',prompt:'manage',status:'running',threadId:next.threadId}],'root','root-thread',{parentAgentId:'root'});
      const job=await registry.createJob([{agentId:'worker',label:'W',prompt:'work',status:'running',threadId:worker.threadId}],old.agentId,old.threadId,{parentAgentId:old.agentId});
      await registry.parkJobTask(job.jobId,0,0);
      const [returned,moved]=await Promise.all([
        tools.call('return_result',{status:'completed',summary:`same-instant ${round}`,output:{round}},worker.meta),
        tools.call('reassign_job',{jobId:job.jobId,to:next.threadId,reason:'same-instant handoff'},old.meta),
      ]);
      expect(returned,JSON.stringify(returned)).toMatchObject({success:true});expect(moved,JSON.stringify(moved)).toMatchObject({success:true});
      expect(resultsFor(inbox.take(next.agentId,next.threadId),job.jobId)).toHaveLength(1);
      expect(resultsFor(inbox.take(old.agentId,old.threadId),job.jobId)).toHaveLength(0);
    }
  });

  it('stale re-delivery: an aborted old-owner turn after a move re-delivers exactly once, to the new owner',async()=>{
    // risk: duplicate or stale-owner contract after a handoff that lands while the old owner's turn holds the claim
    const inbox=await quietInbox();const stamp=Date.now();
    const {agentJobProvider}=await import('../../../app/Providers/AgentJobServiceProvider');const {agentCompletionProvider}=await import('../../../app/Providers/AgentCompletionServiceProvider');
    const old=new Caller(`stale-old-${stamp}`,`stale-old-${stamp}`);const next=new Caller(`stale-new-${stamp}`,`stale-new-${stamp}`);const worker=new Caller('worker',`stale-worker-${stamp}`);
    await registry.createJob([{agentId:next.agentId,label:'N',prompt:'manage',status:'running',threadId:next.threadId}],'root','root-thread',{parentAgentId:'root'});
    const job=await registry.createJob([{agentId:'worker',label:'W',prompt:'work',status:'running',threadId:worker.threadId}],old.agentId,old.threadId,{parentAgentId:old.agentId});
    await registry.parkJobTask(job.jobId,0,0);
    expect(await tools.call('return_result',{status:'completed',summary:'before handoff',output:{ok:true}},worker.meta)).toMatchObject({success:true});
    const claimedByOldTurn=resultsFor(inbox.take(old.agentId,old.threadId),job.jobId);expect(claimedByOldTurn).toHaveLength(1);
    expect(await tools.call('reassign_job',{jobId:job.jobId,to:next.threadId,reason:'handoff during old turn'},old.meta)).toMatchObject({success:true});
    await agentCompletionProvider.recovery.recover(); // a sweep while the claim is held must not add a copy
    // The old owner's turn aborts without consuming the result (BackendGraphWebSocketService release path).
    expect(await agentJobProvider.completionRequeue.requeue(old.agentId,old.threadId,claimedByOldTurn[0])).toBe(true);
    await agentCompletionProvider.recovery.recover(); // a sweep after the requeue must dedupe against the pending entry
    const delivered=resultsFor(inbox.take(next.agentId,next.threadId),job.jobId);
    expect(delivered).toHaveLength(1);expect(resultsFor(inbox.take(old.agentId,old.threadId),job.jobId)).toHaveLength(0);
    await agentJobProvider.completionAcknowledgements.acknowledge(delivered[0]);
    await agentCompletionProvider.recovery.recover();
    expect(resultsFor(inbox.take(next.agentId,next.threadId),job.jobId)).toHaveLength(0);expect(resultsFor(inbox.take(old.agentId,old.threadId),job.jobId)).toHaveLength(0);
  });

  it('refuses a destination whose task has already finished, without an audit row',async()=>{
    // risk: custody handed to a dead agent, orphaning the worker and its contract
    const stamp=Date.now();const owner=new Caller(`dead-owner-${stamp}`,`dead-owner-${stamp}`);const deadThread=`dead-lead-${stamp}`;
    const dead=await registry.createJob([{agentId:'dead-lead',label:'D',prompt:'manage',status:'running',threadId:deadThread}],'root','root-thread',{parentAgentId:'root'});
    const {agentJobProvider}=await import('../../../app/Providers/AgentJobServiceProvider');
    expect(await agentJobProvider.service.stopJobCascade(dead.jobId,{kind:'human'},'finished lead')).toBe('stopped');
    const job=await registry.createJob([{agentId:'worker',label:'W',prompt:'work',status:'running',threadId:`dead-worker-${stamp}`}],owner.agentId,owner.threadId,{parentAgentId:owner.agentId});
    const refused=await tools.call('reassign_job',{jobId:job.jobId,to:deadThread,reason:'must refuse a dead destination'},owner.meta);
    expect(refused.success).toBe(false);
    expect(await agentJobProvider.custody.history(job.jobId)).toHaveLength(0);expect((await agentJobProvider.custody.resolveOwner(job.jobId))?.threadId).toBe(owner.threadId);
  });

  it('H6 after a restart the moved custody still governs authority and its durable notice is claimable exactly once',async()=>{
    // risk: a restart resurrects the old owner's authority or replays a custody notice twice
    await quietInbox();const stamp=Date.now();
    const old=new Caller(`h6d-old-${stamp}`,`h6d-old-${stamp}`);const next=new Caller(`h6d-new-${stamp}`,`h6d-new-${stamp}`);
    await registry.createJob([{agentId:next.agentId,label:'N',prompt:'manage',status:'running',threadId:next.threadId}],'root','root-thread',{parentAgentId:'root'});
    const job=await registry.createJob([{agentId:'worker',label:'W',prompt:'work',status:'running',threadId:`h6d-worker-${stamp}`}],old.agentId,old.threadId,{parentAgentId:old.agentId});
    expect(await tools.call('reassign_job',{jobId:job.jobId,to:next.threadId,reason:'before restart'},old.meta)).toMatchObject({success:true});
    const {AgentJobServiceProvider}=await import('../../../app/Providers/AgentJobServiceProvider');const restarted=new AgentJobServiceProvider();
    expect(await restarted.custody.resolveOwner(job.jobId)).toMatchObject({threadId:next.threadId,agentId:next.agentId});
    expect(await restarted.service.stopJobCascade(job.jobId,{kind:'agent',agentId:old.agentId,threadId:old.threadId},'stale stop after restart')).toBe('forbidden');
    const {PostgresAgentInboxRepository}=await import('../../../app/Repositories/PostgresAgentInboxRepository');const {DesktopPostgresConnection}=await import('../../../app/Database/DesktopPostgresConnection');const {postgresClient}=await import('../../../database/PostgresClient');
    const durable=new PostgresAgentInboxRepository(new DesktopPostgresConnection(postgresClient));const target={channel:next.agentId,threadId:next.threadId,agentId:next.agentId};
    const first=await durable.claim(target,`h6d-first-${stamp}`);expect(first.entries.filter(entry=>entry.envelope.ids.jobId===job.jobId)).toHaveLength(1);await durable.acknowledge(first);
    const replay=await durable.claim(target,`h6d-replay-${stamp}`);expect(replay.entries.filter(entry=>entry.envelope.ids.jobId===job.jobId)).toHaveLength(0);await durable.acknowledge(replay);
    expect(await restarted.service.stopJobCascade(job.jobId,{kind:'agent',agentId:next.agentId,threadId:next.threadId},'owner stop after restart')).toBe('stopped');
  });
});
