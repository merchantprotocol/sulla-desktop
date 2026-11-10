// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import '../../Support/TestHomeEnv';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {Pool,type PoolClient} from 'pg';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {GuestProviderExecutionTransport} from '../../../languagemodels/ProviderExecutionTransport';
import {taskExecutionIdentityScope} from '../../../app/Services/TaskExecutionIdentityScope';
import {JobWrapUpRepository} from '../../../app/Repositories/JobWrapUpRepository';
import {TaskExecutionIdentityRepository,type TaskExecutionDiscoveryHandle,type TaskExecutionIdentity,type TaskExecutionIdentityInput} from '../../../app/Repositories/TaskExecutionIdentityRepository';
import {ConfirmedTaskTeardownService,type TaskExecutionTerminationTransport} from '../../../app/Services/ConfirmedTaskTeardownService';
import {JobRuntimeRegistry} from '../../../app/Services/JobRuntimeRegistry';
import {LaunchingTaskExecutionReconciler,type TaskExecutionDiscoveryTransport} from '../../../app/Services/LaunchingTaskExecutionReconciler';
import {JobWrapUpService,type JobWrapUpTimer} from '../../../app/Services/JobWrapUpService';
import {PlatformTaskExecutionTerminationTransport} from '../../../app/Services/PlatformTaskExecutionTerminationTransport';
import type {TaskTeardownOutcome} from '../../../app/Services/TaskTeardownPort';
import {TestDatabase} from '../../Support/TestDatabase';

class PgConnection {
  constructor(private readonly pool:Pool){}
  async query<T=any>(sql:string,parameters:unknown[]=[]):Promise<T[]>{return (await this.pool.query(sql,parameters)).rows;}
  async transaction<T>(action:(client:PoolClient)=>Promise<T>):Promise<T>{const client=await this.pool.connect();try{await client.query('BEGIN');const result=await action(client);await client.query('COMMIT');return result;}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}}
}
class SequencedTerminationBoundary implements TaskExecutionTerminationTransport {
  readonly calls:TaskExecutionIdentity[]=[];
  constructor(private readonly outcomes:TaskTeardownOutcome[]){}
  async terminate(identity:TaskExecutionIdentity):Promise<TaskTeardownOutcome>{this.calls.push(identity);return this.outcomes.shift()??'unavailable';}
}
class DiscoveryBoundary implements TaskExecutionDiscoveryTransport {
  readonly calls:TaskExecutionDiscoveryHandle[]=[];
  constructor(private readonly result?:TaskExecutionIdentityInput){}
  async discover(handle:TaskExecutionDiscoveryHandle):Promise<TaskExecutionIdentityInput|undefined>{this.calls.push(handle);return this.result;}
}
class ConfirmedStopBoundary {
  constructor(private readonly teardown:ConfirmedTaskTeardownService){}
  teardownTask(jobId:string,taskIndex:number,generation:string){return this.teardown.teardown(jobId,taskIndex,generation);}
  applyDurableStop(_jobId:string,write:()=>Promise<boolean>){return write();}
}
class ManualTimer implements JobWrapUpTimer {
  readonly callbacks:Array<()=>void>=[];
  schedule(_delayMs:number,callback:()=>void){this.callbacks.push(callback);return callback as unknown as ReturnType<typeof setTimeout>;}
  cancel(handle:ReturnType<typeof setTimeout>){const index=this.callbacks.indexOf(handle as unknown as ()=>void);if(index>=0)this.callbacks.splice(index,1);}
  async runNext(){const callback=this.callbacks.shift();callback?.();await new Promise(resolve=>setImmediate(resolve));}
}
class ContainerBoundary {
  readonly removed:string[]=[];
  constructor(private readonly inspected:any|Error){}
  async inspect(){if(this.inspected instanceof Error)throw this.inspected;return this.inspected;}
  async remove(id:string){this.removed.push(id);}
}
class GuestBoundary {
  readonly calls:string[][]=[];
  constructor(private readonly error?:Error&{exitCode?:number}){}
  async run(args:string[]){this.calls.push(args);if(this.error)throw this.error;return {stdout:'',stderr:''};}
}

class SpawnedProcess extends EventEmitter {
  readonly stdout=new PassThrough();readonly stderr=new PassThrough();readonly stdin=new PassThrough();killed=false;
  kill(){this.killed=true;return true;}unref(){}
}
class GuestSpawnBoundary {
  readonly wrapper=new SpawnedProcess();
  spawn(_command:string,args:string[]){const child=args.includes('cat')?new SpawnedProcess():this.wrapper;queueMicrotask(()=>{if(args.includes('cat')){child.stdout.end('4321 9911');child.emit('close',0);}else child.emit('spawn');});return child as any;}
}
class ActivationFailingIdentityStore extends TaskExecutionIdentityRepository {
  readonly failed:string[]=[];
  override async activate():Promise<any>{throw new Error('activation write unavailable');}
  override async failLaunch(_reservation:any,reason:string):Promise<void>{this.failed.push(reason);}
}

