// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import '../../Support/TestHomeEnv';
import {tmpdir} from 'node:os';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';

vi.setConfig({testTimeout:15_000,hookTimeout:30_000});
import {TestDatabase} from '../../Support/TestDatabase';

vi.mock('electron',()=>({app:{getPath:()=>tmpdir(),getVersion:()=> '0.0.0-test',isPackaged:false},safeStorage:{}}));
vi.mock('../../../services/DecisionService',()=>({decisionService:{requiresApproval:vi.fn(async()=>false)}}));
const runtimeEntries=new Map<string,any>();
vi.mock('../../../services/GraphRegistry',()=>({GraphRegistry:{get:(threadId:string)=>runtimeEntries.get(threadId)??null}}));

let failAfterPersist=false;
vi.mock('../../../tools/agents/spawn_agent',async()=>{
 class ProcessBoundarySpawnAgentWorker {
  async runValidated(input:any,state:any){
   if(input.tasks[0].agentId!=='coding-manager-sol')return {successBoolean:false,responseString:'no enabled agent definition exists'};
   const {postgresClient}=await import('../../../database/PostgresClient');
   const jobId=`replacement-${String(input.tasks[0].label).split(':').slice(-2).join('-')}`;
   const existing=await postgresClient.query<any>('SELECT job_id FROM agent_jobs WHERE job_id=$1',[jobId]);
   if(!existing.length)await postgresClient.query(`INSERT INTO agent_jobs(job_id,status,task_count,parent_channel,parent_thread_id,parent_agent_id,tasks) VALUES($1,'running',1,$2,$3,$4,$5::jsonb)`,[jobId,state.metadata.wsChannel,state.metadata.threadId,state.metadata.agentId,JSON.stringify([{agentId:'coding-manager-sol',label:input.tasks[0].label,prompt:input.tasks[0].prompt,status:'running',threadId:`${jobId}-thread`}])]);
   if(failAfterPersist)throw new Error('simulated process disconnect after persist');
   return {successBoolean:true,responseString:'ok',result:{jobId}};
  }
 }
 return {SpawnAgentWorker:ProcessBoundarySpawnAgentWorker};
});

const database=new TestDatabase();
const suite=TestDatabase.available()?describe:process.env.CI?describe:describe.skip;
const owner={channel:'sulla-desktop',threadId:'parent-thread',agentId:'coding-manager-sol'};
const task=(label:string,threadId:string,status='running')=>({agentId:'codex-sol-worker',label,prompt:`work ${label}`,status,threadId});

