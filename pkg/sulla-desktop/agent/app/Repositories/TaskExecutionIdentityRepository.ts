// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

export type TaskExecutionIdentity =
  | { kind:'container'; generation:string; containerName:string }
  | { kind:'vm-process'; generation:string; pid:number; startTime:string; pidFile?:string };

export interface TaskExecutionIdentityStore {
  record(jobId:string,taskIndex:number,identity:TaskExecutionIdentity):Promise<void>;
  find(jobId:string,taskIndex:number):Promise<TaskExecutionIdentity|undefined>;
}

export class TaskExecutionIdentityRepository implements TaskExecutionIdentityStore {
  constructor(private readonly database:{query<T=any>(sql:string,parameters?:unknown[]):Promise<T[]>}){}
  async record(jobId:string,taskIndex:number,identity:TaskExecutionIdentity):Promise<void>{
    await this.database.query(`INSERT INTO agent_task_execution_identities(job_id,task_index,identity,generation)
      VALUES($1,$2,$3::jsonb,$4) ON CONFLICT(job_id,task_index) DO UPDATE SET identity=EXCLUDED.identity,generation=EXCLUDED.generation,recorded_at=now()`,
    [jobId,taskIndex,JSON.stringify(identity),identity.generation]);
  }
  async find(jobId:string,taskIndex:number):Promise<TaskExecutionIdentity|undefined>{
    const row=(await this.database.query<{identity:TaskExecutionIdentity}>(`SELECT identity FROM agent_task_execution_identities WHERE job_id=$1 AND task_index=$2`,[jobId,taskIndex]))[0];
    return row?.identity;
  }
}
