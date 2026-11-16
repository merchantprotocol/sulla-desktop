// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { createHash, randomUUID } from 'node:crypto';
import express from 'express';
import type pg from 'pg';

import type { Config } from '../config.js';
import { ContentReadFailureLog } from '../ContentReadFailureLog.js';
import { sendFileStream, streamFileContent } from '../fileStream.js';
import type { TransactionRunner } from '../FilesTransaction.js';
import type { FilesAccessGate, RequestWithIdentity } from '../Http/FilesAccessGate.js';
import { HttpError } from '../Http/HttpError.js';
import type { LocalManagerGate } from '../Http/LocalManagerGate.js';
import type { RequestAuditLog } from '../Http/RequestAuditLog.js';
import type { FuseWriteRepository } from '../Repositories/FuseWriteRepository.js';
import type { AutomergeTextStore } from '../Services/AutomergeTextStore.js';
import type { LiveTextCoordinator } from '../Services/LiveTextCoordinator.js';
import type { TextVersionMerger } from '../Services/TextVersionMerger.js';
import type { VersionWriter } from '../Services/VersionWriter.js';
import type { Store } from '../store.js';
import { lockStoredNamespace } from '../storedNamespace.js';
import { commitStreamedUpload, streamUploadChunks } from '../streamingUpload.js';
import { beginUploadIntent, completeUploadIntent } from '../uploadCleanup.js';

const FUSE_MAX_FILE_BYTES = 64 * 1024 * 1024;

/**
 * Files-mount content (moved from app.ts): hashed reads, streamed and small version-checked writes
 * (text merged through Automerge), and replace-from-another-file. Every write reads, merges and
 * stages outside its transaction; the transaction only re-checks the snapshot under the path lock.
 */
export class FuseContentRoutes {
  constructor(
    private readonly db:pg.Pool,
    private readonly config:Config,
    private readonly store:Store,
    private readonly access:FilesAccessGate,
    private readonly managers:LocalManagerGate,
    private readonly versions:VersionWriter,
    private readonly transactions:TransactionRunner,
    private readonly writes:FuseWriteRepository,
    private readonly merger:TextVersionMerger,
    private readonly texts:AutomergeTextStore,
    private readonly live:LiveTextCoordinator,
    private readonly audit:RequestAuditLog,
    private readonly contentReadFailures:ContentReadFailureLog,
  ) {}

