// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { randomUUID } from 'node:crypto';
import { StopPrincipal, type StopPrincipalValue } from '../ValueObjects/StopPrincipal';

export interface DurableWrapUpRequest { jobId:string; taskIndex:number; executionGeneration:string; principal:StopPrincipalValue; reason:string; dueAt:Date }
export interface DurableWrapUpClaim extends DurableWrapUpRequest { claimToken:string; claimVersion:number; claimExpiresAt:Date }
export interface JobWrapUpPersistence {
  reserveCurrent(input:Omit<DurableWrapUpRequest,'executionGeneration'>):Promise<{inserted:boolean;request?:DurableWrapUpRequest;state?:'pending'|'completed'|'cancelled'|'manual-reconciliation'}>;
  pending():Promise<DurableWrapUpRequest[]>;
  state(jobId:string,taskIndex:number):Promise<'pending'|'completed'|'cancelled'|'manual-reconciliation'|undefined>;
  claim(jobId:string,taskIndex:number,leaseSeconds:number):Promise<DurableWrapUpClaim|undefined>;
  beginTeardown(claim:DurableWrapUpClaim):Promise<boolean>;
  acknowledgeTeardown(claim:DurableWrapUpClaim):Promise<boolean>;
  cancel(jobId:string,taskIndex:number):Promise<void>;
  cancelJob(jobId:string):Promise<void>;
  requireManualReconciliation(jobId:string,taskIndex:number,reason:string):Promise<void>;
  recordTeardownFailure(claim:DurableWrapUpClaim,reason:string,maxAttempts:number):Promise<'retry'|'manual-reconciliation'>;
}

