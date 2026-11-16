// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// risk: data integrity. The synthetic data source is the reference behaviour /files-preview uses to
// exercise durable operations without private files: receipts must advance item by item, honour
// idempotency keys, collision policies, cancel, retry and undo, and trash restore/purge must refuse
// any stale revision or tombstone exactly like the service's CAS checks.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SyntheticFilesDataSource } from './SyntheticFilesDataSource';

import type { FilesOperationItem, FilesOperationReceipt, FilesTrashItem } from './types';

const moveReadme:FilesOperationItem = { itemId: 'i-readme', action: 'move', kind: 'file', fileId: 'synthetic-readme', expectedVersionId: 'version-readme', expectedRevision: '5', targetPath: 'Projects/Readme.md' };
const moveData:FilesOperationItem = { itemId: 'i-data', action: 'move', kind: 'file', fileId: 'synthetic-data', expectedVersionId: 'version-data', expectedRevision: '4', targetPath: 'Data.json' };

describe('SyntheticFilesDataSource', () => {
  let source:SyntheticFilesDataSource;

  beforeEach(() => { vi.useFakeTimers(); source = new SyntheticFilesDataSource() });
  afterEach(() => { vi.useRealTimers() });

  const settle = async(receipt:FilesOperationReceipt) => {
    for (let step = 0; step < 50 && receipt.state === 'pending'; step++) {
      await vi.advanceTimersByTimeAsync(420);
      receipt = await source.getOperation(receipt.operationId);
    }
    return receipt;
  };
  const pathOf = async(fileId:string) => (await source.load()).files.find(file => file.id === fileId)?.path;

  it('lists active files and only listed trash rows (not the nested trashed folder), for the selected collection', async() => {
    const snapshot = await source.load();

    expect(snapshot.collection.id).toBe('synthetic-collection');
    expect(snapshot.availableCollections?.map(item => item.id)).toEqual(['synthetic-collection', 'synthetic-stored-collection', 'synthetic-sulla']);
    expect(snapshot.trash?.map(item => `${ item.kind }:${ item.id }`).sort()).toEqual(['file:synthetic-trash-child', 'file:synthetic-trash-file', 'file:synthetic-trash-nested-child', 'file:synthetic-trash-recovery', 'folder:synthetic-trash-folder']);
    expect(snapshot.status.indexing).toMatchObject({ total: 10, indexed: 10, complete: true });
  });

  it('moves a file through a pending receipt and undoes it back to the original path', async() => {
    const receipt = await settle(await source.submitOperation({ idempotencyKey: 'k1', collectionId: 'synthetic-collection', items: [moveReadme] }));

    expect(receipt).toMatchObject({ state: 'completed', undoSupported: true });
    expect(receipt.items[0]).toMatchObject({ state: 'completed', before: { path: 'Readme.md' }, after: { path: 'Projects/Readme.md' } });
    expect(await pathOf('synthetic-readme')).toBe('Projects/Readme.md');

    const undone = await source.undoOperation(receipt.operationId);

    expect(undone.state).toBe('undone');
    expect(await pathOf('synthetic-readme')).toBe('Readme.md');
  });

  it('replays the same idempotency key and rejects a different request under it', async() => {
    const request = { idempotencyKey: 'k2', collectionId: 'synthetic-collection', items: [moveReadme] };
    const first = await source.submitOperation(request);

    expect((await source.submitOperation(request)).operationId).toBe(first.operationId);
    await expect(source.submitOperation({ ...request, items: [moveData] })).rejects.toThrow('Idempotency key was already submitted with a different synthetic request');
    await expect(source.submitOperation({ idempotencyKey: 'k3', collectionId: 'synthetic-collection', items: [] })).rejects.toThrow('Synthetic operation request is invalid');
  });

  it('fails a collision with the destination snapshot, then completes on Keep Both retry', async() => {
    const copy:FilesOperationItem = { itemId: 'i-copy', action: 'copy', kind: 'file', fileId: 'synthetic-notes', expectedVersionId: 'version-notes', expectedRevision: '2', targetPath: 'Projects/Beta/meeting-notes.md' };
    const failed = await settle(await source.submitOperation({ idempotencyKey: 'k4', collectionId: 'synthetic-collection', items: [copy] }));

    expect(failed).toMatchObject({ state: 'failed', retryable: true });
    expect(failed.items[0].error).toMatchObject({ code: 'destination-conflict', message: 'A synthetic item already exists at Projects/Beta/meeting-notes.md.', destination: { fileId: 'synthetic-collision', path: 'Projects/Beta/meeting-notes.md' } });
    await expect(source.retryOperation(failed.operationId, { items: [{ itemId: 'i-copy', collisionPolicy: 'replace' }] })).rejects.toThrow('Replace requires the exact displayed synthetic destination snapshot');

    const retried = await settle(await source.retryOperation(failed.operationId, { items: [{ itemId: 'i-copy', collisionPolicy: 'keep-both' }] }));

    expect(retried.state).toBe('completed');
    expect((await source.load()).files.some(file => file.path === 'Projects/Beta/meeting-notes copy.md')).toBe(true);
    expect(await pathOf('synthetic-notes')).toBe('Projects/Alpha/meeting-notes.md');
  });

  it('cancels every item that has not started and leaves them retryable', async() => {
    const pending = await source.submitOperation({ idempotencyKey: 'k5', collectionId: 'synthetic-collection', items: [moveReadme, moveData] });

    expect((await source.cancelOperation(pending.operationId)).cancelRequested).toBe(true);
    const cancelled = await settle(pending);

    expect(cancelled).toMatchObject({ state: 'cancelled', retryable: true });
    expect(cancelled.items.map(item => item.error?.code)).toEqual(['operation-cancelled', 'operation-cancelled']);
    expect(await pathOf('synthetic-readme')).toBe('Readme.md');
  });

  it('refuses a folder move whose subtree signature is stale and accepts the current one', async() => {
    const folder = { itemId: 'i-folder', action: 'move' as const, kind: 'folder' as const, folderPath: 'Projects/Empty folder', targetPath: 'Moved folder' };
    const stale = await settle(await source.submitOperation({ idempotencyKey: 'k6', collectionId: 'synthetic-collection', items: [{ ...folder, sourceSubtreeSignature: '0'.repeat(64) }] }));

    expect(stale.items[0].error).toMatchObject({ code: 'source-conflict' });
    const state = await source.folderOperationState('synthetic-collection', 'Projects/Empty folder');

    expect(state.subtreeSignature).toMatch(/^[0-9a-f]{64}$/);
    const moved = await settle(await source.submitOperation({ idempotencyKey: 'k7', collectionId: 'synthetic-collection', items: [{ ...folder, sourceSubtreeSignature: state.subtreeSignature }] }));

    expect(moved.state).toBe('completed');
    expect((await source.load()).folders).toContainEqual(expect.objectContaining({ folderId: 'synthetic-folder-empty', path: 'Moved folder' }));
  });

  it('restores a trashed folder with its children only when revision and tombstone still match', async() => {
    const folder = (await source.load()).trash!.find(item => item.id === 'synthetic-trash-folder')!;

    await expect(source.restoreTrashItem({ ...folder, revision: '999' } as FilesTrashItem)).rejects.toMatchObject({ code: 'trash-state-conflict', message: 'Synthetic restore was blocked because the folder revision or current receipt changed.' });
    expect(await source.restoreTrashItem(folder)).toMatchObject({ status: 'restored', kind: 'folder', id: 'synthetic-trash-folder', receiptId: 'receipt-trash-folder' });
    const snapshot = await source.load();

    expect(snapshot.files.find(file => file.id === 'synthetic-trash-nested-child')?.deletedAt).toBeUndefined();
    expect(snapshot.trash?.some(item => item.id === 'synthetic-trash-folder')).toBe(false);
  });

  it('reports recovery-required purges and refuses to purge twice', async() => {
    const item = (await source.load()).trash!.find(candidate => candidate.id === 'synthetic-trash-recovery')!;

    expect(await source.purgeTrashItem(item)).toMatchObject({ status: 'recovery-required', metadataPurged: true, retainedArtifacts: 'preserved' });
    await expect(source.purgeTrashItem(item)).rejects.toMatchObject({ code: 'trash-state-conflict' });
  });
});
