// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { AgentJob } from '../../tools/agents/jobRegistry';
import type { CustodyTransactionClient } from '../Services/JobCustodyTypes';

/** Persists a job state through an existing custody transaction. */
export class AgentJobStateClientWriter {
  async write(client:CustodyTransactionClient,job:AgentJob):Promise<boolean>{
    const result=await client.query<any>(`UPDATE agent_jobs SET status=CASE WHEN status='stopped' THEN status ELSE $2 END,
      tasks=$3::jsonb,results=$4::jsonb,error=$5,finished_at=CASE WHEN $6::bigint IS NULL THEN NULL ELSE to_timestamp($6 / 1000.0) END,
      waiting_on_children=$7,completion_delivered_at=CASE WHEN $8::bigint IS NULL THEN NULL ELSE to_timestamp($8 / 1000.0) END,
      dismissed_at=CASE WHEN $9::bigint IS NULL THEN NULL ELSE to_timestamp($9 / 1000.0) END,
      restart_resume_count=$10,stopped_by=$11::jsonb,stop_reason=$12 WHERE job_id=$1 RETURNING job_id`,
    [job.jobId,job.status,JSON.stringify(job.tasks),JSON.stringify(job.results),job.error??null,job.finishedAt,job.waitingOnChildren??0,
      job.completionDeliveredAt??null,job.dismissedAt??null,job.restartResumeCount??0,job.stoppedBy?JSON.stringify(job.stoppedBy):null,job.stopReason??null]);
    return result.rows.length===1;
  }
}
