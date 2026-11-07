// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { randomUUID } from 'node:crypto';
import { StopPrincipal, type StopPrincipalValue } from '../ValueObjects/StopPrincipal';

export interface DurableWrapUpRequest { jobId:string; taskIndex:number; principal:StopPrincipalValue; reason:string; dueAt:Date }
export interface DurableWrapUpClaim extends DurableWrapUpRequest { claimToken:string; claimVersion:number }
export interface JobWrapUpPersistence {
  reserve(input:DurableWrapUpRequest):Promise<boolean>;
  pending():Promise<DurableWrapUpRequest[]>;
  state(jobId:string,taskIndex:number):Promise<'pending'|'completed'|'cancelled'|undefined>;
  claim(jobId:string,taskIndex:number,leaseSeconds:number):Promise<DurableWrapUpClaim|undefined>;
  beginTeardown(claim:DurableWrapUpClaim):Promise<boolean>;
  acknowledgeTeardown(claim:DurableWrapUpClaim):Promise<boolean>;
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
  async claim(jobId:string,taskIndex:number,leaseSeconds:number):Promise<DurableWrapUpClaim|undefined>{
    const token=randomUUID();
    const row=(await this.database.query<any>(`UPDATE agent_job_wrap_up_requests
      SET claim_token=$3,claim_version=claim_version+1,claim_expires_at=now()+make_interval(secs=>$4)
      WHERE job_id=$1 AND task_index=$2 AND due_at<=now() AND completed_at IS NULL AND cancelled_at IS NULL
        AND (claim_expires_at IS NULL OR claim_expires_at<=now()) RETURNING *`,[jobId,taskIndex,token,leaseSeconds]))[0];
    return row?{jobId:String(row.job_id),taskIndex:Number(row.task_index),principal:row.principal as StopPrincipalValue,reason:String(row.reason),dueAt:new Date(row.due_at),claimToken:token,claimVersion:Number(row.claim_version)}:undefined;
  }
  async beginTeardown(claim:DurableWrapUpClaim):Promise<boolean>{
    const stoppedBy=StopPrincipal.attribution(claim.principal);
    const rows=await this.database.query(`WITH current_claim AS (
      SELECT job_id,task_index FROM agent_job_wrap_up_requests
      WHERE job_id=$1 AND task_index=$2 AND claim_token=$3 AND claim_version=$4
        AND claim_expires_at>now() AND completed_at IS NULL AND cancelled_at IS NULL FOR UPDATE
    ), stopped AS (
      UPDATE agent_jobs job SET
        tasks=jsonb_set(job.tasks,ARRAY[$2::text],
          (job.tasks->$2::int)||jsonb_build_object('status','stopped','finishedAt',(extract(epoch from now())*1000)::bigint,'stoppedBy',$5::jsonb,'stopReason',$6::text),false),
        status=CASE WHEN NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(job.tasks) WITH ORDINALITY task(value,ordinality)
          WHERE ordinality<>$2+1 AND value->>'status' IN ('queued','running','parked')
        ) THEN 'stopped' ELSE job.status END,
        finished_at=CASE WHEN NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(job.tasks) WITH ORDINALITY task(value,ordinality)
          WHERE ordinality<>$2+1 AND value->>'status' IN ('queued','running','parked')
        ) THEN now() ELSE job.finished_at END,
        waiting_on_children=CASE WHEN NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(job.tasks) WITH ORDINALITY task(value,ordinality)
          WHERE ordinality<>$2+1 AND value->>'status' IN ('queued','running','parked')
        ) THEN 0 ELSE job.waiting_on_children END,
        completion_delivered_at=CASE WHEN NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(job.tasks) WITH ORDINALITY task(value,ordinality)
          WHERE ordinality<>$2+1 AND value->>'status' IN ('queued','running','parked')
        ) THEN now() ELSE job.completion_delivered_at END,
        stopped_by=CASE WHEN NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(job.tasks) WITH ORDINALITY task(value,ordinality)
          WHERE ordinality<>$2+1 AND value->>'status' IN ('queued','running','parked')
        ) THEN $5::jsonb ELSE job.stopped_by END,
        stop_reason=CASE WHEN NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(job.tasks) WITH ORDINALITY task(value,ordinality)
          WHERE ordinality<>$2+1 AND value->>'status' IN ('queued','running','parked')
        ) THEN $6::text ELSE job.stop_reason END
      FROM current_claim WHERE job.job_id=current_claim.job_id
        AND job.tasks->$2::int IS NOT NULL
        AND job.tasks->$2::int->>'status' IN ('queued','running','parked') RETURNING job.job_id
    ) UPDATE agent_job_wrap_up_requests request
      SET teardown_needed_at=COALESCE(teardown_needed_at,now())
      FROM current_claim WHERE request.job_id=current_claim.job_id AND request.task_index=current_claim.task_index
      RETURNING 1`,[claim.jobId,claim.taskIndex,claim.claimToken,claim.claimVersion,JSON.stringify(stoppedBy),claim.reason]);
    return rows.length===1;
  }
  async acknowledgeTeardown(claim:DurableWrapUpClaim):Promise<boolean>{
    const rows=await this.database.query(`UPDATE agent_job_wrap_up_requests SET teardown_acknowledged_at=now(),completed_at=now(),claim_expires_at=NULL
      WHERE job_id=$1 AND task_index=$2 AND claim_token=$3 AND claim_version=$4 AND claim_expires_at>now()
        AND teardown_needed_at IS NOT NULL AND teardown_acknowledged_at IS NULL
        AND completed_at IS NULL AND cancelled_at IS NULL RETURNING 1`,[claim.jobId,claim.taskIndex,claim.claimToken,claim.claimVersion]);
    return rows.length===1;
  }
  async cancel(jobId:string,taskIndex:number):Promise<void>{await this.database.query(`UPDATE agent_job_wrap_up_requests SET cancelled_at=COALESCE(cancelled_at,now()) WHERE job_id=$1 AND task_index=$2 AND completed_at IS NULL AND teardown_needed_at IS NULL`,[jobId,taskIndex]);}
  async cancelJob(jobId:string):Promise<void>{await this.database.query(`UPDATE agent_job_wrap_up_requests SET cancelled_at=COALESCE(cancelled_at,now()) WHERE job_id=$1 AND completed_at IS NULL AND teardown_needed_at IS NULL`,[jobId]);}
}
