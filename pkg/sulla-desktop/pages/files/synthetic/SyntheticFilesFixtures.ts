// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { SyntheticCollection, SyntheticFile, SyntheticFolder, SyntheticState } from './SyntheticFilesTypes';
import type { FileShare, FilesTrashTombstone, ShareLink } from '../types';

/** Builds the deterministic preview fixtures: collections, trash receipts and share rows. */
export class SyntheticFilesFixtures {
  constructor(private readonly now = Date.now()) {}

  /** ISO time `days` from when the fixtures were created (negative is the past). */
  iso(days = 0):string { return new Date(this.now + days * 86_400_000).toISOString() }

  initialState():SyntheticState {
    const primary:SyntheticCollection = {
      id: 'synthetic-collection', name: 'Files', home: 'preview', systemArea: null,
      files: [
        this.file('synthetic-video', 'Projects/Alpha/demo-recording.mp4', 'video/mp4', 184_000_000, 'version-video', '1'),
        this.file('synthetic-notes', 'Projects/Alpha/meeting-notes.md', 'text/markdown', 12_400, 'version-notes', '2'),
        this.file('synthetic-image', 'Projects/Beta/architecture.png', 'image/png', 2_400_000, 'version-image', '3'),
        this.file('synthetic-data', 'Projects/Beta/sample-data.json', 'application/json', 8_800, 'version-data', '4'),
        this.file('synthetic-readme', 'Readme.md', 'text/markdown', 2_100, 'version-readme', '5'),
        this.file('synthetic-collision', 'Projects/Beta/meeting-notes.md', 'text/markdown', 9_600, 'version-collision', '6'),
        this.file('synthetic-replace-source-file', 'Projects/Alpha/Replace demo/incoming.md', 'text/markdown', 6_200, 'version-replace-source', '21'),
        this.file('synthetic-replace-destination-file', 'Projects/Beta/Replace demo/preserved.md', 'text/markdown', 7_100, 'version-replace-destination', '24'),
        this.file('synthetic-stale-source-file', 'Projects/Alpha/Stale subtree/incoming.txt', 'text/plain', 800, 'version-stale-source', '27'),
        this.file('synthetic-stale-destination-file', 'Projects/Beta/Stale subtree/existing.txt', 'text/plain', 900, 'version-stale-destination', '30'),
        this.trashedFile('synthetic-trash-file', 'Archive/old-draft.md', 'text/markdown', 4_200, 'version-trash-file', '15', 'receipt-trash-file'),
        this.trashedFile('synthetic-trash-recovery', 'Archive/recovery-required.zip', 'application/zip', 48_000, 'version-trash-recovery', '16', 'receipt-trash-recovery', 'recovery-required'),
        this.trashedFile('synthetic-trash-child', 'Discarded project/notes.txt', 'text/plain', 1_900, 'version-trash-child', '18', 'receipt-trash-child', undefined, true, 'receipt-trash-folder'),
        this.trashedFile('synthetic-trash-nested-child', 'Discarded project/Research/results.json', 'application/json', 7_700, 'version-trash-nested-child', '19', 'receipt-trash-nested-child', undefined, true, 'receipt-trash-folder'),
      ],
      folders: [
        { folderId: 'synthetic-folder-projects', path: 'Projects', revision: '7' },
        { folderId: 'synthetic-folder-alpha', path: 'Projects/Alpha', revision: '8' },
        { folderId: 'synthetic-folder-beta', path: 'Projects/Beta', revision: '9' },
        { folderId: 'synthetic-folder-empty', path: 'Projects/Empty folder', revision: '10' },
        { folderId: 'synthetic-folder-replace-source', path: 'Projects/Alpha/Replace demo', revision: '21' },
        { folderId: 'synthetic-folder-replace-source-nested', path: 'Projects/Alpha/Replace demo/Nested', revision: '22' },
        { folderId: 'synthetic-folder-replace-destination', path: 'Projects/Beta/Replace demo', revision: '23' },
        { folderId: 'synthetic-folder-replace-destination-empty', path: 'Projects/Beta/Replace demo/Preserved empty', revision: '25' },
        { folderId: 'synthetic-folder-stale-source', path: 'Projects/Alpha/Stale subtree', revision: '26' },
        { folderId: 'synthetic-folder-stale-destination', path: 'Projects/Beta/Stale subtree', revision: '29' },
        this.trashedFolder('synthetic-trash-folder', 'Discarded project', '17', 'receipt-trash-folder', true),
        this.trashedFolder('synthetic-trash-child-folder', 'Discarded project/Research', '20', 'receipt-trash-folder', false),
      ],
    };
    const stored:SyntheticCollection = {
      id: 'synthetic-stored-collection', name: 'Stored review', home: 'stored-preview', systemArea: null,
      files: [
        this.file('synthetic-stored-brief', 'Review/product-brief.md', 'text/markdown', 18_200, 'version-stored-brief', '11'),
        this.file('synthetic-stored-readme', 'Readme.md', 'text/markdown', 3_400, 'version-stored-readme', '12'),
        this.file('synthetic-stored-replace-file', 'Projects/Alpha/Replace demo/stored-preserved.md', 'text/markdown', 4_800, 'version-stored-replace', '31'),
        this.file('synthetic-stored-stale-file', 'Projects/Alpha/Stale subtree/stored-existing.txt', 'text/plain', 720, 'version-stored-stale', '36'),
      ],
      folders: [
        { folderId: 'synthetic-stored-review', path: 'Review', revision: '13' },
        { folderId: 'synthetic-stored-empty', path: 'Archive', revision: '14' },
        { folderId: 'synthetic-stored-projects', path: 'Projects', revision: '32' },
        { folderId: 'synthetic-stored-alpha', path: 'Projects/Alpha', revision: '33' },
        { folderId: 'synthetic-stored-replace', path: 'Projects/Alpha/Replace demo', revision: '34' },
        { folderId: 'synthetic-stored-replace-empty', path: 'Projects/Alpha/Replace demo/Preserved empty', revision: '35' },
        { folderId: 'synthetic-stored-stale', path: 'Projects/Alpha/Stale subtree', revision: '37' },
      ],
    };

    const sulla:SyntheticCollection = { id: 'synthetic-sulla', name: 'Sulla', home: 'sulla', systemArea: 'sulla', files: [], folders: [] };

    return {
      revision: 37, sequence: 0, selectedCollectionId: primary.id, collections: [primary, stored, sulla], operations: {}, idempotency: {},
      folderReceipts: {
        'receipt-trash-folder': {
          collectionId: primary.id, rootFolderId: 'synthetic-trash-folder', rootPath: 'Discarded project',
          files: [
            { id: 'synthetic-trash-child', path: 'Discarded project/notes.txt', revision: '18', receiptId: 'receipt-trash-child' },
            { id: 'synthetic-trash-nested-child', path: 'Discarded project/Research/results.json', revision: '19', receiptId: 'receipt-trash-nested-child' },
          ],
          folders: [
            { id: 'synthetic-trash-folder', path: 'Discarded project', revision: '17' },
            { id: 'synthetic-trash-child-folder', path: 'Discarded project/Research', revision: '20' },
          ],
        },
      },
      stars: {}, folderShares: [], staleReplaceAdvanced: false,
    };
  }
  private file(id:string, path:string, mime:string, size:number, currentVersionId:string, operationRevision:string):SyntheticFile {
    return { id, path, mime, size, updatedAt: this.iso(), currentVersionId, operationRevision, versionCount: 1, createdByType: 'user', createdById: 'synthetic-user', ownerDisplayName: 'Preview user', syncState: 'synced', indexStatus: 'indexed', indexReasonCode: 'synthetic_fixture', indexReason: 'Synthetic preview fixture.', indexedAt: this.iso() };
  }
  private trashedFile(id:string, path:string, mime:string, size:number, currentVersionId:string, revision:string, receiptId:string, purgeOutcome?:'recovery-required', listed = true, parentReceiptId?:string):SyntheticFile {
    const deletedAt = this.iso(-2); const tombstone:FilesTrashTombstone = { kind: 'version', id: currentVersionId, receiptId, operationId: receiptId, undo: { state: purgeOutcome ?? 'available', expiresAt: this.iso(28) } };

    return { ...this.file(id, path, mime, size, currentVersionId, revision), deletedAt, updatedAt: deletedAt, disposal: { status: 'approved' }, syntheticTrash: { listed, revision, tombstone, ...(parentReceiptId ? { parentReceiptId } : {}), ...(purgeOutcome ? { purgeOutcome } : {}) } };
  }
  private trashedFolder(folderId:string, path:string, revision:string, receiptId:string, listed:boolean):SyntheticFolder {
    const deletedAt = this.iso(-2); const tombstone:FilesTrashTombstone = { kind: 'receipt', id: receiptId, receiptId, operationId: receiptId, undo: { state: 'available', expiresAt: this.iso(28) } };

    return { folderId, path, revision, deletedAt, syntheticTrash: { listed, revision, tombstone, parentReceiptId: receiptId } };
  }
  shareLinks():ShareLink[] {
    return [
      { id: 'share-capture', url: 'https://share.sulla.cloud/v/m3Xp9A', name: 'Screenshot 2026-10-16 at 11.17.02.png', mode: 'view', password: false, expiresAt: this.iso(30), viewCount: 0, keepAvailable: true, keepUntil: this.iso(30), displaySharerName: true, servedFrom: 'cloud', assetKind: 'capture', source: 'Copy on Sulla Cloud', createdAt: this.iso(-1) },
      { id: 'share-artifact', url: 'https://share.sulla.cloud/v/Tq8mWe', name: '03-share.html · Share dialog', mode: 'view', password: false, expiresAt: this.iso(13), viewCount: 7, lastViewedAt: this.iso(-1), keepAvailable: true, keepUntil: this.iso(2), displaySharerName: true, servedFrom: 'cloud', assetKind: 'artifact', source: 'Sulla-made › mockups', targetId: 'synthetic-file', createdAt: this.iso(-3) },
      { id: 'share-file', url: 'https://share.sulla.cloud/v/8kQ2vT', name: 'Vault phase 2 walkthrough.mp4', mode: 'view', password: true, expiresAt: this.iso(13), viewCount: 14, lastViewedAt: this.iso(-2), keepAvailable: false, displaySharerName: true, servedFrom: 'desktop', assetKind: 'file', source: 'This Mac · live', targetId: 'synthetic-file', targetType: 'file', collectionId: 'synthetic-collection', createdAt: this.iso(-8) },
      { id: 'share-revoked', url: 'https://share.sulla.cloud/v/Jd9xCp', name: 'Route settlement · week 41', mode: 'view', password: false, viewCount: 12, keepAvailable: false, displaySharerName: true, servedFrom: 'desktop', assetKind: 'artifact', source: 'This Mac', revokedAt: this.iso(-2), createdAt: this.iso(-12) },
    ];
  }
  fileShares():FileShare[] {
    return [{ id: 'file-share-design', fileId: 'synthetic-video', principalType: 'group', principalId: 'design', principalName: 'Design', role: 'view' }];
  }
}
