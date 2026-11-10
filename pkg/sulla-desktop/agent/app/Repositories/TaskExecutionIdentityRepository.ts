// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { randomUUID } from 'node:crypto';

export type TaskExecutionIdentity =
  | { kind:'container'; generation:string; containerId:string; containerName:string; labels:Record<string,string> }
  | { kind:'vm-process'; generation:string; pid:number; startTime:string; pidFile:string };

export type TaskExecutionIdentityInput =
  | Omit<Extract<TaskExecutionIdentity,{kind:'container'}>,'generation'>
  | Omit<Extract<TaskExecutionIdentity,{kind:'vm-process'}>,'generation'>;

export type TaskExecutionDiscoveryHandle =
  | { kind:'container'; containerName:string; labels:Record<string,string> }
  | { kind:'vm-process'; pidFile:string };

export interface TaskExecutionLaunchReservation { jobId:string; taskIndex:number; generation:string }
export interface LaunchingTaskExecution extends TaskExecutionLaunchReservation { discoveryHandle?:TaskExecutionDiscoveryHandle }

export type TaskExecutionDiscoveryHandleFactory=(generation:string)=>TaskExecutionDiscoveryHandle;

export interface TaskExecutionIdentityStore {
  reserveLaunch(jobId:string,taskIndex:number,discoveryHandle?:TaskExecutionDiscoveryHandle|TaskExecutionDiscoveryHandleFactory):Promise<TaskExecutionLaunchReservation>;
  activate(reservation:TaskExecutionLaunchReservation,identity:TaskExecutionIdentityInput):Promise<TaskExecutionIdentity>;
  failLaunch(reservation:TaskExecutionLaunchReservation,reason:string):Promise<void>;
  record(jobId:string,taskIndex:number,identity:TaskExecutionIdentity):Promise<void>;
  find(jobId:string,taskIndex:number,generation:string):Promise<TaskExecutionIdentity|undefined>;
  currentGeneration(jobId:string,taskIndex:number):Promise<string|undefined>;
}

/** Durable launch journal. The advisory task lock is shared with reopen and wrap-up reservation. */
export class TaskExecutionIdentityRepository implements TaskExecutionIdentityStore {
  constructor(private readonly database:{query<T=any>(sql:string,parameters?:unknown[]):Promise<T[]>}){}
  async reserveLaunch(jobId:string,taskIndex:number,discoveryHandle?:TaskExecutionDiscoveryHandle|TaskExecutionDiscoveryHandleFactory):Promise<TaskExecutionLaunchReservation>{
    const generation=randomUUID();
    const durableHandle=typeof discoveryHandle==='function'?discoveryHandle(generation):discoveryHandle;
    await this.database.query(`WITH task_lock AS (SELECT pg_advisory_xact_lock(hashtext($1),$2)), inserted AS (
      INSERT INTO agent_task_execution_identities(job_id,task_index,generation,launch_state,discovery_handle)
      SELECT $1,$2,$3,'launching',$4::jsonb FROM task_lock RETURNING generation) SELECT generation FROM inserted`,[jobId,taskIndex,generation,durableHandle?JSON.stringify(durableHandle):null]);
    return {jobId,taskIndex,generation};
  }
  async activate(reservation:TaskExecutionLaunchReservation,identity:TaskExecutionIdentityInput):Promise<TaskExecutionIdentity>{
    const active={...identity,generation:reservation.generation} as TaskExecutionIdentity;
    const rows=await this.database.query(`UPDATE agent_task_execution_identities SET identity=$4::jsonb,launch_state='active',activated_at=now(),failure_reason=NULL
      WHERE job_id=$1 AND task_index=$2 AND generation=$3 AND launch_state='launching' RETURNING 1`,
    [reservation.jobId,reservation.taskIndex,reservation.generation,JSON.stringify(active)]);
    if(rows.length!==1)throw new Error('Task execution launch reservation is no longer active');
    return active;
  }
  async failLaunch(reservation:TaskExecutionLaunchReservation,reason:string):Promise<void>{
    await this.database.query(`UPDATE agent_task_execution_identities SET launch_state='failed',failure_reason=$4,failed_at=now()
      WHERE job_id=$1 AND task_index=$2 AND generation=$3 AND launch_state='launching'`,[reservation.jobId,reservation.taskIndex,reservation.generation,reason.slice(0,1000)]);
  }
  async record(jobId:string,taskIndex:number,identity:TaskExecutionIdentity):Promise<void>{
    await this.database.query(`INSERT INTO agent_task_execution_identities(job_id,task_index,identity,generation,launch_state,activated_at)
      VALUES($1,$2,$3::jsonb,$4,'active',now()) ON CONFLICT(job_id,task_index,generation) DO UPDATE SET identity=EXCLUDED.identity,launch_state='active',activated_at=now(),failure_reason=NULL`,
    [jobId,taskIndex,JSON.stringify(identity),identity.generation]);
  }
  async find(jobId:string,taskIndex:number,generation:string):Promise<TaskExecutionIdentity|undefined>{
    const row=(await this.database.query<{identity:TaskExecutionIdentity}>(`SELECT identity FROM agent_task_execution_identities
      WHERE job_id=$1 AND task_index=$2 AND generation=$3 AND launch_state='active' AND identity IS NOT NULL`,[jobId,taskIndex,generation]))[0];
    return row?.identity;
  }
  async launching():Promise<LaunchingTaskExecution[]>{
    const rows=await this.database.query<{job_id:string;task_index:number;generation:string;discovery_handle?:TaskExecutionDiscoveryHandle}>(`SELECT job_id,task_index,generation,discovery_handle FROM agent_task_execution_identities WHERE launch_state='launching' ORDER BY recorded_at`);
    return rows.map(row=>({jobId:row.job_id,taskIndex:row.task_index,generation:row.generation,discoveryHandle:row.discovery_handle}));
  }
  async requireManualReconciliation(reservation:TaskExecutionLaunchReservation,reason:string):Promise<void>{
    await this.database.query(`UPDATE agent_task_execution_identities SET launch_state='manual-reconciliation',failure_reason=$4,failed_at=now()
      WHERE job_id=$1 AND task_index=$2 AND generation=$3 AND launch_state='launching'`,[reservation.jobId,reservation.taskIndex,reservation.generation,reason.slice(0,1000)]);
  }
  async currentGeneration(jobId:string,taskIndex:number):Promise<string|undefined>{
    const row=(await this.database.query<{generation:string}>(`SELECT generation FROM agent_task_execution_identities
      WHERE job_id=$1 AND task_index=$2 AND launch_state='active' ORDER BY activated_at DESC NULLS LAST,recorded_at DESC LIMIT 1`,[jobId,taskIndex]))[0];
    return row?.generation;
  }
}
