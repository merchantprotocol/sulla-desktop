// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type express from 'express';
import type pg from 'pg';

import { restoreTrashedFile, type DatabaseOperationAccess } from '../databaseOperations.js';
import { drainPendingChunkGc, lifecycleCapabilities, lifecycleFields } from '../documentLifecycle.js';
import { purgeTrashedFolder, restoreTrashedFolder } from '../folderOperationBatches.js';
import type { FilesAccessGate, RequestWithIdentity } from '../Http/FilesAccessGate.js';
import { HttpError } from '../Http/HttpError.js';
import type { LocalFilesManager } from '../localManager.js';
import { isAuditLogPath, isProtectedPath } from '../protectedFiles.js';
import type { TrashListingRepository } from '../Repositories/TrashListingRepository.js';
import type { Store } from '../store.js';

/** The custody/authorization callbacks database file operations need for one request. */
export type OperationAccessFactory = (request:RequestWithIdentity) => DatabaseOperationAccess;

/** /v1/trash: list a collection's trash with undo state, restore files/folders, purge folders. */
export class TrashRoutes {
  constructor(
    private readonly db:pg.Pool,
    private readonly access:FilesAccessGate,
    private readonly trash:TrashListingRepository,
    private readonly operationAccess:OperationAccessFactory,
    private readonly store:Store,
    private readonly manager?:LocalFilesManager,
  ) {}

  register(app:express.Express):void {
    const { identity } = this.access; const operationAccess = this.operationAccess;
    app.get('/v1/trash', async(request:RequestWithIdentity, response, next) => { try { response.json(await this.list(request)) } catch (error) { next(error) } });
    app.post('/v1/trash/:id/restore', async(request:RequestWithIdentity, response, next) => { try {
      const kind=request.body?.kind??'file'; const tombstone=request.body?.currentTombstone;
      const receiptId=tombstone?.receiptId; const tombstoneId=tombstone?.id;
      if (receiptId!==undefined && typeof receiptId!=='string') throw new HttpError(400,'currentTombstone.receiptId must be a string');
      if (kind==='folder' && receiptId!==undefined && tombstoneId!==undefined && receiptId!==tombstoneId) throw new HttpError(400,'currentTombstone id and receiptId must match');
      if (kind==='folder') {
        response.json(await restoreTrashedFolder(this.db,request.params.id,String(receiptId??tombstoneId??''),String(request.body?.expectedRevision??''),identity(request),operationAccess(request)));
        return;
      }
      if (kind!=='file') throw new HttpError(400,'kind must be file or folder');
      response.json(await restoreTrashedFile(this.db,request.params.id,identity(request),operationAccess(request),{
        expectedVersionId:String(tombstone?.id??request.body?.expectedVersionId??'')||undefined,
        expectedRevision:request.body?.expectedRevision===undefined?undefined:String(request.body.expectedRevision),
        receiptId,
      }));
    } catch (error) { next(error) } });
    app.delete('/v1/trash/:id/purge', async(request:RequestWithIdentity,response,next) => {
      if (request.body?.kind!=='folder') return next();
      try {
        const tombstone=request.body?.currentTombstone;
        const receiptId=tombstone?.receiptId; const tombstoneId=tombstone?.id;
        if (receiptId!==undefined && typeof receiptId!=='string') throw new HttpError(400,'currentTombstone.receiptId must be a string');
        if (receiptId!==undefined && tombstoneId!==undefined && receiptId!==tombstoneId) throw new HttpError(400,'currentTombstone id and receiptId must match');
        const manager=this.manager;
        const result=await purgeTrashedFolder(this.db,request.params.id,String(receiptId??tombstoneId??''),String(request.body?.expectedRevision??''),identity(request),operationAccess(request),{
          invalidateUndo:request.body?.invalidateUndo===true,
          ...(manager?{dispose:(receiptId:string)=>manager.disposeTrashReceipt(receiptId)}:{}),
          drainChunks:()=>drainPendingChunkGc(this.db,(collectionId,chunkId)=>this.store.delete(collectionId,chunkId)),
        });
        response.status(result.status==='recovery-required'?202:200).json(result);
      } catch(error) { next(error) }
    });
  }

