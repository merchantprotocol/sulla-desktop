// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import {tmpdir} from 'node:os';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {TestDatabase} from '../../Support/TestDatabase';
import {agentToolManifests} from '../../../tools/agents/manifests';
import type {BaseTool} from '../../../tools/base';
const dbDescribe=TestDatabase.available()?describe:process.env.CI?describe:describe.skip;

// The registered catalog reaches AgentContainerLauncher, whose production
// Electron import is unavailable in the headless Node test runner.
vi.mock('electron',()=>({app:{getPath:()=>tmpdir(),getVersion:()=> '0.0.0-test',isPackaged:false},safeStorage:{}}));

class RegisteredCustodyTool {
  async call(name:'reassign_job'|'adopt_job'|'send_job_message'|'stop_agent_job',input:any,metadata:any){
    const manifest=agentToolManifests.find(item=>item.name===name)!;
    const module:any=await manifest.loader();
    const classes:any={reassign_job:'ReassignJobWorker',adopt_job:'AdoptJobWorker',send_job_message:'SendJobMessageWorker',stop_agent_job:'StopAgentJobWorker'};
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

});
