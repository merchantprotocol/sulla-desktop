// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { appendAuditLine, type AuditEventInput, type AuditEventLine } from './auditChain.js';
import { lockStoredNamespace } from './storedNamespace.js';
import { auditContext } from './auditContext.js';
import { TransactionRunner } from './FilesTransaction.js';

import type pg from 'pg';

export function validateAuditEvent(value:unknown):AuditEventInput {
  const fail = () => { throw Object.assign(new Error('Invalid audit event'), {status:400}) };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const input = value as Record<string,unknown>;
  if (!['file','vault-secret'].includes(String(input.subjectKind)) || typeof input.subjectId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,200}$/.test(input.subjectId) || input.subjectId.includes('..')) return fail();
  for (const key of ['actor','action','result']) if (typeof input[key] !== 'string' || !input[key] || (input[key] as string).length > 256) return fail();
  for (const key of ['path','requestId']) if (input[key] !== undefined && (typeof input[key] !== 'string' || (input[key] as string).length > 4096)) return fail();
  const inspect = (value:unknown):void => {
    if (!value || typeof value !== 'object') return;
    for (const [key,item] of Object.entries(value)) {
      if (['value','secret','password','token'].includes(key.toLowerCase())) fail();
      inspect(item);
    }
  };
  if (input.meta !== undefined) {
    if (!input.meta || typeof input.meta !== 'object' || Array.isArray(input.meta)) return fail();
    inspect(input.meta);
  }
  return {subjectKind:String(input.subjectKind),subjectId:input.subjectId,action:String(input.action),actor:String(input.actor),result:String(input.result),
    ...(input.path !== undefined ? {path:input.path as string} : {}), ...(input.requestId !== undefined ? {requestId:input.requestId as string} : {}),
    ...(input.meta !== undefined ? {meta:input.meta as Record<string,unknown>} : {})};
}

export interface AuditStagedContent { readonly collectionId:string; readonly size:number }

/**
 * Queue and append are separate: a failed append never rolls back the user's operation.
 *
 * Each delivery reads the subject's audit log, appends the next chained line and encrypts the
 * new content with no transaction open; the transaction only re-checks that nothing moved on
 * (the spool row is still pending, the log is still at the version that was read) and records
 * the version. The old shape held BEGIN and the Logs namespace lock while it read the log
 * through the pool and wrote chunks, which under load waited on the pool past Postgres's
 * idle-in-transaction timeout and then kept using the terminated client.
 */
export class FileAuditWriter<Staged extends AuditStagedContent = AuditStagedContent> {
  private running = false;
  private readonly transactions:TransactionRunner;
  constructor(private readonly db:pg.Pool, private readonly read:(id:string,versionId:string)=>Promise<Buffer>,
    private readonly stage:(collectionId:string,bytes:Buffer)=>Promise<Staged>,
    private readonly write:(client:pg.PoolClient,collectionId:string,path:string,bytes:Buffer,staged:Staged,fileId?:string)=>Promise<unknown>,
    transactions?:TransactionRunner) { this.transactions = transactions ?? new TransactionRunner(db) }

  async drain():Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await auditContext.run({actor:'sulla-files',requestId:''}, async() => {
        for (let count=0; count<100; count++) {
          let eventId:string | undefined;
          try {
            const pending = (await this.db.query('SELECT * FROM files_audit_spool ORDER BY id LIMIT 1')).rows[0];
            if (!pending) break;
            eventId=String(pending.id);
            const input=validateAuditEvent(pending.event);
            const logs=(await this.db.query("SELECT id FROM collections WHERE system_area='logs'")).rows[0];
            if (!logs) throw new Error('Logs system collection is not initialized');
            const path=`audit/${input.subjectKind==='vault-secret'?'vault':'files'}/${input.subjectId}.jsonl`;
            const existing=(await this.db.query('SELECT id,current_version_id FROM files WHERE collection_id=$1 AND path=$2',[logs.id,path])).rows[0];
            const bytes=existing ? await this.read(existing.id,existing.current_version_id) : Buffer.alloc(0);
            const lines=bytes.toString('utf8').trimEnd().split('\n').filter(Boolean);
            const previous=lines.length ? JSON.parse(lines.at(-1)!) as AuditEventLine : undefined;
            const line=appendAuditLine(input,previous,pending.event.ts ?? new Date(pending.created_at).toISOString());
            const next=Buffer.concat([bytes,Buffer.from(`${JSON.stringify(line)}\n`)]);
            const staged=await this.stage(logs.id,next);
            const outcome=await this.transactions.run('audit-append', async client => {
              // One delivery lock preserves ordering, including across multiple service instances.
              const lock = await client.query("SELECT pg_try_advisory_xact_lock(hashtextextended('files-audit-delivery',0)) locked");
              if (!lock.rows[0]?.locked) return 'busy' as const;
              if (!(await client.query('SELECT id FROM files_audit_spool WHERE id=$1 FOR UPDATE',[pending.id])).rowCount) return 'delivered' as const;
              await lockStoredNamespace(client,logs.id,path);
              const current=(await client.query('SELECT id,current_version_id FROM files WHERE collection_id=$1 AND path=$2 FOR UPDATE',[logs.id,path])).rows[0];
              if ((current?.current_version_id ?? null) !== (existing?.current_version_id ?? null)) return 'stale' as const;
              await this.write(client,logs.id,path,next,staged,existing?.id);
              await client.query('DELETE FROM files_audit_spool WHERE id=$1',[pending.id]);
              return 'appended' as const;
            });
            if (outcome==='busy') break;
          } catch(error) {
            console.error('[SullaFiles] audit append failed; event retained in retry spool', {eventId,error:error instanceof Error?error.message:'unknown error'});
            if (eventId) await this.db.query('UPDATE files_audit_spool SET last_error=$2 WHERE id=$1',[eventId,'Audit append failed; retry pending']).catch(()=>undefined);
            break;
          }
        }
      });
    } finally { this.running=false }
  }
}
