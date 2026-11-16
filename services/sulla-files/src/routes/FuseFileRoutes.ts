// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { randomUUID } from 'node:crypto';
import express from 'express';
import type pg from 'pg';

import { getDatabaseBatch, parseDatabaseBatch, runDatabaseBatch, submitDatabaseBatch } from '../databaseOperationBatches.js';
import { trashFileWithoutReceipt } from '../databaseOperations.js';
import type { TransactionRunner } from '../FilesTransaction.js';
import { folderOperationState } from '../folderOperationBatches.js';
import type { FilesAccessGate, RequestWithIdentity } from '../Http/FilesAccessGate.js';
import { FilesRequestInput } from '../Http/FilesRequestInput.js';
import { HttpError } from '../Http/HttpError.js';
import type { LocalManagerGate } from '../Http/LocalManagerGate.js';
import type { RequestAuditLog } from '../Http/RequestAuditLog.js';
import type { FuseWriteRepository } from '../Repositories/FuseWriteRepository.js';
import type { VersionWriter } from '../Services/VersionWriter.js';
import { ensureStoredFolder, lockStoredNamespace, storedParentPaths } from '../storedNamespace.js';
import type { OperationAccessFactory } from './TrashRoutes.js';

const { cleanPath } = FilesRequestInput;

/**
 * Files-mount namespace writes (moved from app.ts): the mount snapshot, create (reviving a trashed
 * path), rename/move and delete of files, and create/move/remove of folders. Creates stage content
 * before the short transaction; moves run as single-item database operation batches.
 */
export class FuseFileRoutes {
  constructor(
    private readonly db:pg.Pool,
    private readonly access:FilesAccessGate,
    private readonly managers:LocalManagerGate,
    private readonly versions:VersionWriter,
    private readonly transactions:TransactionRunner,
    private readonly writes:FuseWriteRepository,
    private readonly audit:RequestAuditLog,
    private readonly operationAccess:OperationAccessFactory,
  ) {}

  /** GET /v1/fuse/files, mounted before the FUSE read routes as before. */
  registerSnapshot(app:express.Express):void {
    app.get('/v1/fuse/files', async(request:RequestWithIdentity, response, next) => { try {
      const collectionId = String(request.query.collectionId ?? '');
      if (!collectionId) throw new HttpError(400, 'collectionId is required');
      await this.access.requireCollection(request, collectionId, 'view');
      response.setHeader('Cache-Control', 'private, no-store');
      response.json(await this.managers.fuseExperiment().fuseSnapshot(collectionId));
    } catch (error) { next(error) } });
  }

