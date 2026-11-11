// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import {describe,expect,it,vi} from 'vitest';
vi.mock('electron',()=>({app:{getVersion:()=> '0.0.0-test'}}));
import {PlatformTaskExecutionTerminationTransport} from '../../../app/Services/PlatformTaskExecutionTerminationTransport';
import type {TaskExecutionIdentity} from '../../../app/Repositories/TaskExecutionIdentityRepository';

class ContainerBoundary {
  removed:string[]=[];
  constructor(private current:any,private readonly failure?:Error){}
  async inspect():Promise<any>{if(this.failure)throw this.failure;if(!this.current)throw Object.assign(new Error('No such container'),{stderr:'No such container'});return this.current;}
  async remove(id:string):Promise<void>{this.removed.push(id);this.current=undefined;}
}
class GuestBoundary {calls:string[][]=[];constructor(private readonly error?:any){}async run(args:string[]){this.calls.push(args);if(this.error)throw this.error;return {stdout:'',stderr:''};}}
const containerGeneration='cid-a';
const capabilityJti='capability-a';
const labels={'com.sulla.job-id':'job-a','com.sulla.task-index':'2','com.sulla.generation':containerGeneration,'com.sulla.capability-jti':capabilityJti};
const container:TaskExecutionIdentity={kind:'container',generation:containerGeneration,containerId:containerGeneration,containerName:'sulla-agent-job-a-2',labels};

describe('PlatformTaskExecutionTerminationTransport',()=>{
 it('discovers and confirms the persisted real container generation after a boundary restart',async()=>{ // risk: orphan external execution
  const runtime=new ContainerBoundary({Id:'cid-a',Config:{Labels:labels}});const service=new PlatformTaskExecutionTerminationTransport(runtime as any,new GuestBoundary() as any);
  expect(await service.terminate(container,{jobId:'job-a',taskIndex:2})).toBe('confirmed');expect(runtime.removed).toEqual(['cid-a']);
  expect(await service.terminate(container,{jobId:'job-a',taskIndex:2})).toBe('confirmed');expect(runtime.removed).toEqual(['cid-a']);
 });
 it('refuses a replacement container with the same id, job, and task but a different generation',async()=>{ // risk: wrong execution killed
  const runtime=new ContainerBoundary({Id:containerGeneration,Config:{Labels:{...labels,'com.sulla.generation':'cid-b'}}});const service=new PlatformTaskExecutionTerminationTransport(runtime as any,new GuestBoundary() as any);
  expect(await service.terminate(container,{jobId:'job-a',taskIndex:2})).toBe('unavailable');expect(runtime.removed).toEqual([]);
 });
 it('confirms an already-gone recorded generation on replay without another removal',async()=>{ // risk: teardown replay
  const runtime=new ContainerBoundary(undefined);const service=new PlatformTaskExecutionTerminationTransport(runtime as any,new GuestBoundary() as any);
  expect(await service.terminate(container,{jobId:'job-a',taskIndex:2})).toBe('confirmed');expect(runtime.removed).toEqual([]);
 });
 it('refuses a recycled VM pid before the existing confirmed kill command can signal it',async()=>{ // risk: recycled PID
  const guest=new GuestBoundary(Object.assign(new Error('fence mismatch'),{exitCode:5}));const service=new PlatformTaskExecutionTerminationTransport(new ContainerBoundary(undefined) as any,guest as any);
  const identity:TaskExecutionIdentity={kind:'vm-process',generation:'42:100',pid:42,startTime:'100',pidFile:'/tmp/sulla-codex-generation.pid'};
  expect(await service.terminate(identity,{jobId:'job-a',taskIndex:2})).toBe('unavailable');expect(guest.calls[0].join(' ')).toContain('[ "$p" = \'42\' ]');
 });
 it('refuses a missing VM pidfile and malformed durable records',async()=>{ // risk: restart replay
  const gone=new GuestBoundary(Object.assign(new Error('pidfile gone'),{exitCode:2}));const service=new PlatformTaskExecutionTerminationTransport(new ContainerBoundary(undefined) as any,gone as any);
  expect(await service.terminate({kind:'vm-process',generation:'42:100',pid:42,startTime:'100',pidFile:'/tmp/sulla-codex-generation.pid'},{jobId:'job-a',taskIndex:2})).toBe('unavailable');
  expect(await service.terminate({kind:'vm-process',generation:'42:other',pid:42,startTime:'bad',pidFile:'/tmp/sulla-codex-generation.pid'},{jobId:'job-a',taskIndex:2})).toBe('unavailable');
 });
 it('keeps unavailable infrastructure pending for retry',async()=>{ // risk: false teardown acknowledgement
  const runtime=new ContainerBoundary(undefined,new Error('runtime unavailable'));const service=new PlatformTaskExecutionTerminationTransport(runtime as any,new GuestBoundary() as any);
  expect(await service.terminate(container,{jobId:'job-a',taskIndex:2})).toBe('unavailable');
 });
});