export class JobWrapUpRepository implements JobWrapUpPersistence {
  constructor(private readonly database:{query<T=any>(sql:string,parameters?:unknown[]):Promise<T[]>}){}
  async reserveCurrent(input:Omit<DurableWrapUpRequest,'executionGeneration'>):Promise<{inserted:boolean;request?:DurableWrapUpRequest;state?:'pending'|'completed'|'cancelled'|'manual-reconciliation'}>{
    const rows=await this.database.query<any>(`WITH task_lock AS (SELECT pg_advisory_xact_lock(hashtext($1),$2)), current_identity AS (
      SELECT generation FROM agent_task_execution_identities,task_lock WHERE job_id=$1 AND task_index=$2 AND launch_state='active'
      ORDER BY activated_at DESC NULLS LAST,recorded_at DESC LIMIT 1), inserted AS (
      INSERT INTO agent_job_wrap_up_requests(job_id,task_index,execution_generation,principal,reason,due_at)
      SELECT $1,$2,current_identity.generation,$3::jsonb,$4,$5 FROM current_identity ON CONFLICT(job_id,task_index) DO NOTHING RETURNING *)
      SELECT inserted.*,TRUE AS inserted FROM inserted
      UNION ALL
      SELECT request.*,FALSE AS inserted FROM agent_job_wrap_up_requests request,task_lock
      WHERE request.job_id=$1 AND request.task_index=$2 AND NOT EXISTS(SELECT 1 FROM inserted)`,[input.jobId,input.taskIndex,JSON.stringify(input.principal),input.reason,input.dueAt]);
    const row=rows[0];if(!row)return {inserted:false};
    const state=row.reconciliation_outcome?'manual-reconciliation':row.completed_at?'completed':row.cancelled_at?'cancelled':'pending';
    return {inserted:Boolean(row.inserted),state,request:{...input,executionGeneration:String(row.execution_generation),dueAt:new Date(row.due_at)}};
  }
  async pending():Promise<DurableWrapUpRequest[]>{
    const rows=await this.database.query<any>(`SELECT * FROM agent_job_wrap_up_requests WHERE completed_at IS NULL AND cancelled_at IS NULL AND reconciliation_outcome IS NULL ORDER BY due_at`);
    return rows.map(row=>({jobId:String(row.job_id),taskIndex:Number(row.task_index),executionGeneration:String(row.execution_generation),principal:row.principal as StopPrincipalValue,reason:String(row.reason),dueAt:new Date(row.due_at)}));
  }
  async state(jobId:string,taskIndex:number):Promise<'pending'|'completed'|'cancelled'|'manual-reconciliation'|undefined>{
    const row=(await this.database.query<any>(`SELECT completed_at,cancelled_at,reconciliation_outcome FROM agent_job_wrap_up_requests WHERE job_id=$1 AND task_index=$2`,[jobId,taskIndex]))[0];
    return !row?undefined:row.reconciliation_outcome?'manual-reconciliation':row.completed_at?'completed':row.cancelled_at?'cancelled':'pending';
  }
  async claim(jobId:string,taskIndex:number,leaseSeconds:number):Promise<DurableWrapUpClaim|undefined>{
    const token=randomUUID();
    const row=(await this.database.query<any>(`UPDATE agent_job_wrap_up_requests
      SET claim_token=$3,claim_version=claim_version+1,claim_expires_at=now()+make_interval(secs=>$4)
      WHERE job_id=$1 AND task_index=$2 AND due_at<=now() AND completed_at IS NULL AND cancelled_at IS NULL AND reconciliation_outcome IS NULL
        AND (claim_expires_at IS NULL OR claim_expires_at<=now()) RETURNING *`,[jobId,taskIndex,token,leaseSeconds]))[0];
    return row?{jobId:String(row.job_id),taskIndex:Number(row.task_index),executionGeneration:String(row.execution_generation),principal:row.principal as StopPrincipalValue,reason:String(row.reason),dueAt:new Date(row.due_at),claimToken:token,claimVersion:Number(row.claim_version),claimExpiresAt:new Date(row.claim_expires_at)}:undefined;
  }
  async beginTeardown(claim:DurableWrapUpClaim):Promise<boolean>{
    const stoppedBy=StopPrincipal.attribution(claim.principal);
    const rows=await this.database.query(`WITH current_claim AS (
      SELECT job_id,task_index,execution_generation FROM agent_job_wrap_up_requests
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
        AND EXISTS (SELECT 1 FROM agent_task_execution_identities identity
          WHERE identity.job_id=current_claim.job_id AND identity.task_index=current_claim.task_index
            AND identity.generation=current_claim.execution_generation
            AND identity.recorded_at=(SELECT MAX(latest.recorded_at) FROM agent_task_execution_identities latest
              WHERE latest.job_id=current_claim.job_id AND latest.task_index=current_claim.task_index))
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
  async recordTeardownFailure(claim:DurableWrapUpClaim,reason:string,maxAttempts:number):Promise<'retry'|'manual-reconciliation'>{
    const row=(await this.database.query<{outcome:string|null}>(`UPDATE agent_job_wrap_up_requests SET
      teardown_attempts=teardown_attempts+1,teardown_last_error=$5,
      reconciliation_outcome=CASE WHEN teardown_attempts+1 >= $6 OR teardown_deadline_at<=now() THEN 'manual-reconciliation' ELSE reconciliation_outcome END,
      reconciliation_reason=CASE WHEN teardown_attempts+1 >= $6 OR teardown_deadline_at<=now() THEN $5 ELSE reconciliation_reason END,
      reconciled_at=CASE WHEN teardown_attempts+1 >= $6 OR teardown_deadline_at<=now() THEN now() ELSE reconciled_at END,
      claim_expires_at=CASE WHEN teardown_attempts+1 >= $6 OR teardown_deadline_at<=now() THEN NULL ELSE claim_expires_at END
      WHERE job_id=$1 AND task_index=$2 AND claim_token=$3 AND claim_version=$4
        AND completed_at IS NULL AND cancelled_at IS NULL AND reconciliation_outcome IS NULL
      RETURNING reconciliation_outcome AS outcome`,[claim.jobId,claim.taskIndex,claim.claimToken,claim.claimVersion,reason.slice(0,1000),maxAttempts]))[0];
    return row?.outcome==='manual-reconciliation'?'manual-reconciliation':'retry';
  }
  async cancel(jobId:string,taskIndex:number):Promise<void>{await this.database.query(`UPDATE agent_job_wrap_up_requests SET cancelled_at=COALESCE(cancelled_at,now()) WHERE job_id=$1 AND task_index=$2 AND completed_at IS NULL AND teardown_needed_at IS NULL`,[jobId,taskIndex]);}
  async requireManualReconciliation(jobId:string,taskIndex:number,reason:string):Promise<void>{await this.database.query(`UPDATE agent_job_wrap_up_requests SET reconciliation_outcome='manual-reconciliation',reconciliation_reason=$3,reconciled_at=now(),claim_expires_at=NULL WHERE job_id=$1 AND task_index=$2 AND completed_at IS NULL AND cancelled_at IS NULL`,[jobId,taskIndex,reason]);}
  async cancelJob(jobId:string):Promise<void>{await this.database.query(`UPDATE agent_job_wrap_up_requests SET cancelled_at=COALESCE(cancelled_at,now()) WHERE job_id=$1 AND completed_at IS NULL AND teardown_needed_at IS NULL`,[jobId]);}
}