  register(app:express.Express):void {
    app.post('/v1/fuse/files', express.raw({ type: '*/*', limit: '64mb' }), async(request:RequestWithIdentity, response, next) => { try {
      const collectionId = String(request.query.collectionId ?? '');
      const filePath = cleanPath(String(request.query.path ?? ''), false);
      const actor = this.access.identity(request);
      await this.access.requireCollection(request, collectionId, 'edit');
      const bytes = Buffer.from(request.body as Buffer);
      // Encrypt and fsync the chunks first; the transaction below holds only DB statements.
      const staged = await this.versions.stage(collectionId, bytes);
      const file = await this.transactions.run('fuse-create', async client => {
        await lockStoredNamespace(client, collectionId, filePath);
        // A trashed file keeps its (collection_id, path) row, so a plain INSERT hit the unique index and
        // creating a file where one was deleted failed with 'A file already occupies ...'. Revive the
        // trashed row instead (insertVersion un-deletes it and appends a version; history is kept).
        const trashed = await this.writes.lockTrashedAt(client, collectionId, filePath);
        const file = await this.versions.insert(client, { collectionId, path: filePath, ...(trashed ? { fileId: trashed.id } : {}),
          mime: request.header('content-type') ?? 'application/octet-stream', bytes, staged, actor,
          createdByType: 'agent-run', createdById: actor.jobId ?? actor.agentId ?? actor.userId, message: 'Created through the Files mount' });
        await this.audit.record(request,'fuse-create',file,{versionId:file.current_version_id,publicationStatus:file.publication_status},client);
        return file;
      });
      response.status(201).json(file);
    } catch (error) { next(error) } });
    app.patch('/v1/fuse/files/:id', async(request:RequestWithIdentity, response, next) => { try {
      const file = await this.access.fileRow(request.params.id); const nextPath = cleanPath(request.body.path, false);
      const targetCollectionId=String(request.body.targetCollectionId??file.collection_id);
      this.access.identity(request);
      const input=parseDatabaseBatch({idempotencyKey:randomUUID(),collectionId:file.collection_id,items:[{
        itemId:randomUUID(),action:targetCollectionId===file.collection_id?'rename':'move',fileId:file.id,
        expectedVersionId:file.current_version_id,expectedRevision:String(file.operation_revision),targetPath:nextPath,
        ...(targetCollectionId===file.collection_id?{}:{targetCollectionId}),
      }]});
      const submitted=await submitDatabaseBatch(this.db,input,this.access.identity(request),this.operationAccess(request));
      await runDatabaseBatch(this.db,submitted.operationId,this.access.identity(request),this.operationAccess(request));
      const result=await getDatabaseBatch(this.db,submitted.operationId,this.access.identity(request),this.operationAccess(request));
      if(result.state!=='completed') throw new HttpError(409,result.items[0]?.error?.message??'Files move did not complete');
      response.json(result.items[0]?.after);
    } catch (error) { next(error) } });
    app.delete('/v1/fuse/files/:id', async(request:RequestWithIdentity, response, next) => { try {
      const file = await this.access.fileRow(request.params.id); this.access.identity(request);
      await trashFileWithoutReceipt(this.db, file.id, this.access.identity(request), this.operationAccess(request)); response.status(204).end();
    } catch (error) { next(error) } });
    app.post('/v1/fuse/folders', async(request:RequestWithIdentity, response, next) => { try {
      const collectionId=String(request.body.collectionId??''); const folderPath=cleanPath(request.body.path,false);
      const actor=this.access.identity(request); await this.access.requireCollection(request, collectionId, 'edit');
      const createdDescription=`Created by ${actor.agentId??actor.jobId??'agent'} on ${new Date().toISOString().slice(0,10)} — needs description`;
      await this.transactions.run('fuse-mkdir', async client => {
        await lockStoredNamespace(client,collectionId,folderPath); await ensureStoredFolder(client,collectionId,folderPath,actor);
        await this.writes.describeNewFolders(client,collectionId,[...storedParentPaths(folderPath),folderPath],createdDescription);
        await this.audit.record(request,'create-folder',undefined,{collectionId,folderPath,description:createdDescription},client);
      });
      response.status(201).json({collectionId,path:folderPath,description:createdDescription,needsDescription:true});
    } catch(error){next(error)} });
    app.patch('/v1/fuse/folders', async(request:RequestWithIdentity,response,next)=>{ try {
      const collectionId=String(request.body.collectionId??''); const folderPath=cleanPath(request.body.path,false);
      const targetCollectionId=String(request.body.targetCollectionId??collectionId); const targetPath=cleanPath(request.body.targetPath,false);
      this.access.identity(request);
      const source=await folderOperationState(this.db,collectionId,folderPath,this.operationAccess(request));
      const input=parseDatabaseBatch({idempotencyKey:randomUUID(),collectionId,items:[{
        itemId:randomUUID(),kind:'folder',action:targetCollectionId===collectionId?'rename':'move',folderPath,
        expectedFolder:source.folderId?source:undefined,sourceSubtreeSignature:source.subtreeSignature,targetPath,
        ...(targetCollectionId===collectionId?{}:{targetCollectionId}),
      }]});
      const submitted=await submitDatabaseBatch(this.db,input,this.access.identity(request),this.operationAccess(request));
      await runDatabaseBatch(this.db,submitted.operationId,this.access.identity(request),this.operationAccess(request));
      const result=await getDatabaseBatch(this.db,submitted.operationId,this.access.identity(request),this.operationAccess(request));
      if(result.state!=='completed') throw new HttpError(409,result.items[0]?.error?.message??'Folder move did not complete');
      response.json(result.items[0]?.after);
    } catch(error){next(error)} });
    app.delete('/v1/fuse/folders', async(request:RequestWithIdentity,response,next)=>{ try {
      const collectionId=String(request.query.collectionId??''); const folderPath=cleanPath(String(request.query.path??''),false);
      this.access.identity(request); await this.access.requirePath(request,collectionId,folderPath,'edit');
      await this.transactions.run('fuse-rmdir', async client => {
        await lockStoredNamespace(client,collectionId);
        if(await this.writes.folderHasLiveFiles(client,collectionId,folderPath)) throw new HttpError(409,'folder is not empty');
        await this.writes.deleteFolderTree(client,collectionId,folderPath);
      });
      response.status(204).end();
    } catch(error){next(error)} });

  }
}
