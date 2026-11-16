// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type express from 'express';
import type pg from 'pg';

import { trashFileWithoutReceipt } from '../databaseOperations.js';
import type { TransactionRunner } from '../FilesTransaction.js';
import type { FilesAccessGate, RequestWithIdentity } from '../Http/FilesAccessGate.js';
import { FilesRequestInput } from '../Http/FilesRequestInput.js';
import { HttpError } from '../Http/HttpError.js';
import type { RequestAuditLog } from '../Http/RequestAuditLog.js';
import type { IndexingQueue } from '../indexing.js';
import type { FileWriteRepository } from '../Repositories/FileWriteRepository.js';
import type { VersionRestoreRepository } from '../Repositories/VersionRestoreRepository.js';
import type { VersionWriter } from '../Services/VersionWriter.js';
import { lockStoredNamespace } from '../storedNamespace.js';
import type { OperationAccessFactory } from './TrashRoutes.js';

const { cleanPath, UUID } = FilesRequestInput;

/**
 * Files API namespace writes (moved from app.ts), mounted at their original positions: create an
 * empty file and remove an empty folder; acknowledge a native conflict and re-index; trash a file;
 * restore an older version as a new current version.
 */
export class FileWriteRoutes {
  constructor(
    private readonly db:pg.Pool,
    private readonly access:FilesAccessGate,
    private readonly versions:VersionWriter,
    private readonly transactions:TransactionRunner,
    private readonly writes:FileWriteRepository,
    private readonly restores:VersionRestoreRepository,
    private readonly audit:RequestAuditLog,
    private readonly operationAccess:OperationAccessFactory,
    private readonly indexer?:IndexingQueue,
  ) {}

  /** POST /v1/files/empty and DELETE /v1/folders, mounted after the folder guidance routes. */
  registerCreateAndRemove(app:express.Express):void {
    app.post('/v1/files/empty', async(request:RequestWithIdentity,response,next)=>{ try {
      const collectionId=String(request.body.collectionId??''); const filePath=cleanPath(request.body.path,false);
      await this.access.requirePath(request,collectionId,filePath,'edit'); const actor=this.access.identity(request);
      const bytes=Buffer.alloc(0); const staged=await this.versions.stage(collectionId,bytes);
      const file=await this.transactions.run('create-empty',async client=>{
      await this.access.requirePath(request,collectionId,filePath,'edit',client); await lockStoredNamespace(client,collectionId);
      if(await this.writes.pathOccupied(client,collectionId,filePath)) throw new HttpError(409,'A file or folder already exists at that Files path.');
      return this.versions.insert(client,{collectionId,path:filePath,mime:'text/plain',bytes,staged,actor,message:'Created empty file'});
      }); await this.audit.record(request,'create-empty-file',file); response.status(201).json(file);
    } catch(error){next(error)} });
    app.delete('/v1/folders', async(request:RequestWithIdentity, response, next) => { try {
      const collectionId = String(request.query.collectionId ?? '');
      const folderPath = cleanPath(String(request.query.path ?? ''), false);
      await this.access.requirePath(request, collectionId, folderPath, 'edit');
      await this.transactions.run('remove-folder',async client=>{
      await this.access.requirePath(request,collectionId,folderPath,'edit',client);
      await lockStoredNamespace(client, collectionId);
      if (await this.writes.folderHasFiles(client, collectionId, folderPath)) throw new HttpError(409, 'Use receipt-backed folder Trash; folders containing files or retained tombstones cannot be removed.');
      if (await this.writes.folderHasTombstones(client, collectionId, folderPath)) throw new HttpError(409, 'Retained folder tombstones cannot be removed through this action.');
      if (!await this.writes.deleteFolderTree(client, collectionId, folderPath)) throw new HttpError(404, 'folder not found');
      await this.writes.deleteFolderStars(client, collectionId, folderPath);
      });
      response.status(204).end();
    } catch (error) { next(error) } });
  }

