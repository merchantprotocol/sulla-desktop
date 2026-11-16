// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';
import type { FilesIdentity } from '../auth.js';
import { assertUnprotectedFile } from '../protectedFiles.js';
import type { OperationFileRepository } from '../Repositories/OperationFileRepository.js';
import type { OperationPermissionRepository } from '../Repositories/OperationPermissionRepository.js';
import type { DatabaseOperationAccess } from './DatabaseOperationTypes.js';
import { OperationFailure } from './OperationFailure.js';

type Queryable = Pick<pg.PoolClient, 'query'>;

/** The checks every receipt operation applies: custody, locks/checkout, permission boundaries and signatures. */
export class DatabaseOperationPolicy {
  constructor(private readonly files:OperationFileRepository, private readonly permissions:OperationPermissionRepository) {}

  /** The Trash retention configured for the collection, as a receipt lifecycle. */
  async receiptLifecycle(client:Queryable, collectionId:string, deletedAt:Date):Promise<{ expiresAt?:string }> {
    const policy = await this.permissions.retentionPolicy(client, collectionId);
    const days = Number(policy?.trashDays);
    if (!Number.isInteger(days) || days<0) return {};
    return { expiresAt:new Date(deletedAt.valueOf()+days*86_400_000).toISOString() };
  }

  /** Locks the file and refuses protected files, unauthorized callers and native files without custody. */
  async lockedFile(client:pg.PoolClient, id:string, access:DatabaseOperationAccess):Promise<any> {
    const row = await this.files.lockById(client, id);
    if (!row) throw OperationFailure.of(409, 'The file no longer exists');
    await assertUnprotectedFile(client, row);
    await access.file(client, id);
    if (await this.files.underNativeCustody(client, row.collection_id, id) && !access.custody) throw Object.assign(OperationFailure.of(422, 'Native Files receipt and undo are unsupported; a custody-coordinated native operation is required'), { code:'native-custody-required' });
    return row;
  }

  editable(file:any, actor:FilesIdentity):void {
    if (file.record_lock_type !== 'none') throw OperationFailure.of(423, 'The record is locked');
    if (file.checked_out_by_user_id && (file.checked_out_by_user_id !== actor.userId ||
      (file.checked_out_by_device_id && file.checked_out_by_device_id !== (actor.deviceId || 'server-web')))) throw OperationFailure.of(409, 'The file is checked out by another editor');
    if (file.require_checkout && !file.checked_out_by_user_id) throw OperationFailure.of(409, 'The file must be checked out first');
  }

  /**
   * Moving across inherited grant/public-link boundaries can expose content to
   * new readers. Stage one refuses that transition; direct file grants stay put.
   */
  async permissionBoundary(client:Queryable, collectionId:string, from:string, to:string):Promise<void> {
    if (await this.permissions.crossesFolderBoundary(client, collectionId, from, to)) throw OperationFailure.of(422, 'Moving across folder permission boundaries is not supported by this receipt API');
  }

  /** A cross-collection transfer must keep the same owner, kind, audience and recoverable key contexts. */
  async crossCollectionBoundary(client:Queryable, source:string, target:string, actor:FilesIdentity, input?:{
    sourcePath?:string; targetPath?:string; fileIds?:string[];
  }):Promise<void> {
    const deny = (message='Cross-collection transfer changes the authorized audience') => Object.assign(OperationFailure.of(422,message),{code:'cross-collection-boundary'});
    const rows = await this.permissions.shareCollections(client, source, target);
    if (rows.length!==2 || rows.some(r=>r.owner_user_id!==actor.userId || r.kind==='scratch') || rows[0].kind!==rows[1].kind) throw deny();
    if (JSON.stringify(await this.permissions.audience(client, source, input?.sourcePath))!==JSON.stringify(await this.permissions.audience(client, target, input?.targetPath))) throw deny();
    if (await this.permissions.activeFolderLinkAt(client, source, target, input?.sourcePath??null, input?.targetPath??null)) throw deny('Cross-collection folders with active public links cannot be transferred');
    const fileIds = input?.fileIds??[];
    if (fileIds.length && await this.permissions.unrecoverableKeyContext(client, fileIds, actor.userId)) {
      throw Object.assign(OperationFailure.of(422,'Cross-collection version key context is not recoverable for the current owner'),{code:'cross-collection-key-boundary'});
    }
  }

  async permissionSignature(client:Queryable, collectionId:string, operationId:string):Promise<string> {
    const target = await this.permissions.receiptTargetCollection(client, operationId);
    const collections = [...new Set([collectionId,target].filter(Boolean))].sort() as string[];
    return this.permissions.signature(client, collections, operationId);
  }
}
