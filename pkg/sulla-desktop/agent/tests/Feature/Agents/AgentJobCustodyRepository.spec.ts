// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import {Pool,type PoolClient} from 'pg';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {AgentJobCustodyRepository} from '../../../app/Repositories/AgentJobCustodyRepository';
import {JobCustodyAuthorityPolicy,TopLevelHumanSessionAuthorityRule,type CustodyLineagePort,type CustodyOwnerLivenessPort} from '../../../app/Services/JobCustodyAuthorityPolicy';
import {JobCustodyService} from '../../../app/Services/JobCustodyService';
import {CustodyCallerVerifier,VerifiedCustodyActor,type TopLevelConversationRegistry} from '../../../app/Services/CustodyCallerVerifier';
import {NoopCustodyChangeNotifier,type CustodyOwner} from '../../../app/Services/JobCustodyTypes';
import {TestDatabase} from '../../Support/TestDatabase';
import {ControlledAsyncBarrier} from '../../Support/ControlledAsyncBarrier';

class PgDatabase { constructor(private readonly pool:Pool){} async query<T=any>(sql:string,values:unknown[]=[]):Promise<T[]>{return (await this.pool.query(sql,values)).rows;} async transaction<T>(callback:(client:PoolClient)=>Promise<T>):Promise<T>{const client=await this.pool.connect();try{await client.query('BEGIN');const result=await callback(client);await client.query('COMMIT');return result;}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}} }
class Alive implements CustodyOwnerLivenessPort {async status(){return 'alive' as const;}}
class NoCycles implements CustodyLineagePort {async isAncestor(){return false;}async wouldCreateCycle(){return false;}}
class RegisteredConversations implements TopLevelConversationRegistry {constructor(private readonly entries:Set<string>){}async isRegisteredTopLevel(channel:string,threadId:string,agentId:string){return this.entries.has(`${channel}/${threadId}/${agentId}`);}}
class EmptyTaskLocator {async findTaskByThread(){return undefined;}}
class FixedClock {constructor(private readonly value:Date){}now(){return this.value;}}
const target:CustodyOwner={channel:'new-channel',threadId:'new-thread',agentId:'new-agent'};
const database=new TestDatabase(); const suite=TestDatabase.available()?describe:describe.skip; let pool:Pool;
const createJob=async(id:string,taskCount=1)=>database.query(`INSERT INTO agent_jobs(job_id,status,task_count,parent_channel,parent_thread_id,parent_agent_id,tasks) VALUES($1,'running',$2,'old-channel','old-thread','old-agent',$3::jsonb)`,[id,taskCount,JSON.stringify(Array.from({length:taskCount},(_,index)=>({agentId:`worker-${index}`,label:`worker-${index}`,prompt:'work',status:'running',threadId:`${id}-worker-${index}`})))]);
const service=()=>new JobCustodyService(new AgentJobCustodyRepository(new PgDatabase(pool) as any),new JobCustodyAuthorityPolicy(new Alive(),new NoCycles()),new NoopCustodyChangeNotifier(),new FixedClock(new Date('2026-11-05T18:00:00Z')) as any);
const human=VerifiedCustodyActor.humanForUiIpc();
const move=(instance:JobCustodyService,id:string)=>instance.move({jobId:id,to:target,actor:human,reason:'take custody'});

