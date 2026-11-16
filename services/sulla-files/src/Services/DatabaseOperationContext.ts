// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';
import { DatabaseOperationBatchRepository } from '../Repositories/DatabaseOperationBatchRepository.js';
import { DatabaseOperationReceiptRepository } from '../Repositories/DatabaseOperationReceiptRepository.js';
import { FolderGrantRepository } from '../Repositories/FolderGrantRepository.js';
import { FolderPurgeRepository } from '../Repositories/FolderPurgeRepository.js';
import { FolderSubtreeRepository } from '../Repositories/FolderSubtreeRepository.js';
import { OperationAuditRepository } from '../Repositories/OperationAuditRepository.js';
import { OperationFileRepository } from '../Repositories/OperationFileRepository.js';
import { OperationLockRepository } from '../Repositories/OperationLockRepository.js';
import { OperationPermissionRepository } from '../Repositories/OperationPermissionRepository.js';
import { OperationVersionRepository } from '../Repositories/OperationVersionRepository.js';
import { DatabaseOperationPolicy } from './DatabaseOperationPolicy.js';
import type { OperationCancellationRegistry } from './OperationCancellationRegistry.js';
import { SerializableTransaction } from './SerializableTransaction.js';

/**
 * The pool, cancellation registry and repositories shared by the receipt, folder and batch
 * services. Built once at composition; tests pass their own repositories or pool.
 */
export class DatabaseOperationContext {
  readonly transaction:SerializableTransaction;
  readonly policy:DatabaseOperationPolicy;

  constructor(
    readonly db:pg.Pool,
    readonly cancellation:OperationCancellationRegistry,
    readonly files = new OperationFileRepository(),
    readonly versions = new OperationVersionRepository(),
    readonly receipts = new DatabaseOperationReceiptRepository(),
    readonly batches = new DatabaseOperationBatchRepository(),
    readonly audit = new OperationAuditRepository(),
    readonly locks = new OperationLockRepository(),
    readonly subtree = new FolderSubtreeRepository(),
    readonly grants = new FolderGrantRepository(),
    readonly purge = new FolderPurgeRepository(),
    readonly permissions = new OperationPermissionRepository(),
  ) {
    this.transaction = new SerializableTransaction(db);
    this.policy = new DatabaseOperationPolicy(files, permissions);
  }
}
