// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type express from 'express';
import type pg from 'pg';

import { controlDatabaseBatch, databaseOperationCapabilities, getDatabaseBatch, parseDatabaseBatch, runDatabaseBatch, submitDatabaseBatch } from '../databaseOperationBatches.js';
import { applyDatabaseFileOperations, type FileOperationItem } from '../fileOperations.js';
import { folderOperationState } from '../folderOperationBatches.js';
import type { FilesAccessGate, RequestWithIdentity } from '../Http/FilesAccessGate.js';
import { FilesRequestInput } from '../Http/FilesRequestInput.js';
import { HttpError } from '../Http/HttpError.js';
import type { LocalFilesManager } from '../localManager.js';
import type { FileLocatorRepository } from '../Repositories/FileLocatorRepository.js';
import type { OperationAccessFactory } from './TrashRoutes.js';

/** Receipt-backed database file operation batches and legacy path move/copy (/v1/file-operations). */
export class FileOperationRoutes {
  constructor(
    private readonly db:pg.Pool,
    private readonly access:FilesAccessGate,
    private readonly locator:FileLocatorRepository,
    private readonly operationAccess:OperationAccessFactory,
    private readonly manager?:LocalFilesManager,
  ) {}

  register(app:express.Express):void {
    const { identity, requireCollection, requirePath } = this.access; const db = this.db; const operationAccess = this.operationAccess;
    app.post('/v1/database-file-operations', async(request:RequestWithIdentity, response, next) => { try {
      const result = await submitDatabaseBatch(db, parseDatabaseBatch(request.body), identity(request), operationAccess(request));
      response.status(202).json(result);
      void runDatabaseBatch(db, result.operationId, identity(request), operationAccess(request)).catch(() => undefined);
    } catch (error) { next(error) } });
    app.get('/v1/database-file-operations/capabilities', async(request:RequestWithIdentity, response, next) => { try {
      const collectionId = String(request.query.collectionId ?? '');
      await requireCollection(request, collectionId, 'edit', true, true);
      response.json(await databaseOperationCapabilities(db, collectionId, operationAccess(request)));
    } catch (error) { next(error) } });
    app.get('/v1/database-file-operations/folder-state', async(request:RequestWithIdentity, response, next) => { try {
      const collectionId=String(request.query.collectionId??''); const path=FilesRequestInput.cleanPath(request.query.path,false);
      await requirePath(request,collectionId,path,'edit');
      response.json(await folderOperationState(db,collectionId,path,operationAccess(request)));
    } catch (error) { next(error) } });
    app.get('/v1/database-file-operations/:id', async(request:RequestWithIdentity, response, next) => { try {
      response.json(await getDatabaseBatch(db, request.params.id, identity(request), operationAccess(request)));
    } catch (error) { next(error) } });
    for (const action of ['cancel', 'retry', 'undo'] as const) app.post('/v1/database-file-operations/:id/' + action, async(request:RequestWithIdentity, response, next) => { try {
      const result = await controlDatabaseBatch(db, request.params.id, action, request.body, identity(request), operationAccess(request));
      response.json(result);
      if (action === 'retry') void runDatabaseBatch(db, result.operationId, identity(request), operationAccess(request)).catch(() => undefined);
    } catch (error) { next(error) } });
    app.post('/v1/file-operations', async(request:RequestWithIdentity, response, next) => { try { response.json(await this.moveOrCopy(request)) } catch (error) { next(error) } });
  }

  private async moveOrCopy(request:RequestWithIdentity):Promise<unknown> {
    const { identity, requireFile, requirePath, visibleVersion } = this.access; const manager = this.manager;
    const action = request.body.action; const collectionId = String(request.body.collectionId ?? ''); const items = request.body.items as FileOperationItem[];
    if (!['move', 'copy'].includes(action) || !Array.isArray(items) || !items.length || items.length > 250) throw new HttpError(400, 'action and 1-250 items are required');
    const expanded:{ file:any; targetPath:string }[] = []; const localItems:{ sourcePath:string; targetPath:string; folder:boolean; fileSnapshots:{ id:string; path:string; currentVersionId:string }[] }[] = []; const folderMoves:{ collectionId:string; sourcePath:string; targetPath:string }[] = [];
    for (const raw of items) {
      const targetPath = FilesRequestInput.cleanPath(raw.targetPath, false);
      if (raw.fileId) { const file = await requireFile(request, String(raw.fileId), action === 'copy' ? 'view' : 'edit'); if (file.collection_id !== collectionId) throw new HttpError(400, 'selected file belongs to another collection'); await requirePath(request, collectionId, targetPath, 'edit'); const copyVersionId = action === 'copy' ? await visibleVersion(request, file) : undefined; expanded.push({ file: { ...file, copy_version_id: copyVersionId }, targetPath }); localItems.push({ sourcePath: file.path, targetPath, folder: false, fileSnapshots: [{ id: file.id, path: file.path, currentVersionId: file.current_version_id }] }); }
      else if (raw.folderPath) {
        const folderPath = FilesRequestInput.cleanPath(raw.folderPath, false); if (targetPath === folderPath || targetPath.startsWith(`${ folderPath }/`)) throw new HttpError(400, 'a folder cannot be moved or copied into itself'); await requirePath(request, collectionId, folderPath, action === 'copy' ? 'view' : 'edit'); await requirePath(request, collectionId, targetPath, 'edit');
        const rows = await this.locator.liveSubtreeFiles(collectionId, folderPath);
        const fileSnapshots = [];
        for (const candidate of rows) { const file = await requireFile(request, candidate.id, action === 'copy' ? 'view' : 'edit'); const copyVersionId = action === 'copy' ? await visibleVersion(request, file) : undefined; expanded.push({ file: { ...file, copy_version_id: copyVersionId }, targetPath: `${ targetPath }${ file.path.slice(folderPath.length) }` }); fileSnapshots.push({ id: file.id, path: file.path, currentVersionId: file.current_version_id }); }
        localItems.push({ sourcePath: folderPath, targetPath, folder: true, fileSnapshots });
        folderMoves.push({ collectionId, sourcePath: folderPath, targetPath });
      } else throw new HttpError(400, 'each item requires fileId or folderPath');
    }
    if (!expanded.length && !folderMoves.length) throw new HttpError(404, 'folder not found');
    const watched = manager ? await manager.watchedPathCoverage(collectionId, localItems) : 0;
    if (manager && expanded.length > 0 && watched === expanded.length) await manager.applyPathOperations(action, localItems, identity(request));
    else if (watched === 0) await applyDatabaseFileOperations(this.db, action, expanded, identity(request), folderMoves);
    else throw new HttpError(409, 'The selection mixes watched and stored-only Files. Move or copy them in separate operations.');
    return { ok: true, count: expanded.length + folderMoves.length, undoSupported: false, undoUnsupportedReason: 'Legacy path operations do not issue database receipts; native undo requires custody-coordinated publication.' };
  }
}
