// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { PoolClient } from 'pg';
import type { PostgresClient } from '../../database/PostgresClient';
import type { CustodyActor, CustodyAuditRecord, CustodyMoveInput, CustodyMoveResult, CustodyOwner, CustodyRecord } from '../Services/JobCustodyTypes';

export type CustodyLockedOperation<T> = (client: PoolClient, effectiveOwner: CustodyRecord) => Promise<T>;
export type CustodyTransactionKind = 'move'|'producer';
export type CustodyTransactionPhase = 'locked'|'committing'|'committed';
export interface CustodyTransactionObservation {kind:CustodyTransactionKind;phase:CustodyTransactionPhase;jobId:string;taskIndex?:number;}
export interface CustodyTransactionObserver {observe(event:CustodyTransactionObservation):Promise<void>;}
export class NoopCustodyTransactionObserver implements CustodyTransactionObserver {async observe(_event:CustodyTransactionObservation):Promise<void>{}}

export class AgentJobCustodyRepository {
  constructor(private readonly database: Pick<PostgresClient, 'query'|'transaction'>,private readonly observer:CustodyTransactionObserver=new NoopCustodyTransactionObserver()) {}

  async resolveOwner(jobId: string, taskIndex?: number): Promise<CustodyRecord|undefined> {
    const rows = await this.database.query<any>(this.resolveSql(false), [jobId, taskIndex ?? null]);
    return rows[0] ? this.mapRecord(rows[0], taskIndex) : undefined;
  }

  /**
   * The single custody/inbox producer protocol. Every scope first takes the
   * job advisory lock; task scopes then take their task lock. Custody rows are
   * resolved/locked before any inbox operation, so a job move, task move, and
   * producer for the same effective scope cannot observe different owners.
   */
  async withCustodyLock<T>(jobId: string, taskIndex: number|undefined, operation: CustodyLockedOperation<T>): Promise<T|undefined> {
    const result=await this.database.transaction<T|undefined>(async client => {
      const owner = await this.resolveOwnerInTransaction(client, jobId, taskIndex,'producer');
      if(!owner)return undefined;
      const value=await operation(client, owner);
      await this.observe('producer','committing',jobId,taskIndex);
      return value;
    });
    await this.observe('producer','committed',jobId,taskIndex);
    return result;
  }

  async move(input: CustodyMoveInput, expected: CustodyRecord, changedAt: Date): Promise<CustodyMoveResult> {
    const result=await this.database.transaction<CustodyMoveResult>(async client => {
      const current = await this.resolveOwnerInTransaction(client, input.jobId, input.taskIndex,'move');
      if (!current) return { ok:false, code:'not-found', message:`Job ${input.jobId} was not found.` };
      if (!this.sameSnapshot(current, expected)) {
        return { ok:false, code:'version-conflict', message:'Custody changed concurrently; retry.', current, retryable:true };
      }

      const gated=await this.resolveDrainDestination(client,input.to);
      if(gated.retry)return {ok:false,code:'replacement-draining',message:'Destination lead is being replaced; retry after its replacement is persisted.',current,retryable:true};
      const effectiveInput={...input,to:gated.owner??input.to};
      const inbox = await client.query<any>(`${this.inboxScopeSql(input.taskIndex)} FOR UPDATE`, [input.jobId, input.taskIndex ?? null]);
      const activeLease = inbox.rows.find(row => row.lease_owner && row.lease_expires_at && new Date(row.lease_expires_at) > changedAt);
      if (activeLease) return { ok:false, code:'lease-active', message:'An inbox delivery lease is active; retry after it expires.', current, retryable:true };

      const nextVersion = current.version + 1;
      const row = await this.writeCustody(client, effectiveInput, current, nextVersion, changedAt);
      if (!row) return { ok:false, code:'version-conflict', message:'Custody changed concurrently; retry.', current, retryable:true };

      await this.appendAudit(client, effectiveInput, current, nextVersion, changedAt);
      await client.query(`UPDATE agent_inbox_messages SET receiver_channel=$3,receiver_thread_id=$4,receiver_agent_id=$5,lease_owner=NULL,lease_expires_at=NULL
        WHERE message_id IN (SELECT message_id FROM (${this.inboxScopeSql(input.taskIndex)}) scoped)`,
      [input.jobId,input.taskIndex ?? null,effectiveInput.to.channel,effectiveInput.to.threadId,effectiveInput.to.agentId]);
      await this.appendCustodyNotifications(client,effectiveInput,current,nextVersion,changedAt);
      await this.observe('move','committing',input.jobId,input.taskIndex);
      return { ok:true, previous:current, current:this.mapRecord(row,input.taskIndex) };
    });
    await this.observe('move','committed',input.jobId,input.taskIndex);
    return result;
  }

