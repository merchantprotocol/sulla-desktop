// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';
import { DatabaseBatchService } from './DatabaseBatchService.js';
import { DatabaseOperationContext } from './DatabaseOperationContext.js';
import { DatabaseOperationService } from './DatabaseOperationService.js';
import { DatabaseOperationUndoService } from './DatabaseOperationUndoService.js';
import { FolderOperationService } from './FolderOperationService.js';
import { FolderSubtreeInspector } from './FolderSubtreeInspector.js';
import { FolderTrashService } from './FolderTrashService.js';
import { FolderUndoService } from './FolderUndoService.js';
import { OperationCancellationRegistry } from './OperationCancellationRegistry.js';
import { TrashRestoreService } from './TrashRestoreService.js';

/**
 * Wires the receipt, Trash, folder and batch services over one pool and one cancellation
 * registry. The composition root builds this once; the cancellation registry must be the same
 * instance the native journal asserts against.
 */
export class DatabaseOperationServices {
  readonly context:DatabaseOperationContext;
  readonly files:DatabaseOperationService;
  readonly fileUndo:DatabaseOperationUndoService;
  readonly trash:TrashRestoreService;
  readonly inspector:FolderSubtreeInspector;
  readonly folders:FolderOperationService;
  readonly folderTrash:FolderTrashService;
  readonly folderUndo:FolderUndoService;
  readonly batches:DatabaseBatchService;

  constructor(db:pg.Pool, cancellation:OperationCancellationRegistry) {
    this.context = new DatabaseOperationContext(db, cancellation);
    this.files = new DatabaseOperationService(this.context);
    this.fileUndo = new DatabaseOperationUndoService(this.context);
    this.trash = new TrashRestoreService(this.context);
    this.inspector = new FolderSubtreeInspector(this.context);
    this.folders = new FolderOperationService(this.context, this.files, this.inspector);
    this.folderTrash = new FolderTrashService(this.context, this.trash);
    this.folderUndo = new FolderUndoService(this.context, this.fileUndo);
    this.batches = new DatabaseBatchService(this.context, { files: this.files, fileUndo: this.fileUndo, folders: this.folders, folderUndo: this.folderUndo });
  }

  /** Legacy-shim entry: services over `db` sharing the registry owned by that pool. */
  static forPool(db:pg.Pool):DatabaseOperationServices {
    return new DatabaseOperationServices(db, OperationCancellationRegistry.sharedBy(db));
  }
}