  /** Native conflict keep-both and re-index, mounted after the listing routes. */
  registerConflictAndReindex(app:express.Express):void {
    app.post('/v1/files/:id/conflicts/keep-both', async(request:RequestWithIdentity, response, next) => { try {
      const conflictFileId = request.params.id;
      const conflictVersionId = String(request.body.currentVersionId ?? '');
      const sourceFileId = String(request.body.sourceFileId ?? '');
      const sourceVersionId = String(request.body.sourceVersionId ?? '');
      if (![conflictFileId, conflictVersionId, sourceFileId, sourceVersionId].every(value => UUID.test(value))) throw new HttpError(400, 'valid conflict and version identities are required');
      const displayedConflict = await this.access.requireFile(request, conflictFileId, 'edit');
      const displayedSource = await this.access.requireFile(request, sourceFileId, 'edit');
      if (displayedConflict.collection_id !== displayedSource.collection_id) throw new HttpError(409, 'The displayed conflict source is no longer in the same collection. Refresh Files and try again.');
      await this.transactions.run('keep-both',async client=>{
      await lockStoredNamespace(client, displayedConflict.collection_id);
      const relationSource = await this.writes.lockConflictSource(client, conflictFileId);
      if (!relationSource || relationSource !== sourceFileId) throw new HttpError(409, 'This conflict changed. Refresh Files and try again.');
      const locked = await this.writes.lockFileStates(client, [conflictFileId, sourceFileId]);
      const conflict = locked.find(row => row.id === conflictFileId);
      const source = locked.find(row => row.id === sourceFileId);
      if (!conflict || !source || conflict.deleted_at || source.deleted_at || conflict.current_version_id !== conflictVersionId || source.current_version_id !== sourceVersionId) throw new HttpError(409, 'One of the preserved files changed. Refresh Files and review both copies again.');
      if (await this.writes.hasUnresolvedNativePublication(client, [conflictFileId, sourceFileId])) throw new HttpError(409, 'Native source publication is still unresolved. Restore native access or finish recovery before acknowledging both copies.');
      if (await this.writes.deleteConflict(client, conflictFileId, sourceFileId) !== 1) throw new HttpError(409, 'This conflict was already changed. Refresh Files and try again.');
      await this.writes.auditKeepBoth(client, this.access.identity(request).kind === 'capability' ? 'agent-or-device' : 'user', this.access.identity(request).userId, this.access.identity(request).deviceId || null, conflictFileId, conflictVersionId, JSON.stringify({ sourceFileId, sourceVersionId }));
      });
      response.status(204).end();
    } catch (error) { next(error) } });
    app.post('/v1/files/:id/reindex', async(request:RequestWithIdentity, response, next) => { try {
      if (!this.indexer) return response.status(503).json({ error: 'indexing unavailable' });
      await this.access.requireFile(request, request.params.id, 'edit');
      await this.indexer.retry(request.params.id);
      await this.audit.record(request, 'reindex', await this.access.fileRow(request.params.id));
      response.status(202).json({ accepted: true });
    } catch (error) { next(error) } });
  }

  /** DELETE /v1/files/:id, mounted after the content write routes. */
  registerTrash(app:express.Express):void {
    app.delete('/v1/files/:id', async(request:RequestWithIdentity, response, next) => { try {
      await trashFileWithoutReceipt(this.db, request.params.id, this.access.identity(request), this.operationAccess(request));
      response.status(204).end();
    } catch (error) { next(error) } });
  }

  /** POST /v1/files/:id/restore, mounted after the Trash routes. */
  registerRestore(app:express.Express):void {
    app.post('/v1/files/:id/restore', async(request:RequestWithIdentity, response, next) => { try { const file = await this.access.requireFile(request, request.params.id, 'edit'); const actor = this.access.identity(request); const authorized = await this.access.visibleVersion(request, file, String(request.body.versionId ?? '')); const source = await this.restores.liveVersion(authorized, file.id); if (!source) throw new HttpError(404, 'version not found'); const version=await this.transactions.run('restore-version',async client=>{ await lockStoredNamespace(client,file.collection_id,file.path); const current=await this.access.requireFile(request,file.id,'edit',client); if(current.current_version_id!==file.current_version_id)throw new HttpError(409,'Files version changed while preparing restore'); if(!await this.restores.lockLiveVersion(client,source.id,file.id))throw new HttpError(409,'Restore source changed'); const version = await this.restores.insertRestored(client, file.id, source.chunk_collection_id, file.current_version_id, source.manifest_hash, source.size, actor.userId, request.body.comment ?? 'Restored as a new version', actor.deviceId || 'server-web'); await this.restores.referenceManifestChunks(client, source.chunk_collection_id, source.manifest_hash); await this.restores.makeCurrent(client, file.id, version.id, source.size); await this.restores.journalRestore(client, file.collection_id, file.id, version.id); return version; }); await this.audit.record(request, 'version-restore', { ...file, current_version_id: version.id }); response.json({ ok: true, versionId: version.id }) } catch (error) { next(error) } });
  }
}
