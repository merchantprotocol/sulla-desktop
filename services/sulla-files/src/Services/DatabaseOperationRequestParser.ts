// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { DatabaseOperationRequest } from './DatabaseOperationTypes.js';
import { OperationFailure } from './OperationFailure.js';

/** Validates and normalizes one file receipt request (move, copy, rename, Trash). */
export class DatabaseOperationRequestParser {
  parse(value:any):DatabaseOperationRequest {
    const uuid = OperationFailure.uuid; const fail = OperationFailure.of;
    if (!value || !['move', 'copy', 'rename', 'trash'].includes(value.action)) throw fail(422, 'Unsupported database operation');
    for (const key of ['idempotencyKey', 'collectionId', 'fileId', 'expectedVersionId']) {
      if (typeof value[key] !== 'string' || !uuid.test(value[key])) throw fail(400, key + ' must be a UUID');
    }
    if (value.targetCollectionId!==undefined && (typeof value.targetCollectionId!=='string' || !uuid.test(value.targetCollectionId) || !['move','copy'].includes(value.action))) throw fail(400,'Only move/copy accept a UUID targetCollectionId');
    if (typeof value.expectedRevision !== 'string' || !/^[0-9]+$/.test(value.expectedRevision)) throw fail(400, 'expectedRevision must be the file operation_revision string');
    if (value.collisionPolicy !== undefined && !['replace', 'keep-both', 'skip'].includes(value.collisionPolicy)) throw fail(422, 'Unsupported collision policy');
    if (value.collisionPolicy === 'replace' && (!value.expectedDestination || !uuid.test(value.expectedDestination.fileId) || !uuid.test(value.expectedDestination.versionId) ||
      typeof value.expectedDestination.path!=='string' || value.expectedDestination.path!==value.targetPath || !/^[0-9]+$/.test(value.expectedDestination.revision) || value.expectedDestination.deleted!==false ||
      (value.expectedDestination.collectionId!==undefined && (!uuid.test(value.expectedDestination.collectionId) || value.expectedDestination.collectionId!==(value.targetCollectionId??value.collectionId))))) {
      throw fail(400, 'Replace requires the displayed destination collection, identity, path, version and revision');
    }
    if (value.action !== 'trash' && (typeof value.targetPath !== 'string' || !value.targetPath || value.targetPath.includes('\\') ||
      value.targetPath.includes('\0') || value.targetPath.split('/').some((part:string) => !part || part === '.' || part === '..' || part==='.sulla-trash' || part==='.sulla-operation-recovery'))) throw fail(400, 'targetPath must be a canonical relative Files path');
    if (value.action === 'trash' && (value.targetPath !== undefined || value.collisionPolicy !== undefined)) throw fail(400, 'Trash does not accept a destination or collision policy');
    return {
      idempotencyKey: value.idempotencyKey.toLowerCase(), collectionId: value.collectionId.toLowerCase(),
      fileId: value.fileId.toLowerCase(), expectedVersionId: value.expectedVersionId.toLowerCase(),
      expectedRevision: value.expectedRevision, action: value.action,
      ...(value.targetCollectionId?{targetCollectionId:value.targetCollectionId.toLowerCase()}:{}),
      ...(value.action === 'trash' ? {} : { targetPath: value.targetPath, collisionPolicy: value.collisionPolicy }),
      ...(value.expectedDestination ? { expectedDestination: value.expectedDestination } : {}),
    };
  }
}
