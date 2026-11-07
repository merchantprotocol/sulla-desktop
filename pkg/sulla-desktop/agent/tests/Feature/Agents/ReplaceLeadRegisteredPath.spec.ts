// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import '../../Support/TestHomeEnv';
import {tmpdir} from 'node:os';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {TestDatabase} from '../../Support/TestDatabase';
import {CustodyTransactionBarrier} from '../../Support/ControlledAsyncBarrier';

vi.setConfig({testTimeout:15_000,hookTimeout:30_000});
vi.mock('electron',()=>({app:{getPath:()=>tmpdir(),getVersion:()=> '0.0.0-test',isPackaged:false},safeStorage:{}}));
vi.mock('../../../services/DecisionService',()=>({decisionService:{requiresApproval:vi.fn(async()=>false)}}));

class ReplacementRuntimeFixture {
 readonly entries=new Map<string,any>();
 failAfterPersist=false;
 adoptDuringLaunch?:()=>Promise<void>;
 reset(){this.entries.clear();this.failAfterPersist=false;this.adoptDuringLaunch=undefined;}
}
const runtime=new ReplacementRuntimeFixture();
vi.mock('../../../services/GraphRegistry',()=>({GraphRegistry:{get:(threadId:string)=>runtime.entries.get(threadId)??null}}));
vi.mock('../../../tools/agents/spawn_agent',async()=>{
 class ProcessBoundarySpawnAgentWorker {
  async runValidated(input:any,state:any){
   if(input.tasks[0].agentId!=='coding-manager-sol')return {successBoolean:false,responseString:'no enabled agent definition exists'};
   const {postgresClient}=await import('../../../database/PostgresClient');
   const label=String(input.tasks[0].label);const jobId=`replacement-${label.split(':').slice(-2).join('-')}`;
   const rows=await postgresClient.query<any>(`INSERT INTO agent_jobs(job_id,status,task_count,parent_channel,parent_thread_id,parent_agent_id,tasks,launch_key) VALUES($1,'running',1,$2,$3,$4,$5::jsonb,$6) ON CONFLICT (launch_key) WHERE launch_key IS NOT NULL DO NOTHING RETURNING job_id`,[jobId,state.metadata.wsChannel,state.metadata.threadId,state.metadata.agentId,JSON.stringify([{agentId:input.tasks[0].agentId,label,prompt:input.tasks[0].prompt,status:'running',threadId:`${jobId}-thread`}]),input.launchKey]);
   const persisted=rows[0]?.job_id??(await postgresClient.query<any>('SELECT job_id FROM agent_jobs WHERE launch_key=$1',[input.launchKey]))[0]?.job_id;
   await runtime.adoptDuringLaunch?.();
   if(runtime.failAfterPersist)throw new Error('simulated process disconnect after persist');
   return {successBoolean:true,responseString:'ok',result:{jobId:persisted}};
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
  process.env.SULLA_DATABASE_POOL_MAX='4';await database.initialize();
  process.env.SULLA_DATABASE_URL=database.appUrl();process.env.PGOPTIONS=`-csearch_path=${database.schema},public`;
  const {postgresClient}=await import('../../../database/PostgresClient');await postgresClient.initialize();await postgresClient.query(`SET search_path TO "${database.schema}", public`);
  await database.query(`INSERT INTO agent_definitions(id,slug,name,status,enabled) VALUES('test-coding-manager-sol','coding-manager-sol','Coding Manager Sol','production',TRUE) ON CONFLICT(slug) DO UPDATE SET status='production',enabled=TRUE`);
  const {ToolRegistry}=await import('../../../tools/registry');const {agentToolManifests}=await import('../../../tools/agents/manifests');registry=new ToolRegistry();registry.registerManifests(agentToolManifests.filter((manifest:any)=>['replace_lead','reassign_job','return_result'].includes(manifest.name)));
 },60_000);
 beforeEach(async()=>{
  runtime.reset();runtime.entries.set(owner.threadId,{state:{metadata:{wsChannel:owner.channel,threadId:owner.threadId,agentId:owner.agentId,subAgentDepth:0}}});
  await database.query('TRUNCATE agent_lead_replacements,agent_job_custody_audit,agent_job_custody,agent_job_checkins,agent_job_messages,agent_inbox_messages,agent_job_result_history,agent_jobs CASCADE');
 });
 afterAll(async()=>database.dispose());

 async function seedLead(suffix:string,leadStatus='error',children=3,parent=owner){
  const leadId=`lead-${suffix}`;const leadThread=`old-lead-${suffix}`;
  await database.query(`INSERT INTO agent_jobs(job_id,status,task_count,parent_channel,parent_thread_id,parent_agent_id,tasks) VALUES($1,$2,1,$3,$4,$5,$6::jsonb)`,[leadId,leadStatus,parent.channel,parent.threadId,parent.agentId,JSON.stringify([task('Lead',leadThread,leadStatus)])]);
  for(let index=0;index<children;index++)await seedChild(suffix,index,leadThread);
  return {leadId,leadThread};
 }
 async function seedChild(suffix:string,index:number,parentThread:string,status='running'){
  await database.query(`INSERT INTO agent_jobs(job_id,status,task_count,parent_channel,parent_thread_id,parent_agent_id,restart_resume_count,tasks) VALUES($1,$2,1,$3,$4,'coding-manager-sol',$5,$6::jsonb)`,[`child-${suffix}-${index}`,status,owner.channel,parentThread,status==='parked'?1:0,JSON.stringify([task(`Worker ${index+1}`,`worker-${suffix}-${index}`,status)])]);
 }
 async function call(input:any,metadata:any={wsChannel:owner.channel,threadId:owner.threadId,agentId:owner.agentId,subAgentDepth:0}){const tool=await registry.createToolForCategory('agents','replace_lead');tool.setState({metadata});return tool.call(input);}
 async function returnResult(threadId:string){const tool=await registry.createToolForCategory('agents','return_result');tool.setState({metadata:{wsChannel:owner.channel,threadId,agentId:'codex-sol-worker',subAgentDepth:2}});return tool.call({status:'completed',summary:'done',output:{head:'abc1234'}});}
 async function callAgent(name:string,input:any,metadata:any){const tool=await registry.createToolForCategory('agents',name);tool.setState({metadata});return tool.call(input);}

 it('H3 drains three real children and records their registered return_result contracts exactly once after reparenting',async()=>{
  // risk: custody/result routing — a dead manager replacement must preserve every running worker.
  const {leadId}=await seedLead('h3','error',3);const result=await call({jobId:leadId,taskIndex:0,agentId:'coding-manager-sol'});expect(result.success).toBe(true);
  const replacement=(result as any).result.replacement;expect((result as any).result.prompt).toContain('Your team: 3 workers');
  expect(await database.query<any>(`SELECT job_id FROM agent_job_custody WHERE job_id LIKE 'child-h3-%' AND owner_thread_id=$1`,[replacement.threadId])).toHaveLength(3);
  for(let index=0;index<3;index++){await database.query(`UPDATE agent_jobs SET status='parked',restart_resume_count=1,tasks=jsonb_set(tasks,'{0,status}','\"parked\"') WHERE job_id=$1`,[`child-h3-${index}`]);expect((await returnResult(`worker-h3-${index}`)).success).toBe(true);}
  expect(await database.query<any>(`SELECT job_id FROM agent_jobs WHERE job_id LIKE 'child-h3-%' AND tasks->0->>'returnedAt' IS NOT NULL ORDER BY job_id`)).toHaveLength(3);
  expect((await returnResult('worker-h3-0')).success).toBe(false);
  expect(await database.query<any>(`SELECT job_id FROM agent_jobs WHERE job_id LIKE 'child-h3-%' AND tasks->0->>'returnedAt' IS NOT NULL ORDER BY job_id`)).toHaveLength(3);
 });

 it('recovers a launch persisted before phase commit without creating a second lead',async()=>{
  // risk: duplicate side effects — a process disconnect must reuse the production launch key lookup.
  const {leadId}=await seedLead('retry','error',0);runtime.failAfterPersist=true;expect((await call({jobId:leadId,taskIndex:0,agentId:'coding-manager-sol'})).success).toBe(false);
  runtime.failAfterPersist=false;expect((await call({jobId:leadId,taskIndex:0,agentId:'coding-manager-sol'})).success).toBe(true);
  expect(await database.query(`SELECT job_id FROM agent_jobs WHERE job_id LIKE 'replacement-%'`)).toHaveLength(1);
  expect(await database.query(`SELECT * FROM agent_job_checkins WHERE job_id=$1 AND step='lead-replaced'`,[leadId])).toHaveLength(1);
  expect(await database.query<any>(`SELECT phase FROM agent_lead_replacements WHERE old_job_id=$1`,[leadId])).toEqual([{phase:'wrapped'}]);
 });

 it('atomically reserves one replacement when two registered callers race',async()=>{
  // risk: duplicate runners — database launch-key reservation, not process memory, chooses one winner.
  const {leadId}=await seedLead('concurrent','error',0);
  const [first,second]=await Promise.all([call({jobId:leadId,taskIndex:0,agentId:'coding-manager-sol'}),call({jobId:leadId,taskIndex:0,agentId:'coding-manager-sol'})]);
  expect(first.success).toBe(true);expect(second.success).toBe(true);
  expect(await database.query(`SELECT job_id FROM agent_jobs WHERE launch_key=$1`,[`lead-replacement:${leadId}:0`])).toHaveLength(1);
  expect(await database.query(`SELECT id FROM agent_job_checkins WHERE job_id=$1 AND step='lead-replaced'`,[leadId])).toHaveLength(1);
 });

 it('moves a child adopted after packet assembly before committing the zero-owner drain',async()=>{
  // risk: stranded children — a child appearing during launch must be included in the drain.
  const {leadId,leadThread}=await seedLead('adopted','error',0);runtime.adoptDuringLaunch=()=>seedChild('adopted',9,leadThread);
  const result=await call({jobId:leadId,taskIndex:0,agentId:'coding-manager-sol'});expect(result.success).toBe(true);
  const replacement=(result as any).result.replacement;
  expect(await database.query<any>(`SELECT owner_thread_id FROM agent_job_custody WHERE job_id='child-adopted-9' AND task_index=0`)).toEqual([{owner_thread_id:replacement.threadId}]);
  expect(await database.query<any>(`SELECT phase FROM agent_lead_replacements WHERE old_job_id=$1`,[leadId])).toEqual([{phase:'wrapped'}]);
 });

 it('redirects a registered incoming reparent after final zero and delivers its concurrent registered return once',async()=>{
  // risk: stranded result — adoption that starts during final drain must land on, and return to, the replacement.
  const {leadId,leadThread}=await seedLead('final-race','running',0);
  const childId='child-final-race-9',childThread='worker-final-race-9',oldManager='incoming-manager-final-race';
  runtime.entries.set(oldManager,{state:{metadata:{wsChannel:oldManager,threadId:oldManager,agentId:oldManager,subAgentDepth:0}}});
  await database.query(`INSERT INTO agent_jobs(job_id,status,task_count,parent_channel,parent_thread_id,parent_agent_id,restart_resume_count,tasks) VALUES($1,'parked',1,$2,$2,$2,1,$3::jsonb)`,[childId,oldManager,JSON.stringify([task('Incoming worker',childThread,'parked')])]);
  const {agentJobProvider}=await import('../../../app/Providers/AgentJobServiceProvider');const repository=(agentJobProvider.custody as any).repository;const originalObserver=repository.observer;const barrier=new CustodyTransactionBarrier();barrier.hold('producer','committing');
  runtime.adoptDuringLaunch=async()=>{repository.observer=barrier;};
  const replacing=call({jobId:leadId,taskIndex:0,agentId:'coding-manager-sol'});await barrier.waitFor('producer','committing');
  const reparenting=callAgent('reassign_job',{jobId:childId,taskIndex:0,to:leadThread,reason:'arrive at final drain'},{wsChannel:oldManager,threadId:oldManager,agentId:oldManager,subAgentDepth:1});
  await barrier.waitFor('move','locked');
  const returning=returnResult(childThread);expect(barrier.count('producer','locked')).toBe(1); // only replacement drain is locked; return waits on child custody
  barrier.release('producer','committing');
  const [replacementResult,reparentResult,returnResultReceipt]=await Promise.all([replacing,reparenting,returning]);repository.observer=originalObserver;
  expect(replacementResult.success).toBe(true);expect(reparentResult.success).toBe(true);expect(returnResultReceipt.success).toBe(true);
  const replacement=(replacementResult as any).result.replacement;
  const currentOwner=await agentJobProvider.custody.resolveOwner(childId,0);
  expect(currentOwner).toMatchObject({channel:'coding-manager-sol',threadId:replacement.threadId,agentId:'coding-manager-sol'});
  expect(await database.query(`SELECT job_id FROM agent_job_result_history WHERE job_id=$1 AND task_index=0`,[childId])).toHaveLength(1);
  const deliveries=await database.query<any>(`SELECT tasks->0->>'completionDeliveredAt' AS delivered_at FROM agent_jobs WHERE job_id=$1`,[childId]);
  expect(deliveries).toHaveLength(1);expect(deliveries[0].delivered_at).toBeTruthy();
 });

 it('uses wrap_up for a live lead and stale replay keeps one audit and one queued stop message',async()=>{
  // risk: irreversible stop — replacement must request graceful wrap-up, never hard-stop a live lead.
  const {leadId}=await seedLead('live','running',0);const first=await call({jobId:leadId,taskIndex:0,agentId:'coding-manager-sol'});expect(first.success).toBe(true);
  expect((await database.query<any>(`SELECT status FROM agent_jobs WHERE job_id=$1`,[leadId]))[0].status).toBe('running');
  expect(await database.query<any>(`SELECT id FROM agent_job_messages WHERE job_id=$1 AND message LIKE '[Stop requested by %'`,[leadId])).toHaveLength(1);
  expect((await call({jobId:leadId,taskIndex:0,agentId:'coding-manager-sol'})).success).toBe(true);
  expect(await database.query<any>(`SELECT id FROM agent_job_messages WHERE job_id=$1 AND message LIKE '[Stop requested by %'`,[leadId])).toHaveLength(1);
  expect(await database.query<any>(`SELECT id FROM agent_job_checkins WHERE job_id=$1 AND step='lead-replaced'`,[leadId])).toHaveLength(1);
 });

 it('recovers a crash after wrap_up request with one effective stop and audit',async()=>{
  // risk: irreversible stop — retry after the request commits must not duplicate the stop side effect.
  const {leadId}=await seedLead('wrap-crash','running',0);
  await database.query(`CREATE FUNCTION reject_wrapped_phase() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.phase='wrapped' THEN RAISE EXCEPTION 'simulated crash after wrap_up'; END IF; RETURN NEW; END $$`);
  await database.query(`CREATE TRIGGER reject_wrapped_phase BEFORE UPDATE ON agent_lead_replacements FOR EACH ROW EXECUTE FUNCTION reject_wrapped_phase()`);
  const crashed=await call({jobId:leadId,taskIndex:0,agentId:'coding-manager-sol'});expect(crashed.success).toBe(false);expect(JSON.stringify(crashed.error??crashed.result)).toContain('simulated crash after wrap_up');
  await database.query(`DROP TRIGGER reject_wrapped_phase ON agent_lead_replacements`);await database.query(`DROP FUNCTION reject_wrapped_phase()`);
  expect((await call({jobId:leadId,taskIndex:0,agentId:'coding-manager-sol'})).success).toBe(true);
  expect(await database.query(`SELECT id FROM agent_job_messages WHERE job_id=$1 AND message LIKE '[Stop requested by %'`,[leadId])).toHaveLength(1);
  expect(await database.query(`SELECT id FROM agent_job_checkins WHERE job_id=$1 AND step='lead-replaced'`,[leadId])).toHaveLength(1);
 });

 it('allows the owner, refuses a peer by owner name, and distinguishes missing task/job and disabled agent',async()=>{
  // risk: authorization — only verified custody owners/ancestors may replace a live lead.
  const {leadId}=await seedLead('auth','running',0);const peer=await call({jobId:leadId,taskIndex:0,agentId:'coding-manager-sol'},{wsChannel:'peer',threadId:'peer-thread',agentId:'peer-agent',subAgentDepth:1});expect(peer.success).toBe(false);expect(JSON.stringify(peer.result??peer.error)).toContain('coding-manager-sol');
  expect((await call({jobId:leadId,taskIndex:7,agentId:'coding-manager-sol'})).success).toBe(false);expect((await call({jobId:'missing',taskIndex:0,agentId:'coding-manager-sol'})).success).toBe(false);
  const disabled=await call({jobId:leadId,taskIndex:0,agentId:'disabled-agent'});expect(disabled.success).toBe(false);expect(JSON.stringify(disabled.result??disabled.error)).toContain('enabled agent');
 });

 it('allows a verified custody ancestor to replace a descendant lead',async()=>{
  // risk: recovery authority — a manager's manager must recover a failed descendant without peer privilege.
  const middle={channel:'middle-manager',threadId:'middle-manager-thread',agentId:'middle-manager'};
  await database.query(`INSERT INTO agent_jobs(job_id,status,task_count,parent_channel,parent_thread_id,parent_agent_id,tasks) VALUES('middle-manager-job','running',1,$1,$2,$3,$4::jsonb)`,[owner.channel,owner.threadId,owner.agentId,JSON.stringify([task('Middle manager',middle.threadId,'running')])]);
  const {leadId}=await seedLead('ancestor','error',0,middle);
  const result=await call({jobId:leadId,taskIndex:0,agentId:'coding-manager-sol'});
  expect(result,JSON.stringify(result)).toMatchObject({success:true});
 });
});
