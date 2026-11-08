// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { buildRemoteKillCommand } from '../../languagemodels/claudeLaunchCommand';
import { GuestDockerRuntimeDriver, guestExec, isContainerGoneError } from '../../services/AgentContainerLauncher';
import type { TaskExecutionDiscoveryHandle,TaskExecutionIdentity,TaskExecutionIdentityInput } from '../Repositories/TaskExecutionIdentityRepository';
import type { TaskExecutionTerminationTransport } from './ConfirmedTaskTeardownService';
import type { TaskTeardownOutcome } from './TaskTeardownPort';
import type { TaskExecutionDiscoveryTransport } from './LaunchingTaskExecutionReconciler';

interface ContainerRuntime {inspect(id:string):Promise<any>;remove(id:string,force?:boolean):Promise<void>}
interface GuestCommand {run(args:string[]):Promise<{stdout:string;stderr:string}>}

/** Generation-fenced adapter over the existing VM CLI and container runtime boundaries. */
export class PlatformTaskExecutionTerminationTransport implements TaskExecutionTerminationTransport,TaskExecutionDiscoveryTransport {
  constructor(
    private readonly containers:ContainerRuntime=new GuestDockerRuntimeDriver(),
    private readonly guest:GuestCommand={run:args=>guestExec(args)},
  ){}
  async terminate(identity:TaskExecutionIdentity,expected:{jobId:string;taskIndex:number}):Promise<TaskTeardownOutcome>{
    return identity.kind==='container'?this.terminateContainer(identity,expected):this.terminateVmProcess(identity);
  }
  async discover(handle:TaskExecutionDiscoveryHandle,expected:{jobId:string;taskIndex:number}):Promise<TaskExecutionIdentityInput|undefined>{
    return handle.kind==='container'?this.discoverContainer(handle,expected):this.discoverVmProcess(handle);
  }
  private async discoverContainer(handle:Extract<TaskExecutionDiscoveryHandle,{kind:'container'}>,expected:{jobId:string;taskIndex:number}):Promise<TaskExecutionIdentityInput|undefined>{
    let inspected:any;
    try{inspected=await this.containers.inspect(handle.containerName);}catch(error){if(isContainerGoneError(error))return undefined;throw error;}
    const labels=Object.fromEntries(Object.entries(inspected?.Config?.Labels??{}).map(([key,value])=>[key,String(value)]));
    const containerId=String(inspected?.Id??'');
    if(!containerId||labels['com.sulla.job-id']!==expected.jobId||labels['com.sulla.task-index']!==String(expected.taskIndex))return undefined;
    for(const [key,value] of Object.entries(handle.labels)){if(labels[key]!==value)return undefined;}
    return {kind:'container',containerId,containerName:handle.containerName,labels};
  }
  private async discoverVmProcess(handle:Extract<TaskExecutionDiscoveryHandle,{kind:'vm-process'}>):Promise<TaskExecutionIdentityInput|undefined>{
    if(!handle.pidFile)return undefined;
    let record:string;
    try{record=(await this.guest.run(['cat',handle.pidFile])).stdout.trim();}catch{return undefined;}
    const match=/^(\d+) (\d+)$/.exec(record);
    if(!match)return undefined;
    const pid=Number(match[1]);
    if(!Number.isSafeInteger(pid)||pid<=0)return undefined;
    return {kind:'vm-process',pid,startTime:match[2],pidFile:handle.pidFile};
  }
  private async terminateContainer(identity:Extract<TaskExecutionIdentity,{kind:'container'}>,expected:{jobId:string;taskIndex:number}):Promise<TaskTeardownOutcome>{
    let inspected:any;
    try{inspected=await this.containers.inspect(identity.containerName);}catch(error){return isContainerGoneError(error)?'confirmed':'unavailable';}
    const labels=inspected?.Config?.Labels??{};const actualId=String(inspected?.Id??'');
    if(actualId!==identity.containerId||labels['com.sulla.job-id']!==expected.jobId||labels['com.sulla.task-index']!==String(expected.taskIndex))return 'unavailable';
    for(const [key,value] of Object.entries(identity.labels)){if(String(labels[key]??'')!==value)return 'unavailable';}
    try{await this.containers.remove(identity.containerId,true);}catch(error){if(!isContainerGoneError(error))return 'unavailable';}
    try{await this.containers.inspect(identity.containerId);return 'still-running';}catch(error){return isContainerGoneError(error)?'confirmed':'unavailable';}
  }
  private async terminateVmProcess(identity:Extract<TaskExecutionIdentity,{kind:'vm-process'}>):Promise<TaskTeardownOutcome>{
    if(!identity.pidFile||!Number.isSafeInteger(identity.pid)||identity.pid<=0||!/^[0-9]+$/.test(identity.startTime))return 'unavailable';
    try{await this.guest.run(['sh','-c',buildRemoteKillCommand(identity.pidFile,'KILL',{pid:identity.pid,startTime:identity.startTime})]);return 'confirmed';}
    catch(error){const code=(error as {exitCode?:number}).exitCode;return code===4?'still-running':code===0?'confirmed':'unavailable';}
  }
}