  private undoState(receipt:any, pathOperation:any) {
    const lifecycle=receipt?.folder_plan?.lifecycle??{}; const disposal=pathOperation?.plan?.disposal??lifecycle.disposal??{};
    const state=disposal.undoInvalidatedAt?'invalidated':pathOperation && (!['completed','undone','rolled-back'].includes(pathOperation.state)||pathOperation.last_error)?'recovery-required':receipt?'available':'unavailable';
    return {state,...(lifecycle.expiresAt?{expiresAt:lifecycle.expiresAt}:{})};
  }

  private async list(request:RequestWithIdentity):Promise<any[]> {
    const collectionId=String(request.query.collectionId??''); const access=await this.access.requireCollection(request,collectionId,'view',true,true);
    const files=await this.trash.trashedFiles(collectionId);
    const allowed:any[]=[];
    // requireFile delegates to requirePath, which checks the collection role and
    // protected-path policy. Collection authorization is already established;
    // the SQL excludes protected files and the same policy is applied to folders below.
    // Same path rule requirePath applied per item: protected paths stay hidden,
    // except audit logs inside the logs system area.
    const pathVisible=(path:string)=>!isProtectedPath(path) || (access.collection.system_area==='logs' && (isAuditLogPath(path) || path==='audit/vault'));
    const visibleFiles=files.filter((file:any)=>pathVisible(file.path));
    const fileIds=visibleFiles.map((file:any)=>file.id);
    const fileReceipts=fileIds.length?await this.trash.fileTrashReceipts(fileIds):[];
    const fileReceiptByVersion=new Map<string,any>();
    for (const receipt of fileReceipts) {
      const versionId=receipt.after_state?.versionId;
      if (versionId) fileReceiptByVersion.set(`${receipt.file_id}:${versionId}`,receipt);
    }
    const fileOperationIds=fileReceipts.map((receipt:any)=>receipt.id);
    const pathOperations=fileOperationIds.length?await this.trash.pathOperations(fileOperationIds):[];
    const pathOperationById=new Map(pathOperations.map((operation:any)=>[operation.operation_id,operation]));
    for (const authorized of visibleFiles) {
      const role='manage'; const draftVisible=true;
      const receipt=fileReceiptByVersion.get(`${authorized.id}:${authorized.current_version_id}`);
      const pathOperation=receipt?pathOperationById.get(receipt.id):null;
      allowed.push({ ...lifecycleFields(authorized),kind:'file',id:authorized.id,path:authorized.path,revision:String(authorized.operation_revision),
        currentTombstone:{kind:'version',id:authorized.current_version_id,...(receipt?{receiptId:receipt.id,...(receipt.request?.batchOperationId?{operationId:receipt.request.batchOperationId}:{})}:{}),undo:this.undoState(receipt,pathOperation)},
        capabilities:lifecycleCapabilities(role,draftVisible) });
    }
    const folders=await this.trash.trashedTopFolders(collectionId);
    const visibleFolders=folders.filter((folder:any)=>pathVisible(folder.path));
    const folderReceipts=visibleFolders.length?await this.trash.folderTrashReceipts(collectionId,[...new Set(visibleFolders.map((folder:any)=>folder.path as string))]):[];
    const folderReceiptByFolder=new Map<string,any>();
    for(const receipt of folderReceipts) for(const item of receipt.folder_plan?.folders??[]) {
      const after=item?.after; if(!after) continue;
      const key=`${receipt.folder_plan.source}:${after.folderId}:${after.revision}`;
      if(!folderReceiptByFolder.has(key)) folderReceiptByFolder.set(key,receipt);
    }
    const folderOperationIds=[...new Set([...folderReceiptByFolder.values()].map((receipt:any)=>receipt.id as string))];
    const folderOperations=folderOperationIds.length?await this.trash.pathOperations(folderOperationIds):[];
    const folderOperationById=new Map(folderOperations.map((operation:any)=>[operation.operation_id,operation]));
    for (const folder of visibleFolders) {
      const role='manage';
      const receipt=folderReceiptByFolder.get(`${folder.path}:${folder.id}:${String(folder.operation_revision)}`);
      if (!receipt) continue;
      const pathOperation=folderOperationById.get(receipt.id);
      allowed.push({kind:'folder',id:folder.id,path:folder.path,revision:String(folder.operation_revision),deleted_at:folder.deleted_at,
        currentTombstone:{kind:'receipt',id:receipt.id,receiptId:receipt.id,...(receipt.request?.batchOperationId?{operationId:receipt.request.batchOperationId}:{}),undo:this.undoState(receipt,pathOperation)},
        capabilities:lifecycleCapabilities(role,false)});
    }
    return allowed;
  }
}
