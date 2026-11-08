// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

export type TaskExecutionIdentity =
  | { kind:'container'; generation:string; containerId:string; containerName:string; labels:Record<string,string> }
  | { kind:'vm-process'; generation:string; pid:number; startTime:string; pidFile?:string };

export interface TaskExecutionIdentityStore {
  record(jobId:string,taskIndex:number,identity:TaskExecutionIdentity):Promise<void>;
  find(jobId:string,taskIndex:number,generation:string):Promise<TaskExecutionIdentity|undefined>;
  currentGeneration(jobId:string,taskIndex:number):Promise<string|undefined>;
}

export class TaskExecutionIdentityRepository implements TaskExecutionIdentityStore {
  constructor(private readonly database:{query<T=any>(sql:string,parameters?:unknown[]):Promise<T[]>}){}
  async record(jobId:string,taskIndex:number,identity:TaskExecutionIdentity):Promise<void>{
    await this.database.query(`INSERT INTO agent_task_execution_identities(job_id,task_index,identity,generation)
      VALUES($1,$2,$3::jsonb,$4) ON CONFLICT(job_id,task_index,generation) DO UPDATE SET identity=EXCLUDED.identity,recorded_at=now()`,
    [jobId,taskIndex,JSON.stringify(identity),identity.generation]);
  }
  async find(jobId:string,taskIndex:number,generation:string):Promise<TaskExecutionIdentity|undefined>{
    const row=(await this.database.query<{identity:TaskExecutionIdentity}>(`SELECT identity FROM agent_task_execution_identities WHERE job_id=$1 AND task_index=$2 AND generation=$3`,[jobId,taskIndex,generation]))[0];
    return row?.identity;
  }
  async currentGeneration(jobId:string,taskIndex:number):Promise<string|undefined>{
    const row=(await this.database.query<{generation:string}>(`SELECT generation FROM agent_task_execution_identities WHERE job_id=$1 AND task_index=$2 ORDER BY recorded_at DESC LIMIT 1`,[jobId,taskIndex]))[0];
    return row?.generation;
  }
}
