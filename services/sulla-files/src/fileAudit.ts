// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { appendAuditLine, type AuditEventInput, type AuditEventLine } from './auditChain.js';
import { auditContext } from './auditContext.js';
import { TransactionRunner } from './FilesTransaction.js';
import { AuditSpoolRepository, type AuditLogFileRow, type AuditSpoolRow } from './Repositories/AuditSpoolRepository.js';
import { StoredNamespaceRepository } from './Repositories/StoredNamespaceRepository.js';
import { StoredNamespaceGuard } from './Services/StoredNamespaceGuard.js';

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

interface PreparedAuditLog<Staged extends AuditStagedContent> {
  path:string;
  existing:AuditLogFileRow | undefined;
  content:Buffer;
  staged:Staged;
}

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
  private readonly spool:AuditSpoolRepository;
  private readonly namespace:StoredNamespaceGuard;
  constructor(db:pg.Pool, private readonly read:(id:string,versionId:string)=>Promise<Buffer>,
    private readonly stage:(collectionId:string,bytes:Buffer)=>Promise<Staged>,
    private readonly write:(client:pg.PoolClient,collectionId:string,path:string,bytes:Buffer,staged:Staged,fileId?:string)=>Promise<unknown>,
    transactions?:TransactionRunner, spool?:AuditSpoolRepository, namespace?:StoredNamespaceGuard) {
    this.transactions = transactions ?? new TransactionRunner(db);
    this.spool = spool ?? new AuditSpoolRepository(db);
    this.namespace = namespace ?? new StoredNamespaceGuard(new StoredNamespaceRepository());
  }

  async drain():Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await auditContext.run({actor:'sulla-files',requestId:''}, async() => {
        for (let count=0; count<100; count++) {
          const pending = await this.spool.pendingBatch(100);
          if (!pending.length) break;
          try {
            const logs = await this.prepareBatch(pending);
            const validIds = pending.filter(row => !logs.invalidIds.has(String(row.id))).map(row => row.id);
            const outcome=await this.transactions.run('audit-append', async client => {
              // One delivery lock preserves global spool ordering across service instances.
              if (!await this.spool.tryDeliveryLock(client)) return 'busy' as const;
              const locked = await this.spool.lockPendingBatch(client, pending.map(row => row.id));
              if (locked.length !== pending.length) return 'stale' as const;
              for (const item of logs.prepared) {
                await this.namespace.lock(client, logs.collectionId!, item.path);
                const current=await this.spool.lockLogFile(client, logs.collectionId!, item.path);
                if ((current?.current_version_id ?? null) !== (item.existing?.current_version_id ?? null)) return 'stale' as const;
              }
              for (const item of logs.prepared) {
                await this.write(client, logs.collectionId!, item.path, item.content, item.staged, item.existing?.id);
              }
              for (const id of logs.invalidIds) await this.spool.recordFailureInTransaction(client, id, 'Audit append failed; retry pending');
              await this.spool.deletePendingBatch(client, validIds);
              return 'appended' as const;
            });
            if (outcome==='busy') break;
          } catch(error) {
            console.error('[SullaFiles] audit append batch failed; events retained in retry spool', {count:pending.length,error:error instanceof Error?error.message:'unknown error'});
            for (const row of pending) await this.spool.recordFailure(String(row.id),'Audit append failed; retry pending').catch(()=>undefined);
            break;
          }
        }
      });
    } finally { this.running=false }
  }

  private async prepareBatch(pending:AuditSpoolRow[]):Promise<{collectionId:string | undefined; prepared:Array<PreparedAuditLog<Staged>>; invalidIds:Set<string>}> {
    const invalidIds = new Set<string>();
    const grouped = new Map<string, { rows:Array<{input:AuditEventInput; ts:string}>; existing?:AuditLogFileRow }>();
    for (const row of pending) {
      try {
        const input=validateAuditEvent(row.event);
        const path=`audit/${input.subjectKind==='vault-secret'?'vault':'files'}/${input.subjectId}.jsonl`;
        let group=grouped.get(path);
        if (!group) { group={rows:[]}; grouped.set(path,group) }
        group.rows.push({input,ts:row.event.ts ?? new Date(row.created_at).toISOString()});
      } catch { invalidIds.add(String(row.id)) }
    }
    if (!grouped.size) return {collectionId:undefined,prepared:[],invalidIds};
    const collectionId=await this.spool.findLogsCollectionId();
    if (!collectionId) throw new Error('Logs system collection is not initialized');
    const prepared = await Promise.all([...grouped].map(async([path,group]):Promise<PreparedAuditLog<Staged>> => {
      const existing=await this.spool.findLogFile(collectionId,path);
      const bytes=existing?.current_version_id ? await this.read(existing.id,existing.current_version_id) : Buffer.alloc(0);
      let next=bytes;
      let previous:AuditEventLine | undefined;
      const lastLine=bytes.toString('utf8').trimEnd().split('\n').filter(Boolean).at(-1);
      if (lastLine) previous=JSON.parse(lastLine) as AuditEventLine;
      const additions:Buffer[]=[];
      for (const row of group.rows) {
        const line=appendAuditLine(row.input,previous,row.ts);
        additions.push(Buffer.from(`${JSON.stringify(line)}\n`));
        previous=line;
      }
      next=Buffer.concat([next,...additions]);
      return {path,existing,content:next,staged:await this.stage(collectionId,next)};
    }));
    return {collectionId,prepared,invalidIds};
  }
}
