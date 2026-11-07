// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { Repository } from '@sulla/foundation';
import { AgentJob as AgentJobModel } from '../Models/AgentJob';
import type { AgentJob } from '../../tools/agents/jobRegistry';
import type { AgentJobRepository } from './AgentJobRepository';
import type { AgentJobMessagingRepository } from './AgentJobMessagingRepository';
import type { CustodyTransactionClient } from '../Services/JobCustodyTypes';

export interface LeadChildTask { job:AgentJob; taskIndex:number }
export interface LeadHandoffSnapshot { lead: AgentJob; taskIndex: number; children: LeadChildTask[]; checkins: any[]; messages: any[]; inbox: any[]; completions:any[] }
export type LeadReplacementPhase='intent'|'launched'|'children_moved'|'wrap_requested'|'wrapped';
export interface LeadReplacementOperation { oldJobId:string; oldTaskIndex:number; launchKey:string; targetAgentId:string; phase:LeadReplacementPhase; replacementJobId?:string; replacementTaskIndex?:number; replacementChannel?:string; replacementThreadId?:string; replacementAgentId?:string; childProgress:Record<string,{moved:boolean;error?:string}>; auditDone:boolean; wrapUpDone:boolean }
export class LeadHandoffRepository extends Repository<AgentJobModel> {
  protected readonly model = AgentJobModel;
  constructor(connection:any, private readonly jobs:AgentJobRepository, readonly messaging:AgentJobMessagingRepository){ super(connection); }
  async recordReplacementAudit(jobId:string,taskIndex:number,summary:string):Promise<void>{
    await this.connection.run(`INSERT INTO agent_job_checkins (job_id,task_index,step,summary,files_touched,blockers) VALUES($1,$2,'lead-replaced',$3,'[]'::jsonb,'[]'::jsonb)`,[jobId,taskIndex,summary]);
  }
  async operation(client:CustodyTransactionClient,jobId:string,taskIndex:number,targetAgentId:string):Promise<LeadReplacementOperation>{
    const existing=await client.query<any>(`SELECT * FROM agent_lead_replacements WHERE old_job_id=$1 AND old_task_index=$2 FOR UPDATE`,[jobId,taskIndex]);
    if(existing.rows[0])return this.mapOperation(existing.rows[0]);
    const created=await client.query<any>(`INSERT INTO agent_lead_replacements(old_job_id,old_task_index,launch_key,replacement_agent_id) VALUES($1,$2,$3,$4) RETURNING *`,[jobId,taskIndex,`lead-replacement:${jobId}:${taskIndex}`,targetAgentId]);
    return this.mapOperation(created.rows[0]);
  }
  async loadOperation(jobId:string,taskIndex:number):Promise<LeadReplacementOperation|undefined>{
    const rows=await this.connection.select(`SELECT * FROM agent_lead_replacements WHERE old_job_id=$1 AND old_task_index=$2`,[jobId,taskIndex]);
    return rows[0]?this.mapOperation(rows[0]):undefined;
  }
  async saveLaunched(operation:LeadReplacementOperation,replacement:{jobId:string;taskIndex:number;channel:string;threadId:string;agentId:string}):Promise<LeadReplacementOperation>{
    const rows=await this.connection.select(`UPDATE agent_lead_replacements SET replacement_job_id=$3,replacement_task_index=$4,replacement_channel=$5,replacement_thread_id=$6,replacement_agent_id=$7,phase='launched',updated_at=now() WHERE old_job_id=$1 AND old_task_index=$2 AND phase='intent' RETURNING *`,[operation.oldJobId,operation.oldTaskIndex,replacement.jobId,replacement.taskIndex,replacement.channel,replacement.threadId,replacement.agentId]);
    const winner=rows[0]??(await this.connection.select(`SELECT * FROM agent_lead_replacements WHERE old_job_id=$1 AND old_task_index=$2`,[operation.oldJobId,operation.oldTaskIndex]))[0];
    if(!winner)throw new Error('Replacement operation disappeared while saving launch.');
    return this.mapOperation(winner);
  }
  async saveOperation(client:CustodyTransactionClient,operation:LeadReplacementOperation):Promise<void>{
    await client.query(`UPDATE agent_lead_replacements SET replacement_job_id=$3,replacement_task_index=$4,replacement_thread_id=$5,child_progress=$6::jsonb,audit_done=$7,wrap_up_done=$8,phase=$9,updated_at=now() WHERE old_job_id=$1 AND old_task_index=$2`,[operation.oldJobId,operation.oldTaskIndex,operation.replacementJobId??null,operation.replacementTaskIndex??null,operation.replacementThreadId??null,JSON.stringify(operation.childProgress),operation.auditDone,operation.wrapUpDone,operation.phase]);
  }
  private mapOperation(row:any):LeadReplacementOperation{return {oldJobId:String(row.old_job_id),oldTaskIndex:Number(row.old_task_index),launchKey:String(row.launch_key),targetAgentId:String(row.replacement_agent_id),phase:row.phase??(row.wrap_up_done?'wrapped':row.replacement_job_id?'launched':'intent'),replacementJobId:row.replacement_job_id??undefined,replacementTaskIndex:row.replacement_task_index===null?undefined:Number(row.replacement_task_index),replacementChannel:row.replacement_channel??undefined,replacementThreadId:row.replacement_thread_id??undefined,replacementAgentId:row.replacement_agent_id??undefined,childProgress:row.child_progress??{},auditDone:Boolean(row.audit_done),wrapUpDone:Boolean(row.wrap_up_done)};}
  async markChildrenMoved(client:CustodyTransactionClient,operation:LeadReplacementOperation):Promise<void>{await client.query(`UPDATE agent_lead_replacements SET phase='children_moved',child_progress=$3::jsonb,updated_at=now() WHERE old_job_id=$1 AND old_task_index=$2`,[operation.oldJobId,operation.oldTaskIndex,JSON.stringify(operation.childProgress)]);operation.phase='children_moved';}
  async lockOperation(client:CustodyTransactionClient,operation:LeadReplacementOperation):Promise<LeadReplacementOperation>{const row=(await client.query<any>(`SELECT * FROM agent_lead_replacements WHERE old_job_id=$1 AND old_task_index=$2 FOR UPDATE`,[operation.oldJobId,operation.oldTaskIndex])).rows[0];if(!row)throw new Error('Replacement operation disappeared while draining children.');return this.mapOperation(row);}
  async claimAudit(client:CustodyTransactionClient,operation:LeadReplacementOperation,summary:string):Promise<boolean>{
    const result=await client.query(`WITH claimed AS (UPDATE agent_lead_replacements SET audit_claimed=TRUE WHERE old_job_id=$1 AND old_task_index=$2 AND audit_claimed=FALSE RETURNING 1), inserted AS (INSERT INTO agent_job_checkins (job_id,task_index,step,summary,files_touched,blockers) SELECT $1,$2,'lead-replaced',$3,'[]'::jsonb,'[]'::jsonb FROM claimed) UPDATE agent_lead_replacements SET audit_done=TRUE,updated_at=now() WHERE old_job_id=$1 AND old_task_index=$2 AND EXISTS(SELECT 1 FROM claimed) RETURNING 1`,[operation.oldJobId,operation.oldTaskIndex,summary]);
    if(result.rows.length){operation.auditDone=true;return true;} return false;
  }
  async finishWrapUp(operation:LeadReplacementOperation):Promise<void>{operation.wrapUpDone=true;operation.phase='wrapped';await this.connection.run(`UPDATE agent_lead_replacements SET wrap_up_done=TRUE,phase='wrapped',updated_at=now() WHERE old_job_id=$1 AND old_task_index=$2`,[operation.oldJobId,operation.oldTaskIndex]);}
  async markWrapRequested(operation:LeadReplacementOperation):Promise<void>{operation.phase='wrap_requested';await this.connection.run(`UPDATE agent_lead_replacements SET phase='wrap_requested',updated_at=now() WHERE old_job_id=$1 AND old_task_index=$2 AND phase='children_moved'`,[operation.oldJobId,operation.oldTaskIndex]);}
  async snapshot(jobId:string, taskIndex:number):Promise<LeadHandoffSnapshot|undefined>{
    const lead=await this.jobs.job(jobId); const task=lead?.tasks[taskIndex];
    if(!lead||!task) return undefined;
    const [children,telemetry,messageRows,inboxRows,completionRows]=await Promise.all([
      task.threadId?this.listDirectChildren(task.threadId):Promise.resolve([]),
      this.messaging.telemetryForJob(jobId),
      this.connection.select(`SELECT id,message,created_at FROM agent_job_messages WHERE job_id=$1 AND task_index=$2 AND delivered_at IS NULL ORDER BY created_at`,[jobId,taskIndex]),
      this.connection.select(`SELECT message_id,kind,body,ids,created_at FROM agent_inbox_messages WHERE ids->>'jobId'=$1 AND COALESCE((ids->>'taskIndex')::int,-1)=$2 AND delivered_at IS NULL ORDER BY created_at`,[jobId,taskIndex]),
      this.connection.select(`SELECT h.job_id,h.task_index,h.task_status,h.summary,h.completion,h.result FROM agent_job_result_history h
        JOIN agent_jobs j ON j.job_id=h.job_id
        CROSS JOIN LATERAL jsonb_array_elements(j.tasks) WITH ORDINALITY task(value,ordinality)
        LEFT JOIN agent_job_custody task_c ON task_c.job_id=j.job_id AND task_c.task_index=(task.ordinality-1)
        LEFT JOIN agent_job_custody job_c ON job_c.job_id=j.job_id AND job_c.task_index IS NULL
        WHERE h.task_index=(task.ordinality-1) AND h.completion_delivered_at IS NULL
          AND COALESCE(task_c.owner_thread_id,job_c.owner_thread_id,j.parent_thread_id)=$1
        ORDER BY h.returned_at`,[task.threadId??'']),
    ]);
    return {lead,taskIndex,children,checkins:telemetry[taskIndex]?.checkins??[],messages:messageRows,inbox:inboxRows,completions:completionRows};
  }
  async listDirectChildren(ownerThread:string,client?:CustodyTransactionClient):Promise<LeadChildTask[]>{
    const sql=`SELECT j.*,(task.ordinality-1)::int AS resolved_task_index FROM agent_jobs j CROSS JOIN LATERAL jsonb_array_elements(j.tasks) WITH ORDINALITY task(value,ordinality)
      LEFT JOIN agent_job_custody task_c ON task_c.job_id=j.job_id AND task_c.task_index=(task.ordinality-1)
      LEFT JOIN agent_job_custody job_c ON job_c.job_id=j.job_id AND job_c.task_index IS NULL
      WHERE COALESCE(task_c.owner_thread_id,job_c.owner_thread_id,j.parent_thread_id)=$1 ORDER BY j.job_id,task.ordinality`;
    const rows=client?(await client.query<any>(sql,[ownerThread])).rows:await this.connection.select(sql,[ownerThread]);
    return rows.map(row=>({job:this.jobs.map(row),taskIndex:Number(row.resolved_task_index)}));
  }
}