  register(app:express.Express):void {
    app.get('/v1/fuse/files/:id/content', async(request:RequestWithIdentity, response, next) => {
      const controller = new AbortController(); const abort = () => controller.abort();
      request.once('aborted', abort); response.once('close', abort);
      let readVersionId:string | undefined;
      try {
        let file = await this.access.requireFile(request, request.params.id, 'view');
        if(this.live.sessions.has(file.id)){await this.live.sessions.flush(file.id);file=await this.access.requireFile(request,file.id,'view');}
        readVersionId = file.current_version_id;
        const stream = await streamFileContent(this.db,this.config,this.store,file.id,file.current_version_id,undefined,controller.signal);
        if (!stream) return response.sendStatus(404);
        const hash=createHash('sha256');
        for await (const part of stream.body) { controller.signal.throwIfAborted(); hash.update(part) }
        const content = await streamFileContent(this.db,this.config,this.store,file.id,file.current_version_id,undefined,controller.signal);
        if (!content) return response.sendStatus(404);
        response.setHeader('ETag', `"${ file.current_version_id }"`);
        response.setHeader('X-Sulla-Source-Hash', hash.digest('hex'));
        await sendFileStream(request,response,content);
      } catch(error) {
        if (!controller.signal.aborted && ContentReadFailureLog.isServerFailure(error)) this.contentReadFailures.report(error, { route: 'fuse-read', fileId: request.params.id, versionId: readVersionId });
        if (!controller.signal.aborted && !response.headersSent) next(error);
        else if (!controller.signal.aborted) response.destroy(error as Error);
      } finally { request.off('aborted',abort); response.off('close',abort) }
    });
    app.put('/v1/fuse/files/:id/content/stream', async(request:RequestWithIdentity, response, next) => {
      const uploadId=randomUUID();
      try {
        const file=await this.access.requireFile(request,request.params.id,'edit');
        const match=request.header('if-match')?.match(/^"([0-9a-f-]+)"$/i)?.[1];
        const sourceHash=request.header('x-sulla-source-hash');
        const declaredBytes=Number(request.header('content-length'));
        if(!match||!sourceHash||!/^[0-9a-f]{64}$/i.test(sourceHash)) throw new HttpError(428,'If-Match version and X-Sulla-Source-Hash are required');
        if(!Number.isSafeInteger(declaredBytes)||declaredBytes<0) throw new HttpError(400,'valid content-length is required');
        if(declaredBytes>FUSE_MAX_FILE_BYTES) throw new HttpError(413,'Files mount writes are limited to 64 MiB');
        const actor=this.access.identity(request);
        const contentHash=request.header('x-sulla-content-hash')?.toLowerCase();
        if(match!==file.current_version_id) {
          // A retried upload whose first attempt committed: the current version already holds this content.
          if(contentHash&&/^[0-9a-f]{64}$/.test(contentHash)&&Number(file.size)===declaredBytes) {
            const current=await streamFileContent(this.db,this.config,this.store,file.id,file.current_version_id,undefined,new AbortController().signal);
            const currentHash=createHash('sha256'); if(current) for await (const part of current.body) currentHash.update(part);
            if(current&&currentHash.digest('hex')===contentHash) {
              request.resume();
              response.setHeader('ETag',`"${file.current_version_id}"`); response.setHeader('X-Sulla-Source-Hash',contentHash);
              return response.json({id:file.id,collectionId:file.collection_id,path:file.path,mime:file.mime,size:Number(file.size),versionId:file.current_version_id,sourceHash:contentHash,mtimeMs:Date.now()});
            }
          }
          throw new HttpError(409,'Files mount version changed');
        }
        const baseContent=await streamFileContent(this.db,this.config,this.store,file.id,match,undefined,new AbortController().signal);
        if(!baseContent) throw new HttpError(409,'Files mount version changed');
        const baseHash=createHash('sha256');
        for await (const part of baseContent.body) baseHash.update(part);
        if(sourceHash.toLowerCase()!==baseHash.digest('hex')) throw new HttpError(409,'Files mount version changed');
        // Phase 1 (no transaction): read the body, encrypt and publish chunks under an upload intent.
        await beginUploadIntent(this.db,uploadId,file.collection_id);
        const uploadInput={uploadId,collectionId:file.collection_id,path:file.path,mime:file.mime,expectedBytes:declaredBytes,actor,body:request,intentDb:this.db,
          existingFile:{id:file.id,current_version_id:file.current_version_id},message:'Updated through the Files mount'};
        const streamed=await streamUploadChunks(this.config,this.store,uploadInput);
        // Phase 2: a short transaction that only re-checks the version and records metadata.
        const result=await this.transactions.run('fuse-write-stream',async client=>{
          await lockStoredNamespace(client,file.collection_id,file.path);
          const current=await this.access.requireFile(request,file.id,'edit',client);
          if(current.current_version_id!==file.current_version_id||current.path!==file.path||current.collection_id!==file.collection_id) throw new HttpError(409,'Files mount version changed');
          return commitStreamedUpload(client,uploadInput,streamed);
        });
        await completeUploadIntent(this.db,uploadId).catch(()=>undefined);
        const hash=result.source_hash;
        await this.audit.record(request,'fuse-write',result,{versionId:result.current_version_id,publicationStatus:result.publication_status});
        response.setHeader('ETag',`"${result.current_version_id}"`); response.setHeader('X-Sulla-Source-Hash',hash);
        response.json({id:result.id,collectionId:result.collection_id,path:result.path,mime:result.mime,size:result.size,versionId:result.current_version_id,sourceHash:hash,mtimeMs:Date.now()});
      } catch(error) { next(error) }
    });
    app.put('/v1/fuse/files/:id/content', express.raw({ type: '*/*', limit: '64mb' }), async(request:RequestWithIdentity, response, next) => { try {
      const match = request.header('if-match')?.match(/^"([0-9a-f-]+)"$/i)?.[1];
      const sourceHash = request.header('x-sulla-source-hash');
      if (!match || !sourceHash || !/^[0-9a-f]{64}$/i.test(sourceHash)) throw new HttpError(428, 'If-Match version and X-Sulla-Source-Hash are required');
      const written = await this.contentWrite(request, request.params.id, match, sourceHash.toLowerCase(), Buffer.from(request.body as Buffer))
        .catch(error => { if (ContentReadFailureLog.isServerFailure(error)) this.contentReadFailures.report(error, { route: 'fuse-write', fileId: request.params.id, versionId: match }); throw error });
      const result = written.result;
      if (!written.replayed) await this.audit.record(request, 'fuse-write', result, {versionId:result.current_version_id,publicationStatus:result.publication_status});
      if(written.merged) response.setHeader('X-Sulla-Merged','1');
      response.setHeader('ETag',`"${result.current_version_id}"`); response.setHeader('X-Sulla-Source-Hash',written.sourceHash);
      response.json({id:result.id,collectionId:result.collection_id,path:result.path,mime:result.mime,size:result.size,versionId:result.current_version_id,sourceHash:written.sourceHash,mtimeMs:Date.now()});
    } catch (error) { next(error) } });
    app.post('/v1/fuse/files/:id/replace',async(request:RequestWithIdentity,response,next)=>{ try {
      const actor=this.access.identity(request); const sourceFileId=String(request.body.sourceFileId??'');
      if(!sourceFileId) throw new HttpError(400,'sourceFileId is required');
      if(sourceFileId===request.params.id) throw new HttpError(400,'replacement source must differ from target');
      const manager=this.managers.fuseExperiment();
      // Read, merge and encrypt from a snapshot first; the transaction only re-checks it and records the version.
      const target=await this.access.requireFile(request,request.params.id,'edit'); const source=await this.access.requireFile(request,sourceFileId,'edit');
      if(target.collection_id!==source.collection_id) throw new HttpError(400,'replacement source must be in the target collection');
      const bytes=await manager.readStoredVersion(source.id,source.current_version_id);
      const baseHeader=request.header('if-match')?.match(/^"([0-9a-f-]+)"$/i)?.[1]??target.current_version_id;
      const currentBytes=await manager.readStoredVersion(target.id,target.current_version_id);
      const saved=await this.merger.merge(this.db,target,baseHeader,bytes,currentBytes).catch(error=>{
        if(baseHeader!==target.current_version_id) throw error;
        return {bytes,document:undefined,merged:false};
      });
      const staged=await this.versions.stage(target.collection_id,saved.bytes);
      const result=await this.transactions.run('fuse-replace',async client=>{
        await lockStoredNamespace(client,target.collection_id);
        const lockedTarget=await this.access.requireFile(request,target.id,'edit',client); const lockedSource=await this.access.requireFile(request,source.id,'edit',client);
        if(lockedTarget.current_version_id!==target.current_version_id||lockedTarget.path!==target.path||lockedSource.current_version_id!==source.current_version_id||lockedSource.deleted_at)
          throw new HttpError(409,'Files changed concurrently or are busy; retry the replace');
        const result=await this.versions.insert(client,{collectionId:target.collection_id,fileId:target.id,path:target.path,mime:source.mime,bytes:saved.bytes,staged,
          actor,createdByType:actor.agentId?'agent':'agent-run',createdById:actor.agentId??actor.jobId??actor.userId,message:'Replaced through the Files mount',baseVersionId:target.current_version_id});
        if(saved.document) await this.texts.save(client,target.id,result.current_version_id,saved.document);
        await this.writes.trash(client,source.id);
        return result;
      });
      if(saved.document)this.live.adopt(request,target.id,saved.document);
      const nextHash=staged.sourceHash; await this.audit.record(request,'fuse-write',result,{versionId:result.current_version_id,replacedSourceFileId:source.id});
      if(saved.merged) response.setHeader('X-Sulla-Merged','1'); response.setHeader('ETag',`"${result.current_version_id}"`); response.setHeader('X-Sulla-Source-Hash',nextHash);
      response.json({id:result.id,collectionId:result.collection_id,path:result.path,mime:result.mime,size:result.size,versionId:result.current_version_id,sourceHash:nextHash,mtimeMs:Date.now()});
    } catch(error){next(error)} });
  }