suite('AgentJobCustodyRepository',()=>{
 beforeAll(async()=>{await database.initialize();pool=new Pool({connectionString:database.appUrl()});}); afterAll(async()=>{await pool?.end();await database.dispose();});
 it('allows exactly one of two concurrent adopts and writes one audit row',async()=>{ // risk: concurrent ownership split
   const id=`custody-concurrent-${Date.now()}`;await createJob(id);const [a,b]=await Promise.all([move(service(),id),move(service(),id)]);expect([a.ok,b.ok].filter(Boolean)).toHaveLength(1);expect(await database.query(`SELECT * FROM agent_job_custody_audit WHERE job_id=$1`,[id])).toHaveLength(1);
 });
 it('serializes an incoming adoption behind the final zero-child drain gate and redirects it',async()=>{ // risk: child stranded after final enumeration
   const suffix=Date.now();const leadId=`draining-lead-${suffix}`;const childId=`incoming-child-${suffix}`;await createJob(leadId);await createJob(childId);
   const oldLeadThread=`${leadId}-worker-0`;const replacementThread=`replacement-${suffix}`;
   await database.query(`INSERT INTO agent_lead_replacements(old_job_id,old_task_index,launch_key,replacement_agent_id,replacement_job_id,replacement_task_index,replacement_thread_id,phase) VALUES($1,0,$2,'replacement-agent',$3,0,$4,'launched')`,[leadId,`lead-replacement:${leadId}:0`,`replacement-job-${suffix}`,replacementThread]);
   const drain=await pool.connect();await drain.query('BEGIN');await drain.query(`SELECT * FROM agent_lead_replacements WHERE old_job_id=$1 AND old_task_index=0 FOR UPDATE`,[leadId]);
   expect(await drain.query(`SELECT j.job_id FROM agent_jobs j CROSS JOIN LATERAL jsonb_array_elements(j.tasks) WITH ORDINALITY task(value,ordinality) LEFT JOIN agent_job_custody c ON c.job_id=j.job_id AND c.task_index=(task.ordinality-1) WHERE COALESCE(c.owner_thread_id,j.parent_thread_id)=$1`,[oldLeadThread]).then(result=>result.rows)).toHaveLength(0);
   const adopting=service().move({jobId:childId,taskIndex:0,to:{channel:'old-channel',threadId:oldLeadThread,agentId:'worker-0'},actor:human,reason:'arrives during final drain'});
   await new Promise(resolve=>setTimeout(resolve,20));
   await drain.query(`UPDATE agent_lead_replacements SET phase='children_moved' WHERE old_job_id=$1`,[leadId]);await drain.query('COMMIT');drain.release();
   expect(await adopting).toMatchObject({ok:true,current:{threadId:replacementThread,agentId:'replacement-agent'}});
   expect(await database.query<any>(`SELECT owner_thread_id FROM agent_job_custody WHERE job_id=$1 AND task_index=0`,[childId])).toEqual([{owner_thread_id:replacementThread}]);
 });
 it('allows only a positively verified top-level chat to adopt from a live top-level owner and audits it',async()=>{ // risk: spoofed cross-chat custody theft
   const id=`custody-verified-top-level-${Date.now()}`;await createJob(id);const conversations=new RegisteredConversations(new Set(['caller-channel/caller-thread/caller-agent','old-channel/old-thread/old-agent']));const verifier=new CustodyCallerVerifier(new EmptyTaskLocator() as any,conversations);const verified=await verifier.verify({wsChannel:'caller-channel',threadId:'caller-thread',agentId:'caller-agent',subAgentDepth:0});const repository=new AgentJobCustodyRepository(new PgDatabase(pool) as any);const instance=new JobCustodyService(repository,new JobCustodyAuthorityPolicy(new Alive(),new NoCycles(),new TopLevelHumanSessionAuthorityRule(conversations)),new NoopCustodyChangeNotifier(),new FixedClock(new Date('2026-11-05T18:00:00Z')) as any);
   expect(await instance.move({jobId:id,to:target,actor:verified,reason:'verified cross-chat adoption'})).toMatchObject({ok:true});expect((await instance.history(id))[0]).toMatchObject({reason:'verified cross-chat adoption',actor:{kind:'agent',threadId:'caller-thread'}});
 });
 it('forbids fabricated and delegated callers from the live-owner top-level exception',async()=>{ // risk: fabricated principal
   for(const [suffix,conversations,context] of [['unregistered',new RegisteredConversations(new Set(['old-channel/old-thread/old-agent'])),{wsChannel:'fake',threadId:'never-registered',agentId:'fake',subAgentDepth:0}],['delegated',new RegisteredConversations(new Set(['caller-channel/caller-thread/caller-agent','old-channel/old-thread/old-agent'])),{wsChannel:'caller-channel',threadId:'caller-thread',agentId:'caller-agent',subAgentDepth:1}] ] as const){const id=`custody-${suffix}-${Date.now()}`;await createJob(id);const actor=await new CustodyCallerVerifier(new EmptyTaskLocator() as any,conversations).verify(context);const instance=new JobCustodyService(new AgentJobCustodyRepository(new PgDatabase(pool) as any),new JobCustodyAuthorityPolicy(new Alive(),new NoCycles(),new TopLevelHumanSessionAuthorityRule(conversations)),new NoopCustodyChangeNotifier(),new FixedClock(new Date('2026-11-05T18:00:00Z')) as any);expect(await instance.move({jobId:id,to:target,actor,reason:'must refuse'})).toMatchObject({ok:false,code:'forbidden'});expect(await instance.history(id)).toHaveLength(0);}
 });
 it('documents that a producer bypassing withOwner can commit a stale receiver',async()=>{ // risk: lost or duplicate contract
   const id=`custody-return-${Date.now()}`;await createJob(id);const messageId=`contract-${Date.now()}`;const returning=await pool.connect();await returning.query('BEGIN');
   await returning.query(`INSERT INTO agent_inbox_messages(message_id,receiver_channel,receiver_thread_id,receiver_agent_id,sender,kind,body,ids) VALUES($1,'old-channel','old-thread','old-agent','worker','contract','done',$2::jsonb)`,[messageId,JSON.stringify({messageId,jobId:id,taskIndex:0})]);
   const moving=move(service(),id);await new Promise(resolve=>setTimeout(resolve,20));await returning.query('COMMIT');returning.release();expect((await moving).ok).toBe(true);
   const rows=await database.query<any>(`SELECT * FROM agent_inbox_messages WHERE message_id=$1`,[messageId]);expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({receiver_channel:'old-channel',receiver_thread_id:'old-thread',receiver_agent_id:'old-agent'}); // This is the hazard PR B removes by routing every producer through withOwner.
 });

 it('keeps task-overridden inbox rows with their effective owner during a whole-job move',async()=>{ // risk: cross-scope custody theft
   const id=`custody-scope-${Date.now()}`;await createJob(id,2);const instance=service();const taskOwner:CustodyOwner={channel:'task-channel',threadId:'task-thread',agentId:'task-agent'};
   expect((await instance.move({jobId:id,taskIndex:1,to:taskOwner,actor:human,reason:'move task'})).ok).toBe(true);
   const taskMessage=`task-message-${Date.now()}`;const jobMessage=`job-message-${Date.now()}`;
   await database.query(`INSERT INTO agent_inbox_messages(message_id,receiver_channel,receiver_thread_id,receiver_agent_id,sender,kind,body,ids) VALUES($1,$2,$3,$4,'worker','contract','done',$5::jsonb),($6,'old-channel','old-thread','old-agent','worker','contract','done',$7::jsonb)`,[taskMessage,taskOwner.channel,taskOwner.threadId,taskOwner.agentId,JSON.stringify({jobId:id,taskIndex:1}),jobMessage,JSON.stringify({jobId:id,taskIndex:0})]);
   expect((await move(instance,id)).ok).toBe(true);const rows=await database.query<any>(`SELECT message_id,receiver_thread_id FROM agent_inbox_messages WHERE message_id=ANY($1) ORDER BY message_id`,[[jobMessage,taskMessage]]);expect(rows.find(row=>row.message_id===taskMessage)?.receiver_thread_id).toBe(taskOwner.threadId);expect(rows.find(row=>row.message_id===jobMessage)?.receiver_thread_id).toBe(target.threadId);
 });
 it('resolves and inserts for the new owner inside the shared producer lock',async()=>{ // risk: contract sent to stale owner
   const id=`custody-producer-${Date.now()}`;await createJob(id);const instance=service();const stale=await instance.resolveOwner(id);expect(stale?.threadId).toBe('old-thread');expect((await move(instance,id)).ok).toBe(true);const messageId=`locked-producer-${Date.now()}`;
   await instance.withOwner(id,0,async(client,owner)=>{await client.query(`INSERT INTO agent_inbox_messages(message_id,receiver_channel,receiver_thread_id,receiver_agent_id,sender,kind,body,ids) VALUES($1,$2,$3,$4,'worker','contract','done',$5::jsonb)`,[messageId,owner.channel,owner.threadId,owner.agentId,JSON.stringify({jobId:id,taskIndex:0})]);});
   const rows=await database.query<any>(`SELECT * FROM agent_inbox_messages WHERE message_id=$1`,[messageId]);expect(rows).toHaveLength(1);expect(rows[0].receiver_thread_id).toBe(target.threadId);
 });
 it('routes a manager worker result and manager contract exactly once during adoption',async()=>{ // risk: cross-scope result loss during H8 adoption
   const id=`custody-adoption-race-${Date.now()}`;await createJob(id,2);const instance=service();const manager:CustodyOwner={channel:'manager-channel',threadId:'manager-thread',agentId:'manager-agent'};
   expect((await instance.move({jobId:id,taskIndex:1,to:manager,actor:human,reason:'manager owns worker'})).ok).toBe(true);
   const workerResult=`worker-result-${Date.now()}`;const managerContract=`manager-contract-${Date.now()}`;
   const adoption=move(instance,id);
   const workerReturn=instance.withOwner(id,1,async(client,owner)=>client.query(`INSERT INTO agent_inbox_messages(message_id,receiver_channel,receiver_thread_id,receiver_agent_id,sender,kind,body,ids) VALUES($1,$2,$3,$4,'worker','contract','worker done',$5::jsonb)`,[workerResult,owner.channel,owner.threadId,owner.agentId,JSON.stringify({jobId:id,taskIndex:1})]));
   const managerReturn=instance.withOwner(id,undefined,async(client,owner)=>client.query(`INSERT INTO agent_inbox_messages(message_id,receiver_channel,receiver_thread_id,receiver_agent_id,sender,kind,body,ids) VALUES($1,$2,$3,$4,'manager','contract','manager done',$5::jsonb)`,[managerContract,owner.channel,owner.threadId,owner.agentId,JSON.stringify({jobId:id})]));
   expect((await adoption).ok).toBe(true);await Promise.all([workerReturn,managerReturn]);
   const rows=await database.query<any>(`SELECT message_id,receiver_thread_id FROM agent_inbox_messages WHERE message_id=ANY($1)`,[[workerResult,managerContract]]);expect(rows).toHaveLength(2);expect(rows.filter(row=>row.message_id===workerResult)).toEqual([{message_id:workerResult,receiver_thread_id:manager.threadId}]);expect(rows.filter(row=>row.message_id===managerContract)).toEqual([{message_id:managerContract,receiver_thread_id:target.threadId}]);
 });
 it('commits deterministic owner notices and worker manager-change messages with custody',async()=>{ // risk: durable handoff notification loss
   const id=`custody-notices-${Date.now()}`;await createJob(id,2);const instance=service();expect((await move(instance,id)).ok).toBe(true);
   const notices=await database.query<any>(`SELECT message_id,receiver_thread_id,delivered_at FROM agent_inbox_messages WHERE message_id LIKE $1 ORDER BY message_id`,[`custody:${id}:job:1:%`]);
   expect(notices).toEqual([
     {message_id:`custody:${id}:job:1:new`,receiver_thread_id:target.threadId,delivered_at:null},
     {message_id:`custody:${id}:job:1:old`,receiver_thread_id:'old-thread',delivered_at:null},
   ]);
   const workerMessages=await database.query<any>(`SELECT id,task_index,message FROM agent_job_messages WHERE id LIKE $1 ORDER BY task_index`,[`custody:${id}:job:1:worker:%`]);
   expect(workerMessages).toHaveLength(2);expect(workerMessages.map(row=>row.task_index)).toEqual([0,1]);expect(workerMessages.every(row=>row.message.includes('new-agent/new-channel'))).toBe(true);
   const restarted=service();expect(await restarted.resolveOwner(id)).toMatchObject(target);expect(await database.query(`SELECT message_id FROM agent_inbox_messages WHERE message_id LIKE $1`,[`custody:${id}:job:1:%`])).toHaveLength(2);
 });
 it('returns a committed move when best-effort notification dispatch fails',async()=>{ // risk: retry duplicates after a committed handoff
   const id=`custody-notifier-failure-${Date.now()}`;await createJob(id);const repository=new AgentJobCustodyRepository(new PgDatabase(pool) as any);
   const barrier=new ControlledAsyncBarrier();barrier.release();const notifier={changed:async()=>{await barrier.enterAndWait();throw new Error('simulated process-local dispatcher failure');}};
   const instance=new JobCustodyService(repository,new JobCustodyAuthorityPolicy(new Alive(),new NoCycles()),notifier,new FixedClock(new Date('2026-11-05T18:00:00Z')) as any);
   expect(await move(instance,id)).toMatchObject({ok:true});expect(await instance.history(id)).toHaveLength(1);
   expect(await database.query(`SELECT message_id FROM agent_inbox_messages WHERE message_id LIKE $1`,[`custody:${id}:job:1:%`])).toHaveLength(2);
 });
 it('survives new repository instances and never re-addresses an acknowledged row',async()=>{ // risk: restart replay
   const id=`custody-restart-${Date.now()}`;await createJob(id);const delivered=`delivered-${Date.now()}`;await database.query(`INSERT INTO agent_inbox_messages(message_id,receiver_channel,receiver_thread_id,receiver_agent_id,sender,kind,body,ids,delivered_at) VALUES($1,'old-channel','old-thread','old-agent','worker','contract','done',$2::jsonb,now())`,[delivered,JSON.stringify({messageId:delivered,jobId:id})]);await move(service(),id);const restarted=service();expect(await restarted.resolveOwner(id)).toMatchObject(target);expect(await restarted.history(id)).toHaveLength(1);expect((await database.query<any>(`SELECT receiver_thread_id FROM agent_inbox_messages WHERE message_id=$1`,[delivered]))[0].receiver_thread_id).toBe('old-thread');
 });
 it('returns retryable without changing anything for an active foreign lease',async()=>{ // risk: stealing in-flight delivery
   const id=`custody-lease-${Date.now()}`;await createJob(id);const messageId=`leased-${Date.now()}`;await database.query(`INSERT INTO agent_inbox_messages(message_id,receiver_channel,receiver_thread_id,receiver_agent_id,sender,kind,body,ids,lease_owner,lease_expires_at) VALUES($1,'old-channel','old-thread','old-agent','worker','contract','done',$2::jsonb,'foreign',now()+interval '5 minutes')`,[messageId,JSON.stringify({messageId,jobId:id})]);expect(await move(service(),id)).toMatchObject({ok:false,code:'lease-active',retryable:true});expect(await database.query(`SELECT * FROM agent_job_custody WHERE job_id=$1`,[id])).toHaveLength(0);expect(await database.query(`SELECT * FROM agent_job_custody_audit WHERE job_id=$1`,[id])).toHaveLength(0);
 });
});