suite('agents/replace_lead registered production path',()=>{
 let registry:any;
 beforeAll(async()=>{
  await database.initialize();process.env.SULLA_DATABASE_URL=database.appUrl();process.env.PGOPTIONS=`-csearch_path=${database.schema},public`;process.env.SULLA_DATABASE_POOL_MAX='4';
  const {postgresClient}=await import('../../../database/PostgresClient');await postgresClient.initialize();await postgresClient.query(`SET search_path TO "${database.schema}", public`);
  const {ToolRegistry}=await import('../../../tools/registry');const {agentToolManifests}=await import('../../../tools/agents/manifests');registry=new ToolRegistry();registry.registerManifests(agentToolManifests.filter((manifest:any)=>manifest.name==='replace_lead'));
  runtimeEntries.set(owner.threadId,{state:{metadata:{wsChannel:owner.channel,threadId:owner.threadId,agentId:owner.agentId,subAgentDepth:0}}});
  await database.query('TRUNCATE agent_lead_replacements,agent_job_custody_audit,agent_job_custody,agent_job_checkins,agent_job_messages,agent_inbox_messages,agent_job_result_history,agent_jobs CASCADE');
 },60_000);
 afterAll(async()=>database.dispose());

 async function seedLead(suffix:string,leadStatus='error',children=3){
  const leadId=`lead-${suffix}`;const leadThread=`old-lead-${suffix}`;
  await database.query(`INSERT INTO agent_jobs(job_id,status,task_count,parent_channel,parent_thread_id,parent_agent_id,tasks) VALUES($1,$2,1,$3,$4,$5,$6::jsonb)`,[leadId,leadStatus,owner.channel,owner.threadId,owner.agentId,JSON.stringify([task('Lead',leadThread,leadStatus)])]);
  for(let index=0;index<children;index++)await database.query(`INSERT INTO agent_jobs(job_id,status,task_count,parent_channel,parent_thread_id,parent_agent_id,tasks) VALUES($1,'running',1,$2,$3,'coding-manager-sol',$4::jsonb)`,[`child-${suffix}-${index}`,owner.channel,leadThread,JSON.stringify([task(`Worker ${index+1}`,`worker-${suffix}-${index}`)])]);
  return {leadId,leadThread};
 }
 async function call(input:any,metadata:any={wsChannel:owner.channel,threadId:owner.threadId,agentId:owner.agentId,subAgentDepth:0}){const tool=await registry.createToolForCategory('agents','replace_lead');tool.setState({metadata});return tool.call(input);}

 it('covers handoff, retry idempotency, caller authorization, missing tasks, and disabled agents',async()=>{
  // risk: custody/result routing — a dead manager replacement must preserve every running worker.
  const {leadId}=await seedLead('h3');const result=await call({jobId:leadId,taskIndex:0,agentId:'coding-manager-sol'});expect(result.success).toBe(true);expect((result as any).result).toMatchObject({ok:true});
  const replacement=(result as any).result.replacement;const prompt=(result as any).result.prompt;expect(prompt).toContain('Your team: 3 workers');expect(prompt).toContain('Worker 1');
  const custody=await database.query<any>(`SELECT job_id,owner_thread_id FROM agent_job_custody WHERE job_id LIKE 'child-h3-%' ORDER BY job_id`);expect(custody).toHaveLength(3);expect(custody.every(row=>row.owner_thread_id===replacement.threadId)).toBe(true);
  for(let index=0;index<3;index++)await database.query(`INSERT INTO agent_inbox_messages(message_id,receiver_channel,receiver_thread_id,receiver_agent_id,sender,kind,body,ids) VALUES($1,$2,$3,'coding-manager-sol','worker','contract','done',$4::jsonb)`,[`return-h3-${index}`,owner.channel,replacement.threadId,JSON.stringify({jobId:`child-h3-${index}`,taskIndex:0})]);
  expect(await database.query<any>(`SELECT receiver_thread_id FROM agent_inbox_messages WHERE message_id LIKE 'return-h3-%'`)).toEqual(Array.from({length:3},()=>({receiver_thread_id:replacement.threadId})));

  // risk: authorization/operations — peers and invalid targets must not mutate another lead.
  const {leadId:refusedLead}=await seedLead('refuse');const peer=await call({jobId:refusedLead,taskIndex:0,agentId:'coding-manager-sol'},{wsChannel:'peer',threadId:'peer-thread',agentId:'peer-agent',subAgentDepth:1});expect(peer.success).toBe(false);expect(String(peer.result??peer.error)).toContain('coding-manager-sol');
  expect((await call({jobId:'missing',taskIndex:7,agentId:'coding-manager-sol'})).success).toBe(false);const disabled=await call({jobId:refusedLead,taskIndex:0,agentId:'disabled-agent'});expect(disabled.success).toBe(false);expect(String(disabled.result)).toContain('enabled agent');

  // risk: duplicate agents/side effects — a persisted launch retry must converge on one replacement.
  const {leadId:retryLead}=await seedLead('retry');failAfterPersist=true;expect((await call({jobId:retryLead,taskIndex:0,agentId:'coding-manager-sol'})).success).toBe(false);failAfterPersist=false;
  expect((await call({jobId:retryLead,taskIndex:0,agentId:'coding-manager-sol'})).success).toBe(true);expect(await database.query(`SELECT * FROM agent_jobs WHERE job_id LIKE 'replacement-%' AND parent_thread_id=$1`,[owner.threadId])).toHaveLength(2);expect(await database.query(`SELECT * FROM agent_job_checkins WHERE job_id=$1 AND step='lead-replaced'`,[retryLead])).toHaveLength(1);
 });
});
