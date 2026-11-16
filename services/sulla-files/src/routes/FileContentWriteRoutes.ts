// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { randomUUID } from 'node:crypto';
import type express from 'express';
import type pg from 'pg';

import type { Config } from '../config.js';
import type { DatabaseFailureClassifier, TransactionRunner } from '../FilesTransaction.js';
import type { FilesAccessGate, RequestWithIdentity } from '../Http/FilesAccessGate.js';
import { FilesRequestInput } from '../Http/FilesRequestInput.js';
import { HttpError } from '../Http/HttpError.js';
import type { RequestAuditLog } from '../Http/RequestAuditLog.js';
import { loadFileContent } from '../preview.js';
import { assertUnprotectedFile } from '../protectedFiles.js';
import type { FileWriteRepository } from '../Repositories/FileWriteRepository.js';
import type { AutomergeTextStore } from '../Services/AutomergeTextStore.js';
import type { LiveTextCoordinator } from '../Services/LiveTextCoordinator.js';
import type { TextVersionMerger } from '../Services/TextVersionMerger.js';
import type { VersionWriter } from '../Services/VersionWriter.js';
import type { Store } from '../store.js';
import { assertStoredFilePath, ensureStoredFileParents, lockStoredNamespace, storedParentPaths } from '../storedNamespace.js';
import { commitStreamedUpload, streamUploadChunks } from '../streamingUpload.js';
import { beginUploadIntent, completeUploadIntent } from '../uploadCleanup.js';

const { cleanPath, numberedPath, UUID } = FilesRequestInput;

/**
 * Files API content writes (moved from app.ts): the web editor's version-checked text save, and
 * streamed upload / import. Bodies are streamed into chunks and text merged with no transaction
 * open; the short metadata transaction re-reads under the namespace lock and re-checks.
 */
export class FileContentWriteRoutes {
  constructor(
    private readonly db:pg.Pool,
    private readonly config:Config,
    private readonly store:Store,
    private readonly access:FilesAccessGate,
    private readonly versions:VersionWriter,
    private readonly transactions:TransactionRunner,
    private readonly writes:FileWriteRepository,
    private readonly merger:TextVersionMerger,
    private readonly texts:AutomergeTextStore,
    private readonly live:LiveTextCoordinator,
    private readonly audit:RequestAuditLog,
    private readonly databaseFailures:DatabaseFailureClassifier,
  ) {}

