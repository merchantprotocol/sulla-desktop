// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { onBeforeUnmount } from 'vue';

import { FilesOperationQueue } from './FilesOperationQueue';

import type { FilesDataSource, FilesOperationReceipt, FilesOperationRequest, FilesOperationRetry } from '../types';

export { FilesOperationQueue } from './FilesOperationQueue';

/** Thin Vue binding: one FilesOperationQueue per Files tab, disposed with the component. */
export function useFilesOperationQueue(source:FilesDataSource, tabId:string) {
  const queue = new FilesOperationQueue(source, tabId, sessionStorage);

  onBeforeUnmount(() => queue.dispose());
  return {
    receipts:          queue.receipts,
    current:           queue.current,
    undoable:          queue.undoable,
    pendingRequest:    queue.pendingRequest,
    error:             queue.error,
    active:            queue.active,
    supported:         () => queue.supported(),
    submit:            (request:FilesOperationRequest) => queue.submit(request),
    cancel:            (operationId:string) => queue.cancel(operationId),
    retry:             (id:string, request?:FilesOperationRetry) => queue.retry(id, request),
    undo:              (id:string) => queue.undo(id),
    resume:            (id:string) => queue.resume(id),
    restore:           (collectionId:string) => queue.restore(collectionId),
    touchesCollection: (receipt:FilesOperationReceipt, collectionId?:string) => queue.touchesCollection(receipt, collectionId),
  };
}