  /**
   * A small mount write. Reads, hashing, text merging and chunk encryption run against a
   * snapshot of the file outside any transaction; the transaction then only re-checks that
   * snapshot under the path lock and records the version. A concurrent writer that moved the
   * file on in between makes the snapshot stale, and the whole write is redone (bounded).
   * A retried request whose content is already the current version is answered from that
   * version instead of writing a duplicate (the first attempt committed, its reply was lost).
   */
  private async contentWrite(request:RequestWithIdentity, fileId:string, match:string, sourceHash:string, submitted:Buffer) {
    const manager = this.managers.fuseExperiment(); const actor = this.access.identity(request);
    const sha256 = (bytes:Buffer) => createHash('sha256').update(bytes).digest('hex');
    const submittedHash = sha256(submitted);
    for (let attempt = 1; ; attempt++) {
      const file = await this.access.requireFile(request, fileId, 'edit');
      const currentBytes = await manager.readStoredVersion(file.id, file.current_version_id);
      const baseVersion = await this.writes.liveVersion(match, file.id);
      if (!baseVersion) throw new HttpError(409, 'Files mount version changed');
      if (match !== file.current_version_id && sha256(currentBytes) === submittedHash) {
        return { result: file, sourceHash: submittedHash, merged: false, replayed: true };
      }
      const baseBytes = match === file.current_version_id ? currentBytes : await manager.readStoredVersion(file.id, match);
      if (sourceHash !== sha256(baseBytes)) throw new HttpError(409, 'Files mount version changed');
      const saved = await this.merger.merge(this.db, file, match, submitted, currentBytes);
      const staged = await this.versions.stage(file.collection_id, saved.bytes);
      const outcome = await this.transactions.run('fuse-write', async client => {
        await lockStoredNamespace(client, file.collection_id, file.path);
        const current = await this.access.requireFile(request, file.id, 'edit', client);
        if (current.current_version_id !== file.current_version_id || current.path !== file.path || current.collection_id !== file.collection_id) return undefined;
        const result = await this.versions.insert(client, { collectionId: file.collection_id, fileId: file.id, path: file.path, mime: file.mime,
          bytes: saved.bytes, staged, actor, createdByType: actor.agentId ? 'agent' : 'agent-run', createdById: actor.agentId ?? actor.jobId ?? actor.userId,
          message: 'Updated through the Files mount', baseVersionId: file.current_version_id });
        if (saved.document) await this.texts.save(client, file.id, result.current_version_id, saved.document);
        return result;
      });
      if (outcome) {
        if (saved.document) this.live.adopt(request, file.id, saved.document);
        return { result: outcome, sourceHash: staged.sourceHash, merged: saved.merged, replayed: false };
      }
      if (attempt >= 4) throw new HttpError(409, 'Files changed concurrently or are busy; retry the write');
    }
  }
}