  register(app:express.Express):void {
    app.put('/v1/files/:id/content', async(request:RequestWithIdentity, response, next) => { try {
      const baseVersionId=String(request.body?.baseVersionId??''); const content=request.body?.content;
      if(!UUID.test(baseVersionId)||typeof content!=='string') throw new HttpError(400,'baseVersionId and text content are required');
      const file=await this.access.requireFile(request,request.params.id,'edit');
      const base=await this.writes.liveVersionId(baseVersionId,file.id);
      if(!base){return response.status(409).json({code:'VERSION_CONFLICT',error:'The edited Files version is no longer available.',currentVersionId:file.current_version_id})}
      const readVersion=async(fileId:string,versionId:string):Promise<Buffer>=>{const loaded=await loadFileContent(this.db,this.config,this.store,fileId,versionId);if(!loaded)throw new HttpError(409,'Files version content is unavailable');return loaded.buffer};
      const currentBytes=await readVersion(file.id,file.current_version_id); let saved;
      try{saved=await this.merger.merge(this.db,file,baseVersionId,Buffer.from(content,'utf8'),currentBytes,readVersion)}catch(error){
        if(!this.databaseFailures.isConnectionLoss(error)&&baseVersionId!==file.current_version_id){return response.status(409).json({code:'VERSION_CONFLICT',error:'The edited version could not be merged safely.',currentVersionId:file.current_version_id})}
        throw error;
      }
      const actor=this.access.identity(request); const staged=await this.versions.stage(file.collection_id,saved.bytes);
      const result=await this.transactions.run('web-editor-save',async client=>{
      await lockStoredNamespace(client,file.collection_id,file.path);
      const current=await this.access.requireFile(request,file.id,'edit',client);
      if(current.current_version_id!==file.current_version_id||current.path!==file.path||current.collection_id!==file.collection_id)throw new HttpError(409,'Files version changed while preparing save; retry');
      const result=await this.versions.insert(client,{collectionId:file.collection_id,fileId:file.id,path:file.path,mime:file.mime,bytes:saved.bytes,staged,actor,
        createdByType:actor.agentId?'agent':actor.jobId?'agent-run':undefined,createdById:actor.agentId??actor.jobId??actor.userId,message:'Saved with version check',baseVersionId:file.current_version_id});
      if(saved.document)await this.texts.save(client,file.id,result.current_version_id,saved.document); return result; }); if(saved.document)this.live.adopt(request,file.id,saved.document);
      await this.audit.record(request,'version-checked-save',result,{baseVersionId,merged:saved.merged,versionId:result.current_version_id});
      response.json({status:saved.merged?'merged':'saved',fileId:result.id,path:result.path,mime:result.mime,content:saved.bytes.toString('utf8'),versionId:result.current_version_id});
    }catch(error){next(error)} });
    app.put('/v1/files/upload', async(request:RequestWithIdentity, response, next) => { const uploadId = randomUUID(); try {
      const collectionId = String(request.query.collectionId ?? ''); const path = cleanPath(String(request.query.path ?? ''), false); const actor = this.access.identity(request);
      const lengthHeader = request.header('content-length') ?? request.header('x-sulla-expected-bytes');
      const expectedBytes = lengthHeader === undefined ? undefined : Number(lengthHeader);
      if (expectedBytes !== undefined && (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0 || expectedBytes > 2 * 1024 * 1024 * 1024)) throw new HttpError(400, 'valid content-length is required');
      const baseVersionId = typeof request.query.baseVersionId === 'string' ? request.query.baseVersionId : undefined;
      const conflict = (current:any) => response.status(409).json({ code: 'VERSION_CONFLICT', error: 'The Files version this upload was based on is no longer current.', currentVersionId: current?.current_version_id ?? null });
      const authorize = async(row:any,client:pg.Pool|pg.PoolClient=this.db) => {
        if (row) { await assertUnprotectedFile(client, row); try { await this.access.requirePath(request, collectionId, path, 'edit',client) } catch (error:any) { if (error.status !== 403) throw error; await this.access.requireFile(request, row.id, 'edit',client) } }
        else await this.access.requirePath(request, collectionId, path, 'edit',client);
      };
      await beginUploadIntent(this.db, uploadId, collectionId);
      // Authorize and fail fast BEFORE reading the body. The body is streamed into chunks with no
      // transaction open: a slow client must never hold BEGIN or the namespace lock (Postgres kills
      // idle-in-transaction sessions after 60 s, and the lock would block every other writer).
      const before = await this.writes.fileAt(collectionId, path);
      await authorize(before);
      if (baseVersionId !== undefined && (!UUID.test(baseVersionId) || before?.current_version_id !== baseVersionId || before?.deleted_at)) return conflict(before);
      const streamed = await streamUploadChunks(this.config, this.store, { uploadId, collectionId, expectedBytes, maxBytes: 2 * 1024 * 1024 * 1024, body: request, intentDb: this.db });
      // Short metadata transaction: re-read under the lock and re-check what may have changed while streaming.
      const outcome=await this.transactions.run('upload',async client=>{
      await lockStoredNamespace(client, collectionId);
      const existing = await this.writes.lockFileAt(client, collectionId, path);
      if (existing?.id !== before?.id) await authorize(existing,client); else if (existing) await assertUnprotectedFile(client, existing);
      if (baseVersionId !== undefined && (existing?.current_version_id !== baseVersionId || existing?.deleted_at)) { return {conflict:existing} }
      const file = await commitStreamedUpload(client, { uploadId, collectionId, path, mime: request.header('content-type') ?? 'application/octet-stream', expectedBytes, maxBytes: 2 * 1024 * 1024 * 1024, actor, body: request, intentDb: this.db, existingFile: existing ? { id: existing.id, current_version_id: existing.current_version_id } : undefined, message: 'Uploaded' }, streamed);
      return {file}; });
      if(!outcome.file)return conflict(outcome.conflict); const file=outcome.file;
      await completeUploadIntent(this.db, uploadId).catch(()=>undefined); await this.audit.record(request, 'upload', file); response.status(201).json(file);
    } catch (error) { next(error) } });
    app.put('/v1/files/import', async(request:RequestWithIdentity, response, next) => { const uploadId = randomUUID(); try {
      const collectionId = String(request.query.collectionId ?? '');
      const requestedPath = cleanPath(String(request.query.path ?? ''), false);
      const keepBoth = request.query.conflict === 'keep-both';
      await this.access.requirePath(request, collectionId, requestedPath, 'edit');
      // Desktop streams through Chromium, which sends chunked bodies and forbids a
      // caller-set content-length, so it declares the size in x-sulla-expected-bytes.
      // The streaming writer rejects any body that does not match the declared size.
      const declaredBytes = Number(request.header('content-length') ?? request.header('x-sulla-expected-bytes'));
      if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0 || declaredBytes > 2 * 1024 * 1024 * 1024) throw new HttpError(400, 'valid content-length is required');
      const actor = this.access.identity(request);
      await beginUploadIntent(this.db, uploadId, collectionId);
      // Stream the body into chunks first (no transaction held during the network transfer), then
      // pick the path and write metadata in a short transaction.
      const streamed = await streamUploadChunks(this.config, this.store, { uploadId, collectionId, expectedBytes: declaredBytes, body: request, intentDb: this.db });
      const result=await this.transactions.run('import',async client=>{
      await lockStoredNamespace(client, collectionId);
      const path = await this.availablePath(client, collectionId, requestedPath, keepBoth);
      if (path !== requestedPath) await this.access.requirePath(request, collectionId, path, 'edit',client);
      await assertStoredFilePath(client, collectionId, path);
      await ensureStoredFileParents(client, collectionId, path, actor);
      const file = await commitStreamedUpload(client, {
        uploadId, collectionId, path, mime: request.header('content-type') ?? 'application/octet-stream',
        expectedBytes: declaredBytes, actor, body: request, intentDb: this.db,
        message: path === requestedPath ? 'Imported into Files' : `Imported as ${ path } to preserve both files`,
      }, streamed);
      return {file,path}; });
      const {file,path}=result;
      await completeUploadIntent(this.db, uploadId).catch(() => undefined);
      response.status(201).json({ ...file, requested_path: requestedPath, conflict_resolution: path === requestedPath ? 'none' : 'kept-both' });
    } catch (error:any) { if (error?.code === '23505') return response.status(409).json({ error: 'A file or folder already exists at that Files path.' }); next(error) } });
  }

  /** The requested path, or with keep-both the first free numbered variant; a file blocking a parent folder is a conflict. */
  private async availablePath(client:pg.PoolClient, collectionId:string, requestedPath:string, keepBoth:boolean):Promise<string> {
    const blockedParent = await this.writes.blockingParent(client, collectionId, storedParentPaths(requestedPath));
    if (blockedParent !== undefined) throw new HttpError(409, `A file already occupies ${ blockedParent }, so ${ requestedPath } cannot be stored there.`);
    for (let index = 0; index <= 10_000; index++) {
      const candidate = index ? numberedPath(requestedPath, index) : requestedPath;
      if (!await this.writes.pathOccupied(client, collectionId, candidate)) return candidate;
      if (!keepBoth) throw new HttpError(409, 'A file or folder already exists at that Files path.');
    }
    throw new HttpError(409, 'Files could not reserve a distinct path for this upload.');
  }
}