  /** Serialize adoption into a lead with its durable drain gate. */
  private async resolveDrainDestination(client:PoolClient,destination:CustodyOwner):Promise<{owner?:CustodyOwner;retry:boolean}>{
    const row=(await client.query<any>(`SELECT r.phase,r.replacement_thread_id,r.replacement_agent_id
      FROM agent_lead_replacements r JOIN agent_jobs j ON j.job_id=r.old_job_id
      WHERE j.tasks->r.old_task_index->>'threadId'=$1 FOR UPDATE OF r`,[destination.threadId])).rows[0];
    if(!row)return {retry:false};
    if(!row.replacement_thread_id)return {retry:true};
    return {retry:false,owner:{channel:destination.channel,threadId:String(row.replacement_thread_id),agentId:String(row.replacement_agent_id)}};
  }

  async history(jobId: string): Promise<CustodyAuditRecord[]> {
    return (await this.database.query<any>(`SELECT * FROM agent_job_custody_audit WHERE job_id=$1 ORDER BY changed_at,id`,[jobId])).map(row=>this.mapAudit(row));
  }

  private async resolveOwnerInTransaction(client: PoolClient, jobId: string, taskIndex: number|undefined,kind:CustodyTransactionKind): Promise<CustodyRecord|undefined> {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1), -1)`, [jobId]);
    if (taskIndex !== undefined) await client.query(`SELECT pg_advisory_xact_lock(hashtext($1), $2)`, [jobId, taskIndex]);
    await this.observe(kind,'locked',jobId,taskIndex);
    const result = await client.query(this.resolveSql(true), [jobId, taskIndex ?? null]);
    return result.rows[0] ? this.mapRecord(result.rows[0], taskIndex) : undefined;
  }

  private observe(kind:CustodyTransactionKind,phase:CustodyTransactionPhase,jobId:string,taskIndex?:number):Promise<void>{
    return this.observer.observe({kind,phase,jobId,...(taskIndex===undefined?{}:{taskIndex})});
  }

  private inboxScopeSql(taskIndex?: number): string {
    const taskFilter = taskIndex === undefined
      ? `AND $2::int IS NULL AND (m.ids->>'taskIndex' IS NULL OR NOT EXISTS (SELECT 1 FROM agent_job_custody override WHERE override.job_id=$1 AND override.task_index=(m.ids->>'taskIndex')::int))`
      : `AND m.ids->>'taskIndex'=$2::text`;
    return `SELECT m.message_id,m.lease_owner,m.lease_expires_at FROM agent_inbox_messages m
      WHERE m.ids->>'jobId'=$1 ${taskFilter} AND m.delivered_at IS NULL`;
  }

  private async writeCustody(client:PoolClient,input:CustodyMoveInput,current:CustodyRecord,nextVersion:number,changedAt:Date):Promise<any> {
    if (input.taskIndex === undefined) {
      const updated = await client.query<any>(`UPDATE agent_job_custody SET owner_channel=$2,owner_thread_id=$3,owner_agent_id=$4,version=$5,changed_at=$6
        WHERE job_id=$1 AND task_index IS NULL AND version=$7 RETURNING *`, [input.jobId,input.to.channel,input.to.threadId,input.to.agentId,nextVersion,changedAt,current.version]);
      if (updated.rows[0] || current.version !== 0) return updated.rows[0];
      return (await client.query<any>(`INSERT INTO agent_job_custody
        (job_id,task_index,owner_channel,owner_thread_id,owner_agent_id,version,changed_at) VALUES($1,NULL,$2,$3,$4,$5,$6) RETURNING *`,
      [input.jobId,input.to.channel,input.to.threadId,input.to.agentId,nextVersion,changedAt])).rows[0];
    }
    return (await client.query<any>(`INSERT INTO agent_job_custody
      (job_id,task_index,owner_channel,owner_thread_id,owner_agent_id,version,changed_at)
      VALUES($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (job_id,task_index) WHERE task_index IS NOT NULL DO UPDATE SET
        owner_channel=EXCLUDED.owner_channel,owner_thread_id=EXCLUDED.owner_thread_id,owner_agent_id=EXCLUDED.owner_agent_id,
        version=EXCLUDED.version,changed_at=EXCLUDED.changed_at
      WHERE agent_job_custody.version=$8 RETURNING *`,
    [input.jobId,input.taskIndex,input.to.channel,input.to.threadId,input.to.agentId,nextVersion,changedAt,current.version])).rows[0];
  }

  private async appendCustodyNotifications(client:PoolClient,input:CustodyMoveInput,current:CustodyRecord,nextVersion:number,changedAt:Date):Promise<void> {
    const scope=input.taskIndex===undefined?'job':String(input.taskIndex);
    const prefix=`custody:${input.jobId}:${scope}:${nextVersion}`;
    const actor=input.actor.agentId;
    const oldBody=`Job ${input.jobId} (${scope}) moved to ${input.to.agentId} by ${actor}: ${input.reason}`;
    const newBody=`[Custody handoff] Job ${input.jobId} (${scope}) moved from ${current.agentId}; reason: ${input.reason}`;
    const ids=(messageId:string)=>JSON.stringify({messageId,jobId:input.jobId,...(input.taskIndex===undefined?{}:{taskIndex:input.taskIndex}),custodyVersion:nextVersion});
    await client.query(`INSERT INTO agent_inbox_messages
      (message_id,receiver_channel,receiver_thread_id,receiver_agent_id,sender,kind,body,ids,created_at)
      VALUES ($1,$2,$3,$4,'custody','peer',$5,$6::jsonb,$11),($7,$8,$9,$10,'custody','peer',$12,$13::jsonb,$11)
      ON CONFLICT(message_id) DO NOTHING`,[
      `${prefix}:old`,current.channel,current.threadId,current.agentId,oldBody,ids(`${prefix}:old`),
      `${prefix}:new`,input.to.channel,input.to.threadId,input.to.agentId,changedAt,newBody,ids(`${prefix}:new`),
    ]);
    await client.query(`INSERT INTO agent_job_messages(id,job_id,task_index,message,created_at)
      SELECT $1 || ':' || (task.ordinality-1)::text,$2,task.ordinality-1,$3,$4
      FROM agent_jobs j CROSS JOIN LATERAL jsonb_array_elements(j.tasks) WITH ORDINALITY task(value,ordinality)
      WHERE j.job_id=$2 AND ($5::int IS NULL OR task.ordinality-1=$5)
        AND task.value->>'status' IN ('queued','running','parked')
      ON CONFLICT(id) DO NOTHING`,[`${prefix}:worker`,input.jobId,`[Manager changed] Your manager is now ${input.to.agentId}/${input.to.channel} (was ${current.agentId}/${current.channel})`,changedAt,input.taskIndex??null]);
  }

  private async appendAudit(client:PoolClient,input:CustodyMoveInput,current:CustodyRecord,nextVersion:number,changedAt:Date):Promise<void> {
    await client.query(`INSERT INTO agent_job_custody_audit
      (job_id,task_index,from_channel,from_thread_id,from_agent_id,to_channel,to_thread_id,to_agent_id,
       changed_by_kind,changed_by_channel,changed_by_thread_id,changed_by_agent_id,reason,version,changed_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [input.jobId,input.taskIndex??null,current.channel,current.threadId,current.agentId,input.to.channel,input.to.threadId,input.to.agentId,
      input.actor.kind,input.actor.kind==='agent'?input.actor.channel:null,input.actor.kind==='agent'?input.actor.threadId:null,input.actor.kind==='agent'?input.actor.agentId:null,input.reason,nextVersion,changedAt]);
  }

  private resolveSql(lock: boolean): string { return `SELECT c.*, COALESCE(c.version,0) AS version,
      COALESCE(c.owner_channel,j.parent_channel) AS owner_channel, COALESCE(c.owner_thread_id,j.parent_thread_id) AS owner_thread_id,
      COALESCE(c.owner_agent_id,j.parent_agent_id) AS owner_agent_id
    FROM agent_jobs j LEFT JOIN LATERAL (
      SELECT * FROM agent_job_custody c WHERE c.job_id=j.job_id AND (c.task_index=$2 OR c.task_index IS NULL)
      ORDER BY c.task_index NULLS LAST LIMIT 1
    ) c ON true WHERE j.job_id=$1 AND COALESCE(c.owner_channel,j.parent_channel) IS NOT NULL
      AND COALESCE(c.owner_thread_id,j.parent_thread_id) IS NOT NULL AND COALESCE(c.owner_agent_id,j.parent_agent_id) IS NOT NULL${lock?' FOR UPDATE OF j':''}`; }
  private sameSnapshot(left:CustodyRecord,right:CustodyRecord):boolean{return left.version===right.version&&left.channel===right.channel&&left.threadId===right.threadId&&left.agentId===right.agentId;}
  private mapRecord(row:any, taskIndex?:number):CustodyRecord { return {jobId:String(row.job_id),...(taskIndex===undefined?{}:{taskIndex}),channel:String(row.owner_channel),threadId:String(row.owner_thread_id),agentId:String(row.owner_agent_id),version:Number(row.version),changedAt:new Date(row.changed_at??0)}; }
  private mapOwner(row:any,prefix:string):CustodyOwner{return {channel:String(row[`${prefix}_channel`]),threadId:String(row[`${prefix}_thread_id`]),agentId:String(row[`${prefix}_agent_id`])};}
  private mapAudit(row:any):CustodyAuditRecord { const actor:CustodyActor=row.changed_by_kind==='human'?{kind:'human'}:{kind:'agent',...this.mapOwner(row,'changed_by')}; return {jobId:String(row.job_id),...(row.task_index===null?{}:{taskIndex:Number(row.task_index)}),from:this.mapOwner(row,'from'),to:this.mapOwner(row,'to'),actor,reason:String(row.reason),version:Number(row.version),changedAt:new Date(row.changed_at)}; }
}
