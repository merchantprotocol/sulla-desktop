// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type express from 'express';
import type pg from 'pg';

import { CollectionRoleGate, resolveCollectionAccess } from '../acl.js';
import type { FilesIdentity } from '../auth.js';
import { authorizedVersionId } from '../documentLifecycle.js';
import { assertUnprotectedFile, isAuditLogPath, isProtectedPath, protectedPathError } from '../protectedFiles.js';
import { FileAccessRepository } from '../Repositories/FileAccessRepository.js';
import { assertSystemAreaWritable } from '../systemAreas.js';
import { HttpError } from './HttpError.js';

export type RequestWithIdentity = express.Request<Record<string, string>> & { filesIdentity?: FilesIdentity };
export type Right = 'view' | 'edit' | 'manage';
type Queryable = pg.Pool | pg.PoolClient;

/**
 * Every Files route's authorization: who is calling, and whether their collection role allows
 * the right on a collection, path or file. Members are arrow properties so routes can take them
 * as plain callbacks. Pass a transaction client to check inside a write transaction.
 */
export class FilesAccessGate {
  constructor(
    private readonly db:pg.Pool,
    private readonly records = new FileAccessRepository(db),
    private readonly roleGate = new CollectionRoleGate(),
  ) {}

  readonly identity = (request:RequestWithIdentity):FilesIdentity => { if (!request.filesIdentity) throw new HttpError(401, 'identity required'); return request.filesIdentity };

  readonly collectionRow = async(collectionId:string, queryable:Queryable = this.db):Promise<any> => {
    const row = await this.records.publishedCollection(collectionId, queryable);
    if (!row) throw new HttpError(404, 'collection not found');
    return row;
  };

  readonly collectionAccess = async(request:RequestWithIdentity, collectionId:string, queryable:Queryable = this.db) => {
    return resolveCollectionAccess(queryable, this.identity(request), collectionId);
  };

  readonly requireCollection = async(
    request:RequestWithIdentity,
    collectionId:string,
    right:Right,
    _allowShared = false,
    _allowExactFiles = false,
    queryable:Queryable = this.db,
  ) => {
    const access = await this.collectionAccess(request, collectionId, queryable);
    if (!this.roleGate.allows(access.role, right)) throw new HttpError(403, 'access denied');
    if (right !== 'view') assertSystemAreaWritable(access.collection.system_area);
    return access;
  };

  readonly requirePath = async(request:RequestWithIdentity, collectionId:string, path:string, right:Right, queryable:Queryable = this.db) => {
    this.identity(request);
    const access = await this.collectionAccess(request, collectionId, queryable);
    // Every edit/move/delete/upload path funnels through here (requireFile too), so the level is checked here.
    if (!this.roleGate.allows(access.role, right)) throw new HttpError(403, 'access denied');
    if (isProtectedPath(path) && !(access.collection.system_area === 'logs' && (isAuditLogPath(path) || path === 'audit/vault'))) throw protectedPathError();
    if (right !== 'view') assertSystemAreaWritable(access.collection.system_area);
    return access;
  };

  readonly fileRow = async(fileId:string, queryable:Queryable = this.db):Promise<any> => {
    const row = await this.records.file(fileId, queryable);
    if (!row) throw new HttpError(404, 'file not found');
    await assertUnprotectedFile(queryable, row);
    return row;
  };

  readonly requireFile = async(request:RequestWithIdentity, fileId:string, right:Right, queryable:Queryable = this.db):Promise<any> => {
    const file = await this.fileRow(fileId, queryable);
    await this.requirePath(request, file.collection_id, file.path, right, queryable);
    return file;
  };

  readonly visibleVersion = async(_request:RequestWithIdentity, file:any, requested?:string):Promise<string> => {
    return authorizedVersionId(this.db, file, true, requested);
  };
}
