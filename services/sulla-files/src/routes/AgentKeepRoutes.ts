// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type express from 'express';
import type pg from 'pg';

import type { Config } from '../config.js';
import type { TransactionRunner } from '../FilesTransaction.js';
import type { FilesAccessGate, RequestWithIdentity } from '../Http/FilesAccessGate.js';
import { FilesRequestInput } from '../Http/FilesRequestInput.js';
import { HttpError } from '../Http/HttpError.js';
import type { RequestAuditLog } from '../Http/RequestAuditLog.js';
import { loadFileContent } from '../preview.js';
import type { AgentKeepRepository } from '../Repositories/AgentKeepRepository.js';
import type { VersionWriter } from '../Services/VersionWriter.js';
import type { Store } from '../store.js';
import { lockStoredNamespace } from '../storedNamespace.js';
import type { StagedVersionContent } from '../VersionContentStager.js';

const { cleanPath } = FilesRequestInput;

/**
 * Keeping agent output in a permanent collection (moved from app.ts): one agent file, or every live
 * file of a scratch run. Content is read and staged first; the transaction locks both namespaces in
 * id order, re-checks each source, writes the kept version, trashes the source and records provenance.
 */
export class AgentKeepRoutes {
  constructor(
    private readonly db:pg.Pool,
    private readonly config:Config,
    private readonly store:Store,
    private readonly access:FilesAccessGate,
    private readonly versions:VersionWriter,
    private readonly transactions:TransactionRunner,
    private readonly keeps:AgentKeepRepository,
    private readonly audit:RequestAuditLog,
  ) {}

  register(app:express.Express):void {
    app.post('/v1/agent-files/:id/keep', async(request:RequestWithIdentity, response, next) => { try {
      const source = await this.access.requireFile(request, request.params.id, 'edit'); const targetCollectionId = String(request.body.collectionId ?? ''); const targetPath = cleanPath(String(request.body.path ?? source.path), false);
      await this.access.requirePath(request, targetCollectionId, targetPath, 'edit'); const target = await this.access.collectionRow(targetCollectionId); if (target.kind === 'scratch') throw new HttpError(400, 'Keep target must be a permanent collection');
      const content = await loadFileContent(this.db, this.config, this.store, source.id, source.current_version_id); if (!content) throw new HttpError(404, 'source content not found');
      if(source.collection_id===targetCollectionId&&source.path===targetPath)throw new HttpError(409,'The file is already kept at this path');
      const actor = this.access.identity(request);
      const staged=await this.versions.stage(targetCollectionId,content.buffer);
      const kept=await this.transactions.run('keep-agent-file',async client=>{
      for(const id of [...new Set([source.collection_id,targetCollectionId])].sort())await lockStoredNamespace(client,id);
      await this.keeps.lockFile(client,source.id);
      const current=await this.access.requireFile(request,source.id,'edit',client);
      if(current.current_version_id!==source.current_version_id||current.path!==source.path||current.collection_id!==source.collection_id)throw new HttpError(409,'Source changed while preparing keep');
      await this.access.requirePath(request,targetCollectionId,targetPath,'edit',client);
      await lockStoredNamespace(client, targetCollectionId);
      const lockedExisting = await this.keeps.lockTarget(client, targetCollectionId, targetPath);
      const kept = await this.versions.insert(client, { collectionId: targetCollectionId, fileId: lockedExisting?.id, path: targetPath, mime: source.mime, bytes: content.buffer, staged, actor, createdByType: source.created_by_type, createdById: source.created_by_id, message: `Kept from agent run ${ source.created_by_id }` });
      await this.keeps.trash(client, source.id);
      await this.keeps.recordProvenance(client, kept.id, source.created_by_id, JSON.stringify({ keptFromCollectionId: source.collection_id, sourceFileId: source.id }), actor.userId);
      return kept; }); await this.audit.record(request, 'keep-agent-file', kept); response.json({ ...kept, provenance: { type: source.created_by_type, id: source.created_by_id } });
    } catch (error) { next(error) } });
    app.post('/v1/agent-runs/:runId/keep', async(request:RequestWithIdentity, response, next) => { try {
      const actor = this.access.identity(request); const source = await this.keeps.scratchRun(actor.userId, request.params.runId);
      if (!source) throw new HttpError(404, 'scratch run not found');
      const targetCollectionId = String(request.body.collectionId ?? ''); await this.access.requireCollection(request, targetCollectionId, 'edit'); const target = await this.access.collectionRow(targetCollectionId);
      if (target.kind === 'scratch') throw new HttpError(400, 'Keep target must be a permanent collection');
      const files = await this.keeps.runFiles(source.id, request.params.runId);
      const materialized:{file:any;content:NonNullable<Awaited<ReturnType<typeof loadFileContent>>>;staged:StagedVersionContent}[]=[];
      // Bound acquisitions and encryption work instead of flooding the pool for a large run.
      for(const file of files){
        const content=await loadFileContent(this.db,this.config,this.store,file.id,file.current_version_id);
        if(!content)throw new HttpError(404,'Source content not found');
        materialized.push({file,content,staged:await this.versions.stage(targetCollectionId,content.buffer)});
      }
      const count=await this.transactions.run('keep-agent-run',async client=>{
      await this.access.requireCollection(request,targetCollectionId,'edit',false,false,client);
      for(const id of [...new Set([source.id,targetCollectionId])].sort())await lockStoredNamespace(client,id);
      await this.keeps.lockFiles(client,materialized.map(item=>item.file.id));
      let count = 0;
      for (const item of materialized) {
        if (!item.content) throw new HttpError(404, `source content not found for ${ item.file.path }`);
        const current=await this.access.requireFile(request,item.file.id,'edit',client);
        if(current.current_version_id!==item.file.current_version_id||current.path!==item.file.path||current.collection_id!==item.file.collection_id)throw new HttpError(409,'Source changed while preparing keep');
        await this.access.requirePath(request,targetCollectionId,item.file.path,'edit',client);
        const existing = await this.keeps.lockTarget(client, targetCollectionId, item.file.path);
        const kept = await this.versions.insert(client, { collectionId: targetCollectionId, fileId: existing?.id, path: item.file.path, mime: item.file.mime, bytes: item.content.buffer, staged:item.staged, actor, createdByType: item.file.created_by_type, createdById: item.file.created_by_id, message: `Kept from agent run ${ request.params.runId }` });
        await this.keeps.trash(client, item.file.id);
        await this.keeps.recordProvenance(client, kept.id, request.params.runId, JSON.stringify({ keptFromCollectionId: source.id, sourceFileId: item.file.id }), actor.userId); count++;
      }
      return count; }); response.json({ count });
    } catch (error) { next(error) } });

  }
}
