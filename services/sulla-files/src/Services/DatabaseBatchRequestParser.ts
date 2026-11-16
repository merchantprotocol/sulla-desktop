// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { DatabaseBatchItem, DatabaseBatchRequest } from './DatabaseBatchTypes.js';
import { DatabaseOperationRequestParser } from './DatabaseOperationRequestParser.js';
import { OperationFailure } from './OperationFailure.js';

const uuid = OperationFailure.uuid;
const fail = (status:number, message:string, code='invalid-operation'):Error => OperationFailure.coded(status, message, code);
const pathValid = (path:unknown):path is string => typeof path === 'string' && path.length > 0 && !path.includes('\\') && !path.includes('\0') && path.split('/').every(p => p && p !== '.' && p !== '..' && p!=='.sulla-trash' && p!=='.sulla-operation-recovery');

/** Validates and normalizes batch requests and their file, folder and create-folder items. */
export class DatabaseBatchRequestParser {
  constructor(private readonly files = new DatabaseOperationRequestParser()) {}

  parse(value:any):DatabaseBatchRequest {
    if (!value || typeof value.idempotencyKey !== 'string' || !uuid.test(value.idempotencyKey) || typeof value.collectionId !== 'string' || !uuid.test(value.collectionId)) throw fail(400, 'idempotencyKey and collectionId must be UUIDs');
    // Preserve the original single-item request form on the same endpoint.
    const raw = value.items ?? [{ ...value, itemId: value.idempotencyKey }];
    if (!Array.isArray(raw) || !raw.length || raw.length > 250) throw fail(400, 'Supply 1-250 items');
    const items = raw.map(item => this.item(item, value.collectionId));
    if (new Set(items.map(item => item.itemId)).size !== items.length) throw fail(400, 'Duplicate itemId');
    return { idempotencyKey: value.idempotencyKey.toLowerCase(), collectionId: value.collectionId.toLowerCase(), items };
  }

  item(item:any, collectionId:string):DatabaseBatchItem {
    if (!item || typeof item.itemId !== 'string' || !uuid.test(item.itemId)) throw fail(400, 'itemId must be a UUID');
    if (item.targetCollectionId!==undefined && (typeof item.targetCollectionId!=='string' || !uuid.test(item.targetCollectionId))) throw fail(400,'targetCollectionId must be a UUID');
    if (item.kind!==undefined && !['file','folder'].includes(item.kind)) throw fail(400,'Unknown item kind');
    if (item.kind==='folder') return this.folderItem(item, collectionId);
    if (item.action === 'create-folder') {
      if (!pathValid(item.targetPath) || (item.collisionPolicy !== undefined && !['keep-both','skip'].includes(item.collisionPolicy))) throw fail(400, 'Folder creation requires a canonical path and optional keep-both or skip policy');
      return { itemId: item.itemId.toLowerCase(), action: 'create-folder', targetPath: item.targetPath, ...(item.collisionPolicy ? { collisionPolicy: item.collisionPolicy } : {}) };
    }
    const { idempotencyKey: _key, collectionId: _collection, ...parsed } = this.files.parse({ ...item, collectionId, idempotencyKey: item.itemId });
    return { ...parsed, itemId: item.itemId.toLowerCase(),...(item.targetCollectionId?{targetCollectionId:item.targetCollectionId.toLowerCase()}:{}) };
  }

  private folderItem(item:any, collectionId:string):DatabaseBatchItem {
    if (!['move','copy','rename','trash'].includes(item.action) || !pathValid(item.folderPath) || item.fileId!==undefined || item.expectedVersionId!==undefined) throw fail(400,'Folder operations require folderPath and no file identity');
    if (item.targetCollectionId!==undefined && !['move','copy'].includes(item.action)) throw fail(400,'Only folder move/copy accept targetCollectionId');
    if (item.action!=='trash' && !pathValid(item.targetPath)) throw fail(400,'Folder targetPath must be canonical');
    if (item.action==='trash' && (item.targetPath!==undefined || item.collisionPolicy!==undefined || item.targetCollectionId!==undefined)) throw fail(400,'Trash has no destination');
    if (item.collisionPolicy!==undefined && !['replace','keep-both','skip'].includes(item.collisionPolicy)) throw fail(400,'Folder collisions support Replace, Keep Both or Skip');
    if (item.expectedFolder && (!uuid.test(item.expectedFolder.folderId) || item.expectedFolder.path!==item.folderPath || typeof item.expectedFolder.revision!=='string' || !/^[0-9]+$/.test(item.expectedFolder.revision) ||
      (item.expectedFolder.collectionId!==undefined && item.expectedFolder.collectionId!==collectionId))) throw fail(400,'Invalid expectedFolder snapshot');
    const sourceSignature = item.sourceSubtreeSignature??item.expectedFolder?.subtreeSignature;
    if (item.targetCollectionId && item.targetCollectionId!==collectionId && (typeof sourceSignature!=='string' || !/^[0-9a-f]{64}$/.test(sourceSignature))) throw fail(400,'Cross-collection folders require the displayed source subtree signature');
    if (item.collisionPolicy==='replace' && (!item.expectedDestination || !uuid.test(item.expectedDestination.folderId) || item.expectedDestination.path!==item.targetPath || typeof item.expectedDestination.revision!=='string' || !/^\d+$/.test(item.expectedDestination.revision) || typeof item.expectedDestination.subtreeSignature!=='string' || !/^[0-9a-f]{64}$/.test(item.expectedDestination.subtreeSignature) ||
      (item.expectedDestination.collectionId!==undefined && item.expectedDestination.collectionId!==(item.targetCollectionId??collectionId)))) throw fail(400,'Folder Replace requires the displayed destination collection, identity, revision and subtree signature');
    if (item.collisionPolicy!=='replace' && item.expectedDestination!==undefined) throw fail(400,'expectedDestination is only accepted for folder Replace');
    return { itemId:item.itemId.toLowerCase(),kind:'folder',action:item.action,folderPath:item.folderPath,
      ...(item.expectedFolder?{expectedFolder:item.expectedFolder}:{}),...(item.targetPath?{targetPath:item.targetPath}:{}),
      ...(sourceSignature?{sourceSubtreeSignature:sourceSignature}:{}),
      ...(item.collisionPolicy?{collisionPolicy:item.collisionPolicy}:{}),...(item.expectedDestination?{expectedDestination:item.expectedDestination}:{}),
      ...(item.targetCollectionId?{targetCollectionId:item.targetCollectionId.toLowerCase()}:{}) };
  }
}
