// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import {Pool,type PoolClient} from 'pg';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {AgentJobCustodyRepository} from '../../../app/Repositories/AgentJobCustodyRepository';
import {JobCustodyAuthorityPolicy,type CustodyLineagePort,type CustodyOwnerLivenessPort} from '../../../app/Services/JobCustodyAuthorityPolicy';
import {JobCustodyService} from '../../../app/Services/JobCustodyService';
import {NoopCustodyChangeNotifier,type CustodyOwner} from '../../../app/Services/JobCustodyTypes';
import {TestDatabase} from '../../Support/TestDatabase';

class PgDatabase { constructor(private readonly pool:Pool){} async query<T=any>(sql:string,values:unknown[]=[]):Promise<T[]>{return (await this.pool.query(sql,values)).rows;} async transaction<T>(callback:(client:PoolClient)=>Promise<T>):Promise<T>{const client=await this.pool.connect();try{await client.query('BEGIN');const result=await callback(client);await client.query('COMMIT');return result;}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}} }
class Alive implements CustodyOwnerLivenessPort {async status(){return 'alive' as const;}}
class NoCycles implements CustodyLineagePort {async isAncestor(){return false;}async wouldCreateCycle(){return false;}}
class FixedClock {constructor(private readonly value:Date){}now(){return this.value;}}
const target:CustodyOwner={channel:'new-channel',threadId:'new-thread',agentId:'new-agent'};
const database=new TestDatabase(); const suite=TestDatabase.available()?describe:describe.skip; let pool:Pool;
const createJob=async(id:string)=>database.query(`INSERT INTO agent_jobs(job_id,status,task_count,parent_channel,parent_thread_id,parent_agent_id,tasks) VALUES($1,'running',1,'old-channel','old-thread','old-agent','[{"agentId":"worker","label":"worker","prompt":"work","status":"running","threadId":"worker-thread"}]'::jsonb)`,[id]);
const service=()=>new JobCustodyService(new AgentJobCustodyRepository(new PgDatabase(pool) as any),new JobCustodyAuthorityPolicy(new Alive(),new NoCycles()),new NoopCustodyChangeNotifier(),new FixedClock(new Date('2026-11-05T18:00:00Z')) as any);
const move=(instance:JobCustodyService,id:string)=>instance.move({jobId:id,to:target,actor:{kind:'human'},reason:'take custody'});

suite('AgentJobCustodyRepository',()=>{
 beforeAll(async()=>{await database.initialize();pool=new Pool({connectionString:database.appUrl()});}); afterAll(async()=>{await pool?.end();await database.dispose();});
 it('allows exactly one of two concurrent adopts and writes one audit row',async()=>{ // risk: concurrent ownership split
   const id=`custody-concurrent-${Date.now()}`;await createJob(id);const [a,b]=await Promise.all([move(service(),id),move(service(),id)]);expect([a.ok,b.ok].filter(Boolean)).toHaveLength(1);expect(await database.query(`SELECT * FROM agent_job_custody_audit WHERE job_id=$1`,[id])).toHaveLength(1);
 });
 it('moves a committed contract inbox row exactly once to the new owner',async()=>{ // risk: lost or duplicate contract
   const id=`custody-return-${Date.now()}`;await createJob(id);const messageId=`contract-${Date.now()}`;const returning=await pool.connect();await returning.query('BEGIN');
   await returning.query(`INSERT INTO agent_inbox_messages(message_id,receiver_channel,receiver_thread_id,receiver_agent_id,sender,kind,body,ids) VALUES($1,'old-channel','old-thread','old-agent','worker','contract','done',$2::jsonb)`,[messageId,JSON.stringify({messageId,jobId:id,taskIndex:0})]);
   const moving=move(service(),id);await new Promise(resolve=>setTimeout(resolve,20));await returning.query('COMMIT');returning.release();expect((await moving).ok).toBe(true);
   const rows=await database.query<any>(`SELECT * FROM agent_inbox_messages WHERE message_id=$1`,[messageId]);expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({receiver_channel:'new-channel',receiver_thread_id:'new-thread',receiver_agent_id:'new-agent'});
 });
 it('survives new repository instances and never re-addresses an acknowledged row',async()=>{ // risk: restart replay
   const id=`custody-restart-${Date.now()}`;await createJob(id);const delivered=`delivered-${Date.now()}`;await database.query(`INSERT INTO agent_inbox_messages(message_id,receiver_channel,receiver_thread_id,receiver_agent_id,sender,kind,body,ids,delivered_at) VALUES($1,'old-channel','old-thread','old-agent','worker','contract','done',$2::jsonb,now())`,[delivered,JSON.stringify({messageId:delivered,jobId:id})]);await move(service(),id);const restarted=service();expect(await restarted.resolveOwner(id)).toMatchObject(target);expect(await restarted.history(id)).toHaveLength(1);expect((await database.query<any>(`SELECT receiver_thread_id FROM agent_inbox_messages WHERE message_id=$1`,[delivered]))[0].receiver_thread_id).toBe('old-thread');
 });
 it('returns retryable without changing anything for an active foreign lease',async()=>{ // risk: stealing in-flight delivery
   const id=`custody-lease-${Date.now()}`;await createJob(id);const messageId=`leased-${Date.now()}`;await database.query(`INSERT INTO agent_inbox_messages(message_id,receiver_channel,receiver_thread_id,receiver_agent_id,sender,kind,body,ids,lease_owner,lease_expires_at) VALUES($1,'old-channel','old-thread','old-agent','worker','contract','done',$2::jsonb,'foreign',now()+interval '5 minutes')`,[messageId,JSON.stringify({messageId,jobId:id})]);expect(await move(service(),id)).toMatchObject({ok:false,code:'lease-active',retryable:true});expect(await database.query(`SELECT * FROM agent_job_custody WHERE job_id=$1`,[id])).toHaveLength(0);expect(await database.query(`SELECT * FROM agent_job_custody_audit WHERE job_id=$1`,[id])).toHaveLength(0);
 });
});
