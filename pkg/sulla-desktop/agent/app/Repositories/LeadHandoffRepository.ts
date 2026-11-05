// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { Repository } from '@sulla/foundation';
import { AgentJob as AgentJobModel } from '../Models/AgentJob';
import type { AgentJob } from '../../tools/agents/jobRegistry';
import type { AgentJobRepository } from './AgentJobRepository';
import type { AgentJobMessagingRepository } from './AgentJobMessagingRepository';

export interface LeadHandoffSnapshot { lead: AgentJob; taskIndex: number; children: AgentJob[]; checkins: any[]; messages: any[]; inbox: any[] }
export class LeadHandoffRepository extends Repository<AgentJobModel> {
  protected readonly model = AgentJobModel;
  constructor(connection:any, private readonly jobs:AgentJobRepository, readonly messaging:AgentJobMessagingRepository){ super(connection); }
  async recordReplacementAudit(jobId:string,taskIndex:number,summary:string):Promise<void>{
    await this.connection.run(`INSERT INTO agent_job_checkins (job_id,task_index,step,summary,files_touched,blockers) VALUES($1,$2,'lead-replaced',$3,'[]'::jsonb,'[]'::jsonb)`,[jobId,taskIndex,summary]);
  }
  async snapshot(jobId:string, taskIndex:number):Promise<LeadHandoffSnapshot|undefined>{
    const lead=await this.jobs.job(jobId); const task=lead?.tasks[taskIndex];
    if(!lead||!task) return undefined;
    const [children,telemetry,messageRows,inboxRows]=await Promise.all([
      task.threadId?this.jobs.jobsForParentThread(task.threadId):Promise.resolve([]),
      this.messaging.telemetryForJob(jobId),
      this.connection.select(`SELECT id,message,created_at FROM agent_job_messages WHERE job_id=$1 AND task_index=$2 AND delivered_at IS NULL ORDER BY created_at`,[jobId,taskIndex]),
      this.connection.select(`SELECT message_id,kind,body,ids,created_at FROM agent_inbox_messages WHERE ids->>'jobId'=$1 AND COALESCE((ids->>'taskIndex')::int,-1)=$2 AND delivered_at IS NULL ORDER BY created_at`,[jobId,taskIndex]),
    ]);
    return {lead,taskIndex,children,checkins:telemetry[taskIndex]?.checkins??[],messages:messageRows,inbox:inboxRows};
  }
}