const database=new TestDatabase();
const suite=TestDatabase.available()?describe:process.env.CI?describe:describe.skip;
let pool:Pool;let connection:PgConnection;let identities:TaskExecutionIdentityRepository;let wraps:JobWrapUpRepository;
const principal={kind:'agent' as const,agentId:'manager',threadId:'manager-thread'};
const task=(status='running')=>({agentId:'codex-sol-worker',label:'worker',prompt:'work',status,threadId:'worker-thread'});

suite('confirmed task teardown durability with real Postgres repositories',()=>{
  beforeAll(async()=>{await database.initialize();pool=new Pool({connectionString:database.appUrl()});connection=new PgConnection(pool);identities=new TaskExecutionIdentityRepository(connection as any);wraps=new JobWrapUpRepository(connection as any);});
  beforeEach(async()=>database.query('TRUNCATE agent_job_wrap_up_requests,agent_task_execution_identities,agent_jobs CASCADE'));
  afterAll(async()=>{await pool?.end();await database.dispose();});

  async function seedJob(id:string,status='running'){await database.query(`INSERT INTO agent_jobs(job_id,status,task_count,parent_channel,parent_thread_id,parent_agent_id,tasks) VALUES($1,$2,1,'sulla-desktop','manager-thread','manager',$3::jsonb)`,[id,status,JSON.stringify([task(status)])]);}
  async function activateContainer(jobId:string,containerId:string){const reservation=await identities.reserveLaunch(jobId,0);return identities.activate(reservation,{kind:'container',containerId,containerName:`sulla-agent-${jobId}-0`,labels:{'com.sulla.job-id':jobId,'com.sulla.task-index':'0'}});}
  function service(boundary:SequencedTerminationBoundary,timer=new ManualTimer()){const runtime=new JobRuntimeRegistry();expect(runtime.abortScopes.size).toBe(0);const teardown=new ConfirmedTaskTeardownService(identities,boundary);return {runtime,timer,wrapUp:new JobWrapUpService(new ConfirmedStopBoundary(teardown) as any,{send:async()=>undefined},timer,wraps,identities)};}

  it('keeps the production guest spawn reservation discoverable when activation persistence fails',async()=>{
    // risk: orphan process — an activation write failure after external spawn must not retire the pidfile reservation or kill only its wrapper.
    await seedJob('guest-activation-failure');const store=new ActivationFailingIdentityStore(connection as any);const processes=new GuestSpawnBoundary();const transport=new GuestProviderExecutionTransport(processes as any);
    await expect(taskExecutionIdentityScope.run({jobId:'guest-activation-failure',taskIndex:0,store},()=>transport.spawn({context:{runtime:'guest',provider:'codex',conversationId:'conversation',auth:{kind:'guest-host'}},providerCommand:{executable:'unused',args:[]},guestCommand:{executable:'sulla-runtime',args:['launch']},remotePidFile:'/run/sulla/guest.pid'}))).rejects.toThrow('activation write unavailable');
    expect(store.failed).toEqual([]);expect(processes.wrapper.killed).toBe(false);
    expect((await identities.launching()).some(launch=>launch.jobId==='guest-activation-failure'&&launch.discoveryHandle?.kind==='vm-process')).toBe(true);
  });

  it('recovers a durable generation with a fresh runtime whose abortScopes are empty',async()=>{
    // risk: orphan process — restart recovery must use durable launch identity, never a synthetic AbortScope.
    const jobId='durable-recovery';await seedJob(jobId);const identity=await activateContainer(jobId,'container-durable');
    await wraps.reserveCurrent({jobId,taskIndex:0,principal,reason:'replace lead',dueAt:new Date(0)});
    const boundary=new SequencedTerminationBoundary(['confirmed']);const recovered=service(boundary);await recovered.wrapUp.recover();
    expect(recovered.runtime.abortScopes.size).toBe(0);expect(boundary.calls).toEqual([identity]);
    expect(await database.query<any>(`SELECT execution_generation,teardown_acknowledged_at IS NOT NULL AS acknowledged,completed_at IS NOT NULL AS completed FROM agent_job_wrap_up_requests WHERE job_id=$1`,[jobId])).toEqual([{execution_generation:identity.generation,acknowledged:true,completed:true}]);
  });

  it('selects the reopened replacement generation under the same advisory lock as reservation',async()=>{
    // risk: wrong-process kill — a stop racing reopen must never retain the superseded generation.
    const jobId='reservation-reopen-race';await seedJob(jobId);const oldIdentity=await activateContainer(jobId,'container-old');
    const blocker=await pool.connect();await blocker.query('BEGIN');await blocker.query(`SELECT pg_advisory_xact_lock(hashtext($1),$2)`,[jobId,0]);
    const reserving=wraps.reserveCurrent({jobId,taskIndex:0,principal,reason:'race reopen',dueAt:new Date(0)});
    await blocker.query(`INSERT INTO agent_task_execution_identities(job_id,task_index,generation,launch_state,identity,activated_at) VALUES($1,0,'replacement-generation','active',$2::jsonb,now()+interval '1 second')`,[jobId,JSON.stringify({kind:'container',generation:'replacement-generation',containerId:'container-new',containerName:'replacement',labels:{}})]);
    await blocker.query('COMMIT');blocker.release();
    const reservation=await reserving;expect(reservation.request?.executionGeneration).toBe('replacement-generation');expect(reservation.request?.executionGeneration).not.toBe(oldIdentity.generation);
  });

  it('retries transient external unavailability and acknowledges only after confirmed exit',async()=>{
    // risk: false completion — an infrastructure hiccup must not acknowledge a still-live process.
    const jobId='transient-unavailable';await seedJob(jobId);await activateContainer(jobId,'container-transient');await wraps.reserveCurrent({jobId,taskIndex:0,principal,reason:'retry',dueAt:new Date(0)});
    const boundary=new SequencedTerminationBoundary(['unavailable','confirmed']);const running=service(boundary);await running.wrapUp.recover();
    expect((await database.query<any>(`SELECT completed_at FROM agent_job_wrap_up_requests WHERE job_id=$1`,[jobId]))[0].completed_at).toBeNull();
    await database.query(`UPDATE agent_job_wrap_up_requests SET claim_expires_at=now()-interval '1 second' WHERE job_id=$1`,[jobId]);await running.wrapUp.recover();
    expect(boundary.calls).toHaveLength(2);expect((await database.query<any>(`SELECT completed_at IS NOT NULL AS completed FROM agent_job_wrap_up_requests WHERE job_id=$1`,[jobId]))[0].completed).toBe(true);
  });

  it('replays a crash after external confirmation but before its durable receipt',async()=>{
    // risk: crash window — recovery must retry the fenced generation rather than infer success from terminal SQL state.
    const jobId='receipt-crash';await seedJob(jobId);const identity=await activateContainer(jobId,'container-receipt');await wraps.reserveCurrent({jobId,taskIndex:0,principal,reason:'receipt crash',dueAt:new Date(0)});
    const claim=await wraps.claim(jobId,0,30);expect(claim).toBeDefined();expect(await wraps.beginTeardown(claim!)).toBe(true);
    const firstBoundary=new SequencedTerminationBoundary(['confirmed']);expect(await new ConfirmedTaskTeardownService(identities,firstBoundary).teardown(jobId,0,identity.generation)).toBe('confirmed');
    await database.query(`UPDATE agent_job_wrap_up_requests SET claim_expires_at=now()-interval '1 second' WHERE job_id=$1`,[jobId]);
    const replayBoundary=new SequencedTerminationBoundary(['confirmed']);await service(replayBoundary).wrapUp.recover();expect(replayBoundary.calls).toEqual([identity]);
    expect((await database.query<any>(`SELECT completed_at IS NOT NULL AS completed FROM agent_job_wrap_up_requests WHERE job_id=$1`,[jobId]))[0].completed).toBe(true);
  });

  it('bounds repeated unavailable teardown and preserves its last error for manual reconciliation',async()=>{
    // risk: retry storm — an unreachable runtime must not renew thirty-second claims forever.
    const jobId='exhausted-unavailable';await seedJob(jobId);await activateContainer(jobId,'container-exhausted');await wraps.reserveCurrent({jobId,taskIndex:0,principal,reason:'bounded retry',dueAt:new Date(0)});
    const boundary=new SequencedTerminationBoundary(Array(5).fill('unavailable'));const running=service(boundary);
    for(let attempt=0;attempt<5;attempt++){await running.wrapUp.recover();await database.query(`UPDATE agent_job_wrap_up_requests SET claim_expires_at=now()-interval '1 second' WHERE job_id=$1`,[jobId]);}
    expect(await wraps.state(jobId,0)).toBe('manual-reconciliation');
    expect((await database.query<any>(`SELECT teardown_attempts,teardown_last_error,completed_at FROM agent_job_wrap_up_requests WHERE job_id=$1`,[jobId]))[0]).toMatchObject({teardown_attempts:5,teardown_last_error:'Execution teardown unavailable',completed_at:null});
    expect(running.timer.callbacks).toHaveLength(0);
  });

  it('does not arm an infinite retry for a legacy manual-reconciliation or terminal request',async()=>{
    // risk: retry storm — non-automatable legacy and terminal rows must stay out of boot timers.
    const jobId='legacy-manual';await seedJob(jobId);await database.query(`INSERT INTO agent_job_wrap_up_requests(job_id,task_index,execution_generation,principal,reason,due_at,reconciliation_outcome,reconciliation_reason,reconciled_at) VALUES($1,0,'unavailable',$2::jsonb,'legacy',now()-interval '1 day','manual-reconciliation','identity missing',now())`,[jobId,JSON.stringify(principal)]);
    const manual=service(new SequencedTerminationBoundary([]));await manual.wrapUp.recover();expect(manual.timer.callbacks).toHaveLength(0);
    await database.query(`UPDATE agent_job_wrap_up_requests SET reconciliation_outcome=NULL,reconciled_at=NULL,completed_at=now() WHERE job_id=$1`,[jobId]);const terminal=service(new SequencedTerminationBoundary([]));await terminal.wrapUp.recover();expect(terminal.timer.callbacks).toHaveLength(0);
  });

  it('refuses missing or recycled VM handles and recycled container identities at production transport seams',async()=>{
    // risk: wrong-process kill — absence and PID/name reuse are not evidence of the original execution exiting.
    const missingPid=new GuestBoundary(Object.assign(new Error('pidfile unavailable'),{exitCode:2}));
    const vmIdentity:TaskExecutionIdentity={kind:'vm-process',generation:'vm-generation',pid:321,startTime:'9911',pidFile:'/run/sulla/task.pid'};
    expect(await new PlatformTaskExecutionTerminationTransport(new ContainerBoundary(new Error('unused')) as any,missingPid as any).terminate(vmIdentity,{jobId:'job-vm',taskIndex:0})).toBe('unavailable');
    const recycledPid=new GuestBoundary(Object.assign(new Error('pid starttime mismatch'),{exitCode:5}));expect(await new PlatformTaskExecutionTerminationTransport(new ContainerBoundary(new Error('unused')) as any,recycledPid as any).terminate(vmIdentity,{jobId:'job-vm',taskIndex:0})).toBe('unavailable');
    const labels={'com.sulla.job-id':'other-job','com.sulla.task-index':'0','com.sulla.generation':'new-generation'};const recycledContainer=new ContainerBoundary({Id:'replacement-id',Config:{Labels:labels}});
    const containerIdentity:TaskExecutionIdentity={kind:'container',generation:'old-generation',containerId:'old-id',containerName:'reused-name',labels:{'com.sulla.generation':'old-generation'}};
    expect(await new PlatformTaskExecutionTerminationTransport(recycledContainer as any,new GuestBoundary() as any).terminate(containerIdentity,{jobId:'job-container',taskIndex:0})).toBe('unavailable');expect(recycledContainer.removed).toEqual([]);
  });

  it('reconciles a crash after the durable discovery handle but before identity activation',async()=>{
    // risk: orphan process — boot recovery must bind the exact discoverable execution to its reserved generation.
    const jobId='post-handle-crash';await seedJob(jobId);let handle!:TaskExecutionDiscoveryHandle;
    const launch=await identities.reserveLaunch(jobId,0,generation=>handle={kind:'container',containerName:'sulla-agent-post-handle-crash-0',labels:{'com.sulla.job-id':jobId,'com.sulla.task-index':'0','com.sulla.generation':generation}});
    const discovered:TaskExecutionIdentityInput={kind:'container',containerId:'container-post-handle',containerName:handle.containerName,labels:handle.labels};
    const runtime=new ContainerBoundary({Id:discovered.containerId,Config:{Labels:discovered.labels}});
    await new LaunchingTaskExecutionReconciler(identities,new PlatformTaskExecutionTerminationTransport(runtime as any,new GuestBoundary() as any)).reconcile();
    expect(await identities.find(jobId,0,launch.generation)).toEqual({...discovered,generation:launch.generation});
  });

  it('leaves a crash-before-identity reservation unavailable instead of fabricating an execution receipt',async()=>{
    // risk: orphan process — a launch crash before identity activation needs explicit recovery, not a guessed stop.
    const jobId='pre-identity-crash';await seedJob(jobId);const launch=await identities.reserveLaunch(jobId,0);await identities.failLaunch(launch,'provider disconnected before identity receipt');
    expect(await wraps.reserveCurrent({jobId,taskIndex:0,principal,reason:'cannot guess',dueAt:new Date(0)})).toEqual({inserted:false});
    const boundary=new SequencedTerminationBoundary(['confirmed']);expect(await new ConfirmedTaskTeardownService(identities,boundary).teardown(jobId,0,launch.generation)).toBe('unavailable');expect(boundary.calls).toEqual([]);
  });
});
