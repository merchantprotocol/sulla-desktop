// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import {describe,expect,it} from 'vitest';
import {ConfirmedTaskTeardownService,type TaskExecutionTerminationTransport} from '../../../app/Services/ConfirmedTaskTeardownService';
import type {TaskExecutionIdentity,TaskExecutionIdentityStore} from '../../../app/Repositories/TaskExecutionIdentityRepository';
class IdentityStore implements TaskExecutionIdentityStore{async reserveLaunch(jobId:string,taskIndex:number){return {jobId,taskIndex,generation:'reserved'};}async activate():Promise<any>{throw new Error('unused');}async failLaunch():Promise<void>{}constructor(private readonly identity?:TaskExecutionIdentity){}async record():Promise<void>{}async find(_jobId:string,_taskIndex:number,generation:string):Promise<TaskExecutionIdentity|undefined>{return this.identity?.generation===generation?this.identity:undefined;}async currentGeneration():Promise<string|undefined>{return this.identity?.generation;}}
class Transport implements TaskExecutionTerminationTransport{calls:TaskExecutionIdentity[]=[];constructor(private readonly outcome:'confirmed'|'still-running'|'unavailable'){}async terminate(identity:TaskExecutionIdentity):Promise<'confirmed'|'still-running'|'unavailable'>{this.calls.push(identity);return this.outcome;}}
describe('ConfirmedTaskTeardownService',()=>{
 it('does not call a transport when restart recovery has no durable generation',async()=>{ // risk: recycled process
  const transport=new Transport('confirmed');expect(await new ConfirmedTaskTeardownService(new IdentityStore(),transport).teardown('job',0,'generation-a')).toBe('unavailable');expect(transport.calls).toEqual([]);
 });
 it('does not fall through to a replacement generation when the captured identity is missing',async()=>{ // risk: replacement execution
  const replacement={kind:'vm-process',generation:'new-generation',pid:7,startTime:'9',pidFile:'/tmp/new.pid'} as const;const transport=new Transport('confirmed');
  expect(await new ConfirmedTaskTeardownService(new IdentityStore(replacement),transport).teardown('job',0,'old-generation')).toBe('unavailable');expect(transport.calls).toEqual([]);
 });
 it.each(['confirmed','still-running','unavailable'] as const)('preserves the transport %s result for the recorded generation',async(outcome)=>{ // risk: external side effect
  const identity={kind:'container',generation:'container-generation-a',containerId:'container-generation-a',containerName:'sulla-agent-job-0',labels:{'com.sulla.job-id':'job','com.sulla.task-index':'0'}} as const;const transport=new Transport(outcome);
  expect(await new ConfirmedTaskTeardownService(new IdentityStore(identity),transport).teardown('job',0,'container-generation-a')).toBe(outcome);expect(transport.calls).toEqual([identity]);
 });
});
