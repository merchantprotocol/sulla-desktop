// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { StopPrincipalValue } from '../ValueObjects/StopPrincipal';

export interface DurableWrapUpRequest { jobId:string; taskIndex:number; principal:StopPrincipalValue; reason:string; dueAt:Date }
export interface JobWrapUpPersistence {
  reserve(input:DurableWrapUpRequest):Promise<boolean>;
  pending():Promise<DurableWrapUpRequest[]>;
  state(jobId:string,taskIndex:number):Promise<'pending'|'completed'|'cancelled'|undefined>;
  complete(jobId:string,taskIndex:number):Promise<void>;
  cancel(jobId:string,taskIndex:number):Promise<void>;
  cancelJob(jobId:string):Promise<void>;
}

export class JobWrapUpRepository implements JobWrapUpPersistence {
  constructor(private readonly database:{query<T=any>(sql:string,parameters?:unknown[]):Promise<T[]>}){}
  async reserve(input:DurableWrapUpRequest):Promise<boolean>{
    const rows=await this.database.query(`INSERT INTO agent_job_wrap_up_requests(job_id,task_index,principal,reason,due_at)
      VALUES($1,$2,$3::jsonb,$4,$5) ON CONFLICT(job_id,task_index) DO NOTHING RETURNING 1`,
    [input.jobId,input.taskIndex,JSON.stringify(input.principal),input.reason,input.dueAt]);
    return rows.length===1;
  }
  async pending():Promise<DurableWrapUpRequest[]>{
    const rows=await this.database.query<any>(`SELECT * FROM agent_job_wrap_up_requests WHERE completed_at IS NULL AND cancelled_at IS NULL ORDER BY due_at`);
    return rows.map(row=>({jobId:String(row.job_id),taskIndex:Number(row.task_index),principal:row.principal as StopPrincipalValue,reason:String(row.reason),dueAt:new Date(row.due_at)}));
  }
  async state(jobId:string,taskIndex:number):Promise<'pending'|'completed'|'cancelled'|undefined>{
    const row=(await this.database.query<any>(`SELECT completed_at,cancelled_at FROM agent_job_wrap_up_requests WHERE job_id=$1 AND task_index=$2`,[jobId,taskIndex]))[0];
    return !row?undefined:row.completed_at?'completed':row.cancelled_at?'cancelled':'pending';
  }
  async complete(jobId:string,taskIndex:number):Promise<void>{await this.database.query(`UPDATE agent_job_wrap_up_requests SET completed_at=COALESCE(completed_at,now()) WHERE job_id=$1 AND task_index=$2`,[jobId,taskIndex]);}
  async cancel(jobId:string,taskIndex:number):Promise<void>{await this.database.query(`UPDATE agent_job_wrap_up_requests SET cancelled_at=COALESCE(cancelled_at,now()) WHERE job_id=$1 AND task_index=$2 AND completed_at IS NULL`,[jobId,taskIndex]);}
  async cancelJob(jobId:string):Promise<void>{await this.database.query(`UPDATE agent_job_wrap_up_requests SET cancelled_at=COALESCE(cancelled_at,now()) WHERE job_id=$1 AND completed_at IS NULL`,[jobId]);}
}
