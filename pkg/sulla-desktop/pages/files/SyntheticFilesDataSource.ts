// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type {
  FileAccessList, FilesCapabilities, FilesCollisionDestination, FilesDataSource, FilesDetail, FilesFolderReplacementDestination,
  FilesFolderSourceSnapshot, FilesFolderState, FilesItem, FilesOperationCapabilities, FilesOperationItem,
  FilesOperationItemReceipt, FilesOperationReceipt, FilesOperationRequest, FilesOperationRetry,
  FilesOperationState, FilesPreview, FilesSaveRequest, FilesSaveSuccess, FilesSnapshot, FilesTrashItem, FilesTrashPurgeResult,
  FilesTrashRestoreResult, FilesTrashTombstone, FilesVersion, FileShare, FolderShare,
  ShareActivity, ShareLink, ShareLinkOptions, SharePrincipalType,
} from './types';
import { isFilesFolderReplacementDestination, isFilesOperationState } from './types';

/* eslint-disable @typescript-eslint/require-await -- the preview adapter intentionally implements the async production datasource contract in memory */

const now = Date.now();
const iso = (days = 0) => new Date(now + days * 86_400_000).toISOString();
// Synthetic operation state is deliberately scoped to this browser session.
const STORAGE_KEY = 'sulla:files:synthetic-receipt-preview:v4';
const clone = <T>(value:T):T => JSON.parse(JSON.stringify(value)) as T;
const canonical = (value:unknown):string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, (item as Record<string, unknown>)[key]])) : item);
const SHA256_CONSTANTS = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];
const rotateRight = (value:number, bits:number) => value >>> bits | value << (32 - bits);
const sha256 = (value:string) => {
  const input = new TextEncoder().encode(value); const paddedLength = Math.ceil((input.length + 9) / 64) * 64; const bytes = new Uint8Array(paddedLength);

  bytes.set(input); bytes[input.length] = 0x80;
  new DataView(bytes.buffer).setUint32(paddedLength - 4, input.length * 8, false);
  const hash = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const words = new Uint32Array(64); const view = new DataView(bytes.buffer);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index++) words[index] = view.getUint32(offset + index * 4, false);
    for (let index = 16; index < 64; index++) {
      const left = words[index - 15]; const right = words[index - 2];
      const first = rotateRight(left, 7) ^ rotateRight(left, 18) ^ left >>> 3; const second = rotateRight(right, 17) ^ rotateRight(right, 19) ^ right >>> 10;

      words[index] = (words[index - 16] + first + words[index - 7] + second) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash;

    for (let index = 0; index < 64; index++) {
      const choice = e & f ^ ~e & g; const majority = a & b ^ a & c ^ b & c;
      const first = (h + (rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25)) + choice + SHA256_CONSTANTS[index] + words[index]) >>> 0;
      const second = ((rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22)) + majority) >>> 0;

      [a, b, c, d, e, f, g, h] = [(first + second) >>> 0, a, b, c, (d + first) >>> 0, e, f, g];
    }
    [a, b, c, d, e, f, g, h].forEach((word, index) => { hash[index] = (hash[index] + word) >>> 0 });
  }
  return [...hash].map(word => word.toString(16).padStart(8, '0')).join('');
};

interface SyntheticTrashState {
  listed:boolean;
  revision:string;
  tombstone:FilesTrashTombstone;
  parentReceiptId?:string;
  purgeOutcome?:'recovery-required';
}
interface SyntheticFile extends FilesItem { syntheticTrash?:SyntheticTrashState }
interface SyntheticFolder extends FilesFolderState { deletedAt?:string; syntheticTrash?:SyntheticTrashState }
interface SyntheticCollection { id:string; name:string; home:string; systemArea:'logs' | 'sulla' | null; files:SyntheticFile[]; folders:SyntheticFolder[]; cloudCatalogSync?:boolean }
interface SyntheticMutation {
  before:SyntheticCollection[];
  after:SyntheticCollection[];
  beforeFolderShares:FolderShare[];
  afterFolderShares:FolderShare[];
  fileIds:string[];
  folderIds:string[];
  folderShareIds:string[];
}
interface SyntheticOperation {
  request:FilesOperationRequest;
  fingerprint:string;
  receipt:FilesOperationReceipt;
  mutations:Record<string, SyntheticMutation>;
  retryOverrides:Record<string, NonNullable<FilesOperationRetry['items']>[number]>;
}
interface SyntheticFolderReceiptPlan {
  collectionId:string;
  rootFolderId:string;
  rootPath:string;
  files:{ id:string; path:string; revision:string; receiptId:string }[];
  folders:{ id:string; path:string; revision:string }[];
}
interface SyntheticState {
  revision:number;
  sequence:number;
  selectedCollectionId:string;
  collections:SyntheticCollection[];
  operations:Record<string, SyntheticOperation>;
  idempotency:Record<string, { fingerprint:string; operationId:string }>;
  folderReceipts:Record<string, SyntheticFolderReceiptPlan>;
  stars:Record<string, string[]>;
  folderShares:FolderShare[];
  staleReplaceAdvanced:boolean;
}

/** Stateful synthetic fixtures for /files-preview. Never reads Files IPC or private files. */
export class SyntheticFilesDataSource implements FilesDataSource {
  readonly syntheticPreview = true;
  readonly syntheticPersistenceScope = 'session' as const;
  capabilities:FilesCapabilities = {
    upload: false, versionHistory: true, restoreVersions: true, trash: true, orgSharing: true,
    publicLinks: true, onlineOnly: false, nativeFilesystem: false, durableOperations: true,
    folderReceipts: true, nativeFolderReceipts: false,
    folderCollisionPolicies: ['replace', 'keep-both', 'skip'] as ('replace' | 'keep-both' | 'skip')[],
    crossCollectionOperations: 'all-authorized',
  };
  onlineOnlyReason = 'Synthetic preview';
  private paused = false;
  private state:SyntheticState;
  private get folderShares() { return this.state.folderShares }
  private set folderShares(value:FolderShare[]) { this.state.folderShares = value }
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private contents=new Map<string,string>();
  private shares:ShareLink[] = [
    { id: 'share-capture', url: 'https://share.sulla.cloud/v/m3Xp9A', name: 'Screenshot 2026-10-16 at 11.17.02.png', mode: 'view', password: false, expiresAt: iso(30), viewCount: 0, keepAvailable: true, keepUntil: iso(30), displaySharerName: true, servedFrom: 'cloud', assetKind: 'capture', source: 'Copy on Sulla Cloud', createdAt: iso(-1) },
    { id: 'share-artifact', url: 'https://share.sulla.cloud/v/Tq8mWe', name: '03-share.html · Share dialog', mode: 'view', password: false, expiresAt: iso(13), viewCount: 7, lastViewedAt: iso(-1), keepAvailable: true, keepUntil: iso(2), displaySharerName: true, servedFrom: 'cloud', assetKind: 'artifact', source: 'Sulla-made › mockups', targetId: 'synthetic-file', createdAt: iso(-3) },
    { id: 'share-file', url: 'https://share.sulla.cloud/v/8kQ2vT', name: 'Vault phase 2 walkthrough.mp4', mode: 'view', password: true, expiresAt: iso(13), viewCount: 14, lastViewedAt: iso(-2), keepAvailable: false, displaySharerName: true, servedFrom: 'desktop', assetKind: 'file', source: 'This Mac · live', targetId: 'synthetic-file', targetType: 'file', collectionId: 'synthetic-collection', createdAt: iso(-8) },
    { id: 'share-revoked', url: 'https://share.sulla.cloud/v/Jd9xCp', name: 'Route settlement · week 41', mode: 'view', password: false, viewCount: 12, keepAvailable: false, displaySharerName: true, servedFrom: 'desktop', assetKind: 'artifact', source: 'This Mac', revokedAt: iso(-2), createdAt: iso(-12) },
  ];
  private fileShares:FileShare[] = [{ id: 'file-share-design', fileId: 'synthetic-video', principalType: 'group', principalId: 'design', principalName: 'Design', role: 'view' }];

  constructor() {
    this.state = this.restoreState() ?? this.initialState();
    this.capabilities.crossCollectionOperations = this.state.selectedCollectionId === 'synthetic-collection' ? 'all-authorized' : 'stored-authorized';
    Object.values(this.state.operations).filter(value => value.receipt.state === 'pending').forEach(value => this.schedule(value.receipt.operationId));
  }

  private initialState():SyntheticState {
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

    const sulla:SyntheticCollection = { id: 'synthetic-sulla', name: 'Sulla', home: 'sulla', systemArea: 'sulla', files: [this.file('synthetic-sulla-readme', 'Docs/README.md', 'text/markdown', 1200, 'version-sulla-readme', '38')], folders: [{ folderId: 'synthetic-sulla-docs', path: 'Docs', revision: '39' }] };

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

  private restoreState():SyntheticState | null {
    try {
      const raw = typeof sessionStorage === 'undefined' ? null : sessionStorage.getItem(STORAGE_KEY);
      const value = raw ? JSON.parse(raw) as SyntheticState : null;

      return value?.collections?.some(item => item.id === value.selectedCollectionId) && value.operations && value.idempotency && value.folderReceipts && Array.isArray(value.folderShares) && typeof value.staleReplaceAdvanced === 'boolean' ? value : null;
    } catch { return null }
  }
  private persist() {
    try { if (typeof sessionStorage !== 'undefined') sessionStorage.setItem(STORAGE_KEY, JSON.stringify(this.state)) }
    catch { /* In-memory behavior remains available if session storage is unavailable. */ }
  }
  private file(id:string, path:string, mime:string, size:number, currentVersionId:string, operationRevision:string):SyntheticFile {
    return { id, path, mime, size, updatedAt: iso(), currentVersionId, operationRevision, versionCount: 1, createdByType: 'user', createdById: 'synthetic-user', ownerDisplayName: 'Preview user', syncState: 'synced', indexStatus: 'indexed', indexReasonCode: 'synthetic_fixture', indexReason: 'Synthetic preview fixture.', indexedAt: iso() };
  }
  private trashedFile(id:string, path:string, mime:string, size:number, currentVersionId:string, revision:string, receiptId:string, purgeOutcome?:'recovery-required', listed = true, parentReceiptId?:string):SyntheticFile {
    const deletedAt = iso(-2); const tombstone:FilesTrashTombstone = { kind: 'version', id: currentVersionId, receiptId, operationId: receiptId, undo: { state: purgeOutcome ?? 'available', expiresAt: iso(28) } };

    return { ...this.file(id, path, mime, size, currentVersionId, revision), deletedAt, updatedAt: deletedAt, disposal: { status: 'approved' }, syntheticTrash: { listed, revision, tombstone, ...(parentReceiptId ? { parentReceiptId } : {}), ...(purgeOutcome ? { purgeOutcome } : {}) } };
  }
  private trashedFolder(folderId:string, path:string, revision:string, receiptId:string, listed:boolean):SyntheticFolder {
    const deletedAt = iso(-2); const tombstone:FilesTrashTombstone = { kind: 'receipt', id: receiptId, receiptId, operationId: receiptId, undo: { state: 'available', expiresAt: iso(28) } };

    return { folderId, path, revision, deletedAt, syntheticTrash: { listed, revision, tombstone, parentReceiptId: receiptId } };
  }
  private collection(id:string) {
    const result = this.state.collections.find(item => item.id === id);

    if (!result) throw new Error('Synthetic collection is no longer available');
    return result;
  }
  private currentCollection() { return this.collection(this.state.selectedCollectionId) }
  private nextRevision() { return String(++this.state.revision) }
  private nextId(prefix:string) { return prefix + '-' + (++this.state.sequence) + '-' + crypto.randomUUID() }
  private normalizePath(path:string) {
    const value = path.replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/');

    if (!value || value.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Synthetic operation path is invalid');
    return value;
  }
  private fileState(file:FilesItem, collectionId:string):FilesOperationState {
    return { collectionId, fileId: file.id, path: file.path, versionId: file.currentVersionId, revision: file.operationRevision ?? '0', deleted: Boolean(file.deletedAt) };
  }
  private sameFileState(a?:FilesCollisionDestination, b?:FilesCollisionDestination) {
    return isFilesOperationState(a) && isFilesOperationState(b) && a.collectionId === b.collectionId && a.fileId === b.fileId && a.path === b.path && a.versionId === b.versionId && a.revision === b.revision && a.deleted === b.deleted;
  }
  private folderState(folder:FilesFolderState, collectionId:string):FilesFolderState {
    return { collectionId, folderId: folder.folderId, path: folder.path, revision: folder.revision, description:folder.description, namingHint:folder.namingHint, needsDescription:folder.needsDescription };
  }
  private sameFolderState(a?:FilesFolderState, b?:FilesFolderState) {
    return Boolean(a && b && a.collectionId === b.collectionId && a.folderId === b.folderId && a.path === b.path && a.revision === b.revision);
  }
  private sameFolderReplacementDestination(a?:FilesCollisionDestination, b?:FilesCollisionDestination) {
    return isFilesFolderReplacementDestination(a) && isFilesFolderReplacementDestination(b) && this.sameFolderState(a, b) && a.subtreeSignature === b.subtreeSignature;
  }
  private folderSourceSnapshot(collection:SyntheticCollection, path:string):FilesFolderSourceSnapshot {
    const root = this.activeFolderAt(collection, path);
    const files = collection.files.filter(file => !file.deletedAt && file.path.startsWith(path + '/')).sort((a, b) => a.path.localeCompare(b.path));
    const folders = collection.folders.filter(folder => !folder.deletedAt && (folder.path === path || folder.path.startsWith(path + '/'))).sort((a, b) => a.path.localeCompare(b.path));
    const fileIds = new Set(files.map(file => file.id));
    const folderShares = this.folderShares.filter(share => share.collectionId === collection.id && (share.folderPath === path || share.folderPath.startsWith(path + '/'))).map(share => clone(share)).sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const fileShares = this.fileShares.filter(share => fileIds.has(share.fileId)).map(share => clone(share)).sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const subtreeSignature = sha256(canonical({
      files: files.map(file => ({ id: file.id, path: file.path, versionId: file.currentVersionId, revision: file.operationRevision ?? '0', deleted: false })),
      folders: folders.map(folder => this.folderState(folder, collection.id)),
      folderShares,
      publicLinks: [],
      fileSharesSignature: sha256(canonical(fileShares)),
      fileLinksSignature: sha256(canonical([])),
      nativeSignature: sha256(canonical({ files: [], directories: [] })),
    }));

    return { collectionId: collection.id, path, ...(root ? { folderId: root.folderId, revision: root.revision } : {}), subtreeSignature };
  }
  private folderReplacementDestination(collection:SyntheticCollection, path:string):FilesFolderReplacementDestination | undefined {
    const snapshot = this.folderSourceSnapshot(collection, path);

    return snapshot.folderId && snapshot.revision ? { collectionId: snapshot.collectionId, folderId: snapshot.folderId, path: snapshot.path, revision: snapshot.revision, subtreeSignature: snapshot.subtreeSignature } : undefined;
  }
  private activeFileAt(collection:SyntheticCollection, path:string, ignored = new Set<string>()) { return collection.files.find(file => !file.deletedAt && file.path === path && !ignored.has(file.id)) }
  private activeFolderAt(collection:SyntheticCollection, path:string, ignored = new Set<string>()) { return collection.folders.find(folder => !folder.deletedAt && folder.path === path && !ignored.has(folder.folderId)) }
  private keepBothPath(collection:SyntheticCollection, requested:string, ignoredFiles = new Set<string>(), ignoredFolders = new Set<string>()) {
    const slash = requested.lastIndexOf('/'); const parent = slash < 0 ? '' : requested.slice(0, slash); const name = slash < 0 ? requested : requested.slice(slash + 1); const dot = name.lastIndexOf('.'); const stem = dot > 0 ? name.slice(0, dot) : name; const extension = dot > 0 ? name.slice(dot) : '';

    for (let number = 1; number < 1_000; number++) {
      const suffix = number === 1 ? ' copy' : ' copy ' + number; const candidate = [parent, stem + suffix + extension].filter(Boolean).join('/');

      if (!this.activeFileAt(collection, candidate, ignoredFiles) && !this.activeFolderAt(collection, candidate, ignoredFolders)) return candidate;
    }
    throw new Error('Synthetic Keep Both could not reserve a destination');
  }

  async load():Promise<FilesSnapshot> {
    const collection = this.currentCollection(); const active = collection.files.filter(file => !file.deletedAt); const indexed = active.filter(file => file.indexStatus === 'indexed').length;

    return {
      collection: { id: collection.id, name: collection.name, home: collection.home, systemArea: collection.systemArea, orgId: 'synthetic-org', retentionPolicy: {}, storageQuota: 10_000_000_000, keptBytes: active.reduce((sum, file) => sum + file.size, 0), desktopCount: 0, memberCount: 2, accountName: 'Preview user', accountRole: 'owner', ownerUserId: 'synthetic-user', cloudCatalogSync: Boolean(collection.cloudCatalogSync) },
      availableCollections: this.state.collections.map(item => ({ id: item.id, name: item.name, systemArea: item.systemArea })),
      folders: collection.folders.filter(folder => !folder.deletedAt).map(folder => this.folderState(folder, collection.id)),
      files: collection.files.map(({ syntheticTrash: _syntheticTrash, ...file }) => ({ ...file })),
      trash: [
        ...collection.files.filter(file => file.deletedAt && file.syntheticTrash?.listed).map(file => {
          const { syntheticTrash, ...item } = file;

          return { ...item, kind: 'file' as const, revision: syntheticTrash!.revision, currentTombstone: clone(syntheticTrash!.tombstone) as Extract<FilesTrashTombstone, { kind:'version' }> };
        }),
        ...collection.folders.filter(folder => folder.deletedAt && folder.syntheticTrash?.listed).map(folder => ({
          kind: 'folder' as const, id: folder.folderId, path: folder.path, revision: folder.syntheticTrash!.revision,
          deletedAt: folder.deletedAt!, currentTombstone: clone(folder.syntheticTrash!.tombstone) as Extract<FilesTrashTombstone, { kind:'receipt' }>,
          capabilities: { canEdit: true, canManage: true, canViewDraft: true, canPublish: true },
        })),
      ],
      status: { state: this.paused ? 'paused' : 'synced', pendingFiles: 0, lastSyncAt: iso(), serverConfigured: true, location: 'server', serverLabel: 'Synthetic stored preview', indexing: { total: active.length, pending: 0, indexing: 0, indexed, partial: 0, unsupported: 0, failed: 0, complete: indexed === active.length } },
    };
  }
  selectCollection(collectionId:string) {
    this.collection(collectionId); this.state.selectedCollectionId = collectionId;
    this.capabilities.crossCollectionOperations = collectionId === 'synthetic-collection' ? 'all-authorized' : 'stored-authorized';
    this.persist();
  }
  async operationCapabilities(collectionId:string):Promise<FilesOperationCapabilities> {
    const available = this.state.collections.some(collection => collection.id === collectionId);

    return {
      enabled: available,
      ...(!available ? { reason: 'synthetic-collection-unavailable' } : {}),
      folderReceipts: available,
      nativeFolderReceipts: false,
      folderCollisionPolicies: available ? ['replace', 'keep-both', 'skip'] : [],
      crossCollectionOperations: !available ? 'unavailable' : collectionId === 'synthetic-collection' ? 'all-authorized' : 'stored-authorized',
    };
  }
  async folderOperationState(collectionId:string, path:string):Promise<FilesFolderSourceSnapshot> {
    const collection = this.collection(collectionId); const normalized = this.normalizePath(path);
    const exists = Boolean(this.activeFolderAt(collection, normalized) || collection.files.some(file => !file.deletedAt && file.path.startsWith(normalized + '/')) || collection.folders.some(folder => !folder.deletedAt && folder.path.startsWith(normalized + '/')));

    if (!exists) throw new Error('Synthetic folder was not found');
    return clone(this.folderSourceSnapshot(collection, normalized));
  }
  async history(fileId:string, currentVersionId:string):Promise<FilesVersion[]> { return Array.from({ length: 7 }, (_, index) => ({ id: index === 0 ? currentVersionId : fileId + '-version-' + (7 - index), size: 184_000_000 + index * 300_000, deleted: false, created_by_type: index ? 'user' : 'agent-run', created_by_id: index ? 'Jonathon' : 'heartbeat run #4,112', created_at: iso(-index / 24), message: index ? ['Trimmed last 12 seconds', 'Camera bubble moved to corner', 'Uploaded from tray'][index - 1] || 'Recording updated' : 'Transcript added', device_id: index ? 'Mac Studio' : 'heartbeat run #4,112', current: index === 0 })) }
  async preview(fileId:string):Promise<FilesPreview> { const file=this.state.collections.flatMap(item=>item.files).find(item=>item.id===fileId);if(!file)throw new Error('Synthetic file not found.');let content=this.contents.get(fileId);if(content===undefined){content=file.mime==='text/markdown'?'---\nstatus: Draft\nowner: Preview user\n---\n\n# '+file.path.split('/').at(-1)+'\n\nSynthetic Markdown stays editable as exact source.\n\n- [ ] Try the document editor\n':'Synthetic text preview for '+file.path+'\n';this.contents.set(fileId,content)}return { data:new TextEncoder().encode(content),mime:file.mime,path:file.path } }
  async saveContent(request:FilesSaveRequest):Promise<FilesSaveSuccess> { const file=this.state.collections.flatMap(item=>item.files).find(item=>item.id===request.fileId);if(!file)throw new Error('Synthetic file not found.');if(request.baseVersionId!==file.currentVersionId)throw Object.assign(new Error('Synthetic document changed.'),{status:409,code:'VERSION_CONFLICT',currentVersionId:file.currentVersionId});this.contents.set(file.id,request.content);file.currentVersionId=this.nextId('version');file.versionCount+=1;file.updatedAt=new Date().toISOString();this.persist();return{status:'saved',fileId:file.id,path:file.path,mime:file.mime,content:request.content,versionId:file.currentVersionId} }
  async detail(fileId = 'synthetic-video'):Promise<FilesDetail> { const file = this.state.collections.flatMap(item => item.files).find(item => item.id === fileId) ?? this.currentCollection().files[0]; return { item: file, capabilities: { canEdit: true, canManage: true, canViewDraft: true, canPublish: true }, provenance: { type: 'synthetic-preview', id: 'fixture' }, version: (await this.history(file.id, file.currentVersionId))[0], recording: file.mime.startsWith('video/') ? { version_id: file.currentVersionId, language: 'en', generator: 'synthetic fixture', duration_seconds: 42, generated_at: iso(), transcript: [{ start: 0, end: 8, text: 'Synthetic Files preview fixture.' }], chapters: [{ start: 0, end: 42, title: 'Preview fixture' }] } : undefined, links: [], activity: [], access: { role: 'owner', inherited: [] } } }
  async mediaUrl(fileId:string):Promise<string> { const file = this.state.collections.flatMap(item => item.files).find(item => item.id === fileId); if (file?.mime !== 'image/png') return ''; const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="700"><rect width="1200" height="700" fill="#152536"/><path d="M130 520 390 280l150 140 150-190 380 290H130Z" fill="#5096b3"/><circle cx="900" cy="220" r="72" fill="#a5d8e8"/></svg>'; return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg) }
  async search(query:string) { const files = (await this.load()).files.filter(file => !file.deletedAt && file.path.toLowerCase().includes(query.toLowerCase())); return { files, coverage: { total: files.length, pending: 0, indexing: 0, indexed: files.length, partial: 0, unsupported: 0, failed: 0, complete: true } } }
  async reindex() {}
  async setPaused(paused:boolean) { this.paused = paused; return (await this.load()).status }
  async chooseUpload(_destination = '') { return 0 }
  async uploadPaths(_paths:string[], _destination = '') { return 0 }
  async createFolder(path:string) { const collection = this.currentCollection(); const value = this.normalizePath(path); if (!this.activeFileAt(collection, value) && !this.activeFolderAt(collection, value)) collection.folders.push({ folderId: this.nextId('synthetic-folder'), path: value, revision: this.nextRevision() }); this.persist() }
  async updateFolderDescription(folderId:string,description:string,namingHint?:string) { const folder=this.currentCollection().folders.find(item=>item.folderId===folderId); if(folder){folder.description=description;folder.namingHint=namingHint;folder.needsDescription=false;folder.revision=this.nextRevision();this.persist()} }
  async setCollectionCloudSync(collectionId:string,enabled:boolean) { const collection=this.state.collections.find(item=>item.id===collectionId); if(collection){collection.cloudCatalogSync=enabled;this.persist()} }
  async openFolder() {}
  async openFile() {}
  async downloadFile() { return false }
  async downloadFiles() { return { count: 0, error: 'Downloads are unavailable in the synthetic preview.' } }
  async listStars(collectionId:string) { return (this.state.stars[collectionId] ?? []).map(key => key.startsWith('folder:') ? { folderPath: key.slice(7) } : { fileId: key }) }
  async setStar(collectionId:string, target:{ fileId?:string; folderPath?:string }, starred:boolean) { const key = target.fileId ?? 'folder:' + target.folderPath; const stars = new Set(this.state.stars[collectionId] ?? []); starred ? stars.add(key) : stars.delete(key); this.state.stars[collectionId] = [...stars]; this.persist() }

  async operate(action:'move' | 'copy', collectionId:string, items:{ fileId?:string; folderPath?:string; targetPath:string }[]) {
    const collection = this.collection(collectionId);
    let receipt = await this.submitOperation({ idempotencyKey: crypto.randomUUID(), collectionId, items: items.map(item => {
      const file = item.fileId ? collection.files.find(candidate => candidate.id === item.fileId) : undefined;
      const folder = item.folderPath ? collection.folders.find(candidate => candidate.path === item.folderPath && !candidate.deletedAt) : undefined;

      return { itemId: crypto.randomUUID(), action, kind: item.folderPath ? 'folder' : 'file', ...item, ...(file ? { expectedVersionId: file.currentVersionId, expectedRevision: file.operationRevision } : {}), ...(folder ? { expectedFolder: this.folderState(folder, collection.id), sourceSubtreeSignature: this.folderSourceSnapshot(collection, folder.path).subtreeSignature } : {}) };
    }) });

    while (receipt.state === 'pending') { await new Promise(resolve => setTimeout(resolve, 25)); receipt = await this.getOperation(receipt.operationId) }
    if (receipt.items.some(item => item.state === 'failed')) throw new Error(receipt.items.find(item => item.error)?.error?.message ?? 'Synthetic operation failed');
  }

  async submitOperation(request:FilesOperationRequest):Promise<FilesOperationReceipt> {
    const immutable = clone(request); const fingerprint = JSON.stringify(immutable); const known = this.state.idempotency[request.idempotencyKey];

    if (known) {
      if (known.fingerprint !== fingerprint) throw new Error('Idempotency key was already submitted with a different synthetic request');
      return this.getOperation(known.operationId);
    }
    if (!request.idempotencyKey || !request.collectionId || !request.items.length || request.items.length > 250 || new Set(request.items.map(item => item.itemId)).size !== request.items.length) throw new Error('Synthetic operation request is invalid');
    this.collection(request.collectionId);
    const createdAt = new Date().toISOString(); const operationId = crypto.randomUUID();
    const receipt:FilesOperationReceipt = {
      operationId, collectionId: request.collectionId, state: 'pending', cancelRequested: false, undoSupported: false, retryable: false, createdAt, updatedAt: createdAt,
      items: request.items.map(item => ({ itemId: item.itemId, action: item.action, state: 'pending', receiptId: null, before: null, after: null, error: null, undoSupported: false, retryable: false })),
    };

    this.state.operations[operationId] = { request: immutable, fingerprint, receipt, mutations: {}, retryOverrides: {} };
    this.state.idempotency[request.idempotencyKey] = { fingerprint, operationId };
    this.persist(); this.schedule(operationId);
    return clone(receipt);
  }
  async getOperation(operationId:string):Promise<FilesOperationReceipt> { return clone(this.operation(operationId).receipt) }
  async cancelOperation(operationId:string):Promise<FilesOperationReceipt> {
    const operation = this.operation(operationId);

    if (operation.receipt.state === 'pending') { operation.receipt.cancelRequested = true; operation.receipt.updatedAt = new Date().toISOString(); this.persist(); this.schedule(operationId, 0) }
    return clone(operation.receipt);
  }
  async retryOperation(operationId:string, retry:FilesOperationRetry = {}):Promise<FilesOperationReceipt> {
    const operation = this.operation(operationId); const ids = retry.items?.map(item => item.itemId) ?? operation.receipt.items.filter(item => item.state === 'failed' || item.state === 'cancelled').map(item => item.itemId);

    if (operation.receipt.state === 'pending') throw new Error('Wait for the synthetic operation to finish before retrying it');
    if (new Set(ids).size !== ids.length) throw new Error('A synthetic item can only be retried once per request');
    const validated = ids.map(id => {
      const receipt = operation.receipt.items.find(item => item.itemId === id); const override = retry.items?.find(item => item.itemId === id);

      if (!receipt || !receipt.retryable || !['failed', 'cancelled'].includes(receipt.state)) throw new Error('Only retryable failed or cancelled synthetic items can be retried');
      if (override?.collisionPolicy === 'replace') {
        const displayed = receipt.error?.destination; const expected = override.expectedDestination;
        const exact = this.sameFileState(displayed, expected) || this.sameFolderReplacementDestination(displayed, expected);

        if (!exact) throw new Error('Replace requires the exact displayed synthetic destination snapshot');
      }
      return { id, receipt, override };
    });

    for (const { id, receipt, override } of validated) {
      if (override) operation.retryOverrides[id] = clone(override);
      Object.assign(receipt, { state: 'pending', error: null, retryable: false });
    }
    operation.receipt.cancelRequested = false; this.refreshReceipt(operation); this.persist(); this.schedule(operationId);
    return clone(operation.receipt);
  }
  async undoOperation(operationId:string):Promise<FilesOperationReceipt> {
    const operation = this.operation(operationId);

    if (operation.receipt.state === 'pending') throw new Error('Wait for the synthetic operation to finish before undoing it');
    for (const item of [...operation.receipt.items].reverse().filter(value => value.state === 'completed')) {
      const mutation = operation.mutations[item.itemId];

      if (!mutation || !this.mutationMatches(mutation, 'after')) {
        item.error = { status: 409, code: 'state-conflict', message: 'Synthetic undo was blocked because the current revision, collection, or namespace ownership changed.' }; item.undoSupported = false;
        this.refreshReceipt(operation); this.persist();
        return clone(operation.receipt);
      }
      this.applyMutation(mutation, 'before'); item.state = 'undone'; item.error = null; item.undoSupported = false;
    }
    this.refreshReceipt(operation); this.persist();
    return clone(operation.receipt);
  }

  private operation(id:string) { const result = this.state.operations[id]; if (!result) throw new Error('Synthetic operation receipt was not found'); return result }
  private schedule(id:string, delay = 420) {
    if (this.timers.has(id)) return;
    this.timers.set(id, setTimeout(() => { this.timers.delete(id); this.advance(id) }, delay));
  }
  private advance(id:string) {
    const operation = this.state.operations[id];

    if (!operation || operation.receipt.state !== 'pending') return;
    const pending = operation.receipt.items.filter(item => item.state === 'pending');
    if (operation.receipt.cancelRequested) pending.forEach(item => Object.assign(item, { state: 'cancelled', error: { status: 409, code: 'operation-cancelled', message: 'Cancelled before this synthetic item started.' }, retryable: true }));
    else if (pending[0]) this.executeItem(operation, operation.request.items.find(item => item.itemId === pending[0].itemId)!, pending[0]);
    this.refreshReceipt(operation); this.persist();
    if (operation.receipt.state === 'pending') this.schedule(id);
  }
  private executeItem(operation:SyntheticOperation, item:FilesOperationItem, receipt:FilesOperationItemReceipt) {
    const before = clone(this.state.collections); const beforeFolderShares = clone(this.folderShares); const beforeFolderReceipts = clone(this.state.folderReceipts);
    const beforeRevision = this.state.revision; const beforeSequence = this.state.sequence; const beforeStaleReplaceAdvanced = this.state.staleReplaceAdvanced; const receiptId = crypto.randomUUID();

    try {
      const override = operation.retryOverrides[item.itemId]; const policy = override?.collisionPolicy ?? item.collisionPolicy; const collection = this.collection(operation.request.collectionId);

      if (item.action === 'create-folder') this.executeCreateFolder(collection, item, receipt, receiptId, policy);
      else if (item.kind === 'folder' || item.folderPath) this.executeFolder(collection, item, receipt, receiptId, policy, override?.expectedDestination ?? item.expectedDestination);
      else this.executeFile(collection, item, receipt, receiptId, policy, override?.expectedDestination ?? item.expectedDestination);
      if (receipt.state === 'completed') operation.mutations[item.itemId] = this.captureMutation(before, this.state.collections, beforeFolderShares, this.folderShares);
    } catch (cause) {
      const error = cause as { status?:number; code?:string; message?:string; destination?:FilesCollisionDestination; preserveSyntheticFixture?:boolean };

      if (!error.preserveSyntheticFixture) {
        this.state.collections = before; this.folderShares = beforeFolderShares; this.state.folderReceipts = beforeFolderReceipts;
        this.state.revision = beforeRevision; this.state.sequence = beforeSequence; this.state.staleReplaceAdvanced = beforeStaleReplaceAdvanced;
      }

      Object.assign(receipt, { state: 'failed', receiptId: null, error: { status: error.status ?? 409, code: error.code ?? 'state-conflict', message: error.message ?? String(cause), ...(error.destination ? { destination: error.destination } : {}) }, retryable: true, undoSupported: false });
    }
  }
  private resolveDestination(collection:SyntheticCollection, requested:string, policy:FilesOperationItem['collisionPolicy'], receipt:FilesOperationItemReceipt, ignoredFiles = new Set<string>(), ignoredFolders = new Set<string>(), expected?:FilesCollisionDestination) {
    const file = this.activeFileAt(collection, requested, ignoredFiles); const folder = this.activeFolderAt(collection, requested, ignoredFolders);

    if (!file && !folder) {
      if (policy === 'replace') throw { status: 409, code: 'destination-conflict', message: 'The synthetic Replace destination no longer exists; refresh Files.', ...(expected ? { destination: clone(expected) } : {}) };
      return { path: requested };
    }
    if (policy === 'skip') { Object.assign(receipt, { state: 'skipped', receiptId: crypto.randomUUID(), error: null, retryable: false }); return null }
    if (policy === 'keep-both') return { path: this.keepBothPath(collection, requested, ignoredFiles, ignoredFolders) };
    const destination = file ? this.fileState(file, collection.id) : undefined;

    if (policy !== 'replace') throw { status: 409, code: 'destination-conflict', message: 'A synthetic item already exists at ' + requested + '.', ...(destination ? { destination } : {}) };
    if (!file || !expected || !this.sameFileState(destination, expected)) throw { status: 409, code: 'destination-conflict', message: 'Replace requires the current authorized synthetic destination snapshot.', ...(destination ? { destination } : {}) };
    return { path: requested, displaced: file, displacedBefore: destination };
  }
  private executeFile(source:SyntheticCollection, item:FilesOperationItem, receipt:FilesOperationItemReceipt, receiptId:string, policy?:FilesOperationItem['collisionPolicy'], expectedDestination?:FilesCollisionDestination) {
    const file = source.files.find(candidate => candidate.id === item.fileId && !candidate.deletedAt);

    if (!file) throw { code: 'state-conflict', message: 'Synthetic source file is no longer available.' };
    const before = this.fileState(file, source.id);
    if (before.versionId !== item.expectedVersionId || before.revision !== item.expectedRevision) throw { code: 'state-conflict', message: 'Synthetic source version or revision changed.' };
    receipt.before = clone(before); receipt.receiptId = receiptId;
    if (item.action === 'trash') {
      file.deletedAt = new Date().toISOString(); file.updatedAt = file.deletedAt; file.operationRevision = this.nextRevision();
      file.syntheticTrash = {
        listed: true, revision: file.operationRevision,
        tombstone: { kind: 'version', id: file.currentVersionId, receiptId, operationId: receiptId, undo: { state: 'available', expiresAt: iso(30) } },
      };
      Object.assign(receipt, { after: this.fileState(file, source.id), state: 'completed', undoSupported: true, retryable: false });
      return;
    }
    if (!item.targetPath) throw { status: 400, code: 'invalid-operation', message: 'Synthetic destination path is required.' };
    const targetCollection = this.collection(item.targetCollectionId ?? source.id);
    const expectedFileDestination = isFilesOperationState(expectedDestination) ? expectedDestination : undefined;
    const target = this.resolveDestination(targetCollection, this.normalizePath(item.targetPath), policy, receipt, new Set<string>(item.action === 'move' ? [file.id] : []), new Set<string>(), expectedFileDestination);
    if (!target) return;
    if (target.displaced) {
      const slash = target.path.lastIndexOf('/'); const parent = slash < 0 ? '' : target.path.slice(0, slash); const name = slash < 0 ? target.path : target.path.slice(slash + 1);

      target.displaced.path = [parent, '.replaced-' + receiptId.slice(0, 8) + '-' + name].filter(Boolean).join('/');
      target.displaced.operationRevision = this.nextRevision(); target.displaced.updatedAt = new Date().toISOString();
      receipt.displacedBefore = target.displacedBefore; receipt.displacedAfter = this.fileState(target.displaced, targetCollection.id);
    }
    if (item.action === 'copy') {
      const copy = { ...clone(file), id: this.nextId('synthetic-copy'), path: target.path, currentVersionId: this.nextId('version-copy'), operationRevision: this.nextRevision(), updatedAt: new Date().toISOString(), deletedAt: undefined };

      targetCollection.files.push(copy); receipt.after = this.fileState(copy, targetCollection.id);
    } else {
      if (targetCollection !== source) { source.files = source.files.filter(candidate => candidate.id !== file.id); targetCollection.files.push(file) }
      file.path = target.path; file.operationRevision = this.nextRevision(); file.updatedAt = new Date().toISOString(); receipt.after = this.fileState(file, targetCollection.id);
    }
    Object.assign(receipt, { state: 'completed', error: null, retryable: false, undoSupported: true });
  }
  private executeCreateFolder(collection:SyntheticCollection, item:FilesOperationItem, receipt:FilesOperationItemReceipt, receiptId:string, policy?:FilesOperationItem['collisionPolicy']) {
    if (!item.targetPath) throw { status: 400, code: 'invalid-operation', message: 'Synthetic folder path is required.' };
    if (policy === 'replace') throw { status: 422, code: 'folder-replace-unavailable', message: 'Synthetic folders support Keep Both or Skip, not Replace.' };
    const target = this.resolveDestination(collection, this.normalizePath(item.targetPath), policy, receipt);
    if (!target) return;
    const folder = { folderId: this.nextId('synthetic-folder'), path: target.path, revision: this.nextRevision() };

    collection.folders.push(folder);
    Object.assign(receipt, { receiptId, before: null, after: clone(folder), state: 'completed', error: null, undoSupported: true, retryable: false });
  }
  private executeFolder(collection:SyntheticCollection, item:FilesOperationItem, receipt:FilesOperationItemReceipt, receiptId:string, policy?:FilesOperationItem['collisionPolicy'], expectedDestination?:FilesCollisionDestination) {
    const sourcePath = this.normalizePath(item.folderPath ?? ''); let folder = collection.folders.find(candidate => !candidate.deletedAt && candidate.path === sourcePath);
    const sourceState = folder ? this.folderState(folder, collection.id) : undefined;
    const files = collection.files.filter(file => !file.deletedAt && file.path.startsWith(sourcePath + '/')); let folders = collection.folders.filter(candidate => !candidate.deletedAt && (candidate.path === sourcePath || candidate.path.startsWith(sourcePath + '/')));

    if (!files.length && !folders.length || item.expectedFolder && !this.sameFolderState(sourceState, item.expectedFolder)) throw { code: 'source-conflict', message: 'Synthetic folder identity, collection, or revision changed.' };
    receipt.before = sourceState ? clone(sourceState) : null; receipt.receiptId = receiptId;
    const sourceSnapshot = this.folderSourceSnapshot(collection, sourcePath);
    const targetCollection = this.collection(item.targetCollectionId ?? collection.id); const crossCollection = targetCollection.id !== collection.id;

    if ((crossCollection || item.sourceSubtreeSignature !== undefined) && (!item.sourceSubtreeSignature || !/^[0-9a-f]{64}$/.test(item.sourceSubtreeSignature) || item.sourceSubtreeSignature !== sourceSnapshot.subtreeSignature)) {
      throw { status: 409, code: 'source-conflict', message: 'The synthetic source folder subtree changed; refresh Files.' };
    }
    if (item.action === 'trash') {
      const deletedAt = new Date().toISOString();

      if (!folder) {
        folder = { folderId: this.nextId('synthetic-folder-implicit'), path: sourcePath, revision: this.nextRevision() };
        collection.folders.push(folder); folders = [folder, ...folders];
      }

      files.forEach(file => {
        const childReceiptId = this.nextId('synthetic-trash-child-receipt');

        file.deletedAt = deletedAt; file.operationRevision = this.nextRevision(); file.updatedAt = deletedAt;
        file.syntheticTrash = { listed: true, revision: file.operationRevision, parentReceiptId: receiptId, tombstone: { kind: 'version', id: file.currentVersionId, receiptId: childReceiptId, operationId: childReceiptId, undo: { state: 'available', expiresAt: iso(30) } } };
      });
      folders.forEach(candidate => {
        candidate.deletedAt = deletedAt; candidate.revision = this.nextRevision();
        candidate.syntheticTrash = { listed: candidate.folderId === folder.folderId, revision: candidate.revision, parentReceiptId: receiptId, tombstone: { kind: 'receipt', id: receiptId, receiptId, operationId: receiptId, undo: { state: 'available', expiresAt: iso(30) } } };
      });
      this.state.folderReceipts[receiptId] = {
        collectionId: collection.id, rootFolderId: folder.folderId, rootPath: sourcePath,
        files: files.map(file => ({ id: file.id, path: file.path, revision: file.operationRevision ?? '0', receiptId: file.syntheticTrash!.tombstone.receiptId! })),
        folders: folders.map(candidate => ({ id: candidate.folderId, path: candidate.path, revision: candidate.revision })),
      };
      receipt.after = null;
    } else {
      if (!item.targetPath) throw { status: 400, code: 'invalid-operation', message: 'Synthetic folder destination is required.' };
      const requestedTarget = this.normalizePath(item.targetPath);

      if (!crossCollection && (requestedTarget === sourcePath || requestedTarget.startsWith(sourcePath + '/') || sourcePath.startsWith(requestedTarget + '/'))) throw { status: 409, code: 'invalid-operation', message: 'A synthetic folder destination cannot overlap its source.' };
      const ignoredFiles = new Set(files.map(file => file.id)); const ignoredFolders = new Set(folders.map(value => value.folderId));
      const moveIgnoredFiles = item.action === 'move' && !crossCollection ? ignoredFiles : new Set<string>(); const moveIgnoredFolders = item.action === 'move' && !crossCollection ? ignoredFolders : new Set<string>();
      const destinationFile = this.activeFileAt(targetCollection, requestedTarget, moveIgnoredFiles); const destinationFolder = this.activeFolderAt(targetCollection, requestedTarget, moveIgnoredFolders);
      let targetPath = requestedTarget;
      let displacedFiles:SyntheticFile[] = []; let displacedFolders:SyntheticFolder[] = []; let recovery:string | undefined;

      if (policy === 'replace' && !destinationFile && !destinationFolder) {
        throw { status: 409, code: 'destination-conflict', message: 'The synthetic Replace destination no longer exists; refresh Files.', ...(expectedDestination ? { destination: clone(expectedDestination) } : {}) };
      }

      if (destinationFile || destinationFolder) {
        if (policy === 'skip') { Object.assign(receipt, { state: 'skipped', error: null, retryable: false, undoSupported: false }); return }
        if (policy === 'keep-both') targetPath = this.keepBothPath(targetCollection, requestedTarget, moveIgnoredFiles, moveIgnoredFolders);
        else {
          const displayed = destinationFolder ? this.folderReplacementDestination(targetCollection, requestedTarget) : undefined;

          if (policy !== 'replace') {
            // This fixture advances only a descendant revision after exposing the
            // snapshot. The unchanged root revision makes the retry depend on the
            // subtree signature, matching the service's stale-tree CAS contract.
            if (destinationFolder?.folderId === 'synthetic-folder-stale-destination' && displayed && !this.state.staleReplaceAdvanced) {
              const child = targetCollection.files.find(file => file.id === 'synthetic-stale-destination-file');

              this.state.staleReplaceAdvanced = true;
              if (child) { child.operationRevision = this.nextRevision(); child.updatedAt = new Date().toISOString() }
            }
            throw { status: 409, code: 'destination-conflict', message: 'A synthetic folder already exists at ' + requestedTarget + '. Choose Replace, Keep Both or Skip.', ...(displayed ? { destination: displayed } : {}), preserveSyntheticFixture: destinationFolder?.folderId === 'synthetic-folder-stale-destination' };
          }
          if (!displayed || !this.sameFolderReplacementDestination(displayed, expectedDestination)) {
            throw { status: 409, code: 'destination-conflict', message: 'The synthetic Replace destination subtree changed; refresh Files.', ...(displayed ? { destination: displayed } : expectedDestination ? { destination: clone(expectedDestination) } : {}) };
          }
          displacedFiles = targetCollection.files.filter(file => !file.deletedAt && file.path.startsWith(requestedTarget + '/'));
          displacedFolders = targetCollection.folders.filter(candidate => !candidate.deletedAt && (candidate.path === requestedTarget || candidate.path.startsWith(requestedTarget + '/')));
          const slash = requestedTarget.lastIndexOf('/'); const parent = slash < 0 ? '' : requestedTarget.slice(0, slash); const name = slash < 0 ? requestedTarget : requestedTarget.slice(slash + 1);
          recovery = [parent, '.replaced-' + receiptId + '-' + name].filter(Boolean).join('/');

          if (this.activeFileAt(targetCollection, recovery) || this.activeFolderAt(targetCollection, recovery) || targetCollection.files.some(file => !file.deletedAt && file.path.startsWith(recovery + '/')) || targetCollection.folders.some(candidate => !candidate.deletedAt && candidate.path.startsWith(recovery + '/'))) {
            throw { status: 409, code: 'state-conflict', message: 'Synthetic Replace recovery sibling is occupied.' };
          }
        }
      }
      const mappedFiles = files.map(file => ({ file, path: targetPath + file.path.slice(sourcePath.length) })); const mappedFolders = folders.map(value => ({ folder: value, path: targetPath + value.path.slice(sourcePath.length) }));
      const sourceFolderShares = this.folderShares.filter(share => share.collectionId === collection.id && (share.folderPath === sourcePath || share.folderPath.startsWith(sourcePath + '/')));
      const preflightFiles = new Set([...ignoredFiles, ...displacedFiles.map(file => file.id)]); const preflightFolders = new Set([...ignoredFolders, ...displacedFolders.map(candidate => candidate.folderId)]);
      const conflict = mappedFiles.find(value => this.activeFileAt(targetCollection, value.path, preflightFiles) || this.activeFolderAt(targetCollection, value.path, preflightFolders)) ?? mappedFolders.find(value => this.activeFileAt(targetCollection, value.path, preflightFiles) || this.activeFolderAt(targetCollection, value.path, preflightFolders));

      if (conflict) throw { code: 'destination-conflict', message: 'A synthetic descendant already exists at ' + conflict.path + '.' };
      if (destinationFolder && recovery) {
        const recoveryPath = recovery;

        receipt.displacedBefore = this.folderState(destinationFolder, targetCollection.id);
        displacedFolders.forEach(candidate => { candidate.path = recoveryPath + candidate.path.slice(requestedTarget.length); candidate.revision = this.nextRevision() });
        displacedFiles.forEach(file => { file.path = recoveryPath + file.path.slice(requestedTarget.length); file.operationRevision = this.nextRevision(); file.updatedAt = new Date().toISOString() });
        this.folderShares.filter(share => share.collectionId === targetCollection.id && (share.folderPath === requestedTarget || share.folderPath.startsWith(requestedTarget + '/')))
          .forEach(share => { share.folderPath = recoveryPath + share.folderPath.slice(requestedTarget.length) });

        receipt.displacedAfter = this.folderState(destinationFolder, targetCollection.id);
      }
      if (item.action === 'copy') {
        mappedFolders.forEach(value => targetCollection.folders.push({ folderId: this.nextId('synthetic-folder-copy'), path: value.path, revision: this.nextRevision() }));
        mappedFiles.forEach(value => targetCollection.files.push({ ...clone(value.file), id: this.nextId('synthetic-copy'), path: value.path, currentVersionId: this.nextId('version-copy'), operationRevision: this.nextRevision(), updatedAt: new Date().toISOString() }));
        sourceFolderShares.forEach(share => this.folderShares.push({ ...clone(share), id: this.nextId('synthetic-folder-share-copy'), collectionId: targetCollection.id, folderPath: targetPath + share.folderPath.slice(sourcePath.length) }));
        const copied = targetCollection.folders.find(value => value.path === targetPath) ?? { folderId: this.nextId('synthetic-folder-copy'), path: targetPath, revision: this.nextRevision() };

        if (!targetCollection.folders.includes(copied)) targetCollection.folders.push(copied);
        receipt.after = this.folderState(copied, targetCollection.id);
      } else {
        if (crossCollection) {
          collection.folders = collection.folders.filter(candidate => !ignoredFolders.has(candidate.folderId));
          collection.files = collection.files.filter(candidate => !ignoredFiles.has(candidate.id));
          targetCollection.folders.push(...folders); targetCollection.files.push(...files);
        }
        mappedFolders.forEach(value => { value.folder.path = value.path; value.folder.revision = this.nextRevision() });
        mappedFiles.forEach(value => { value.file.path = value.path; value.file.operationRevision = this.nextRevision(); value.file.updatedAt = new Date().toISOString() });
        sourceFolderShares.forEach(share => { share.collectionId = targetCollection.id; share.folderPath = targetPath + share.folderPath.slice(sourcePath.length) });
        const moved = folder ?? { folderId: this.nextId('synthetic-folder-move'), path: targetPath, revision: this.nextRevision() };

        if (!folder) targetCollection.folders.push(moved);
        receipt.after = this.folderState(moved, targetCollection.id);
      }
    }
    Object.assign(receipt, { state: 'completed', error: null, undoSupported: true, retryable: false });
  }

  private folderShareId(share:FolderShare) {
    return share.id ?? [share.collectionId, share.folderPath, share.principalType, share.principalId].join('\0');
  }
  private captureMutation(before:SyntheticCollection[], after:SyntheticCollection[], beforeFolderShares:FolderShare[], afterFolderShares:FolderShare[]):SyntheticMutation {
    const beforeFiles = new Map(before.flatMap(collection => collection.files.map(file => [file.id, JSON.stringify([collection.id, file])] as const))); const afterFiles = new Map(after.flatMap(collection => collection.files.map(file => [file.id, JSON.stringify([collection.id, file])] as const))); const beforeFolders = new Map(before.flatMap(collection => collection.folders.map(folder => [folder.folderId, JSON.stringify([collection.id, folder])] as const))); const afterFolders = new Map(after.flatMap(collection => collection.folders.map(folder => [folder.folderId, JSON.stringify([collection.id, folder])] as const)));
    const beforeShares = new Map(beforeFolderShares.map(share => [this.folderShareId(share), JSON.stringify(share)])); const afterShares = new Map(afterFolderShares.map(share => [this.folderShareId(share), JSON.stringify(share)]));

    return {
      before: clone(before), after: clone(after), beforeFolderShares: clone(beforeFolderShares), afterFolderShares: clone(afterFolderShares),
      fileIds: [...new Set([...beforeFiles.keys(), ...afterFiles.keys()])].filter(id => beforeFiles.get(id) !== afterFiles.get(id)),
      folderIds: [...new Set([...beforeFolders.keys(), ...afterFolders.keys()])].filter(id => beforeFolders.get(id) !== afterFolders.get(id)),
      folderShareIds: [...new Set([...beforeShares.keys(), ...afterShares.keys()])].filter(id => beforeShares.get(id) !== afterShares.get(id)),
    };
  }
  private locatedItem(collections:SyntheticCollection[], kind:'file' | 'folder', id:string) {
    for (const collection of collections) {
      const item = kind === 'file' ? collection.files.find(file => file.id === id) : collection.folders.find(folder => folder.folderId === id);

      if (item) return { collectionId: collection.id, item };
    }
  }
  private namespaceOwners(collections:SyntheticCollection[], collectionId:string, path:string, descendants:boolean) {
    const collection = collections.find(value => value.id === collectionId);

    if (!collection) return null;
    const ownsPath = (candidate:string) => candidate === path || descendants && candidate.startsWith(path + '/');

    return [
      ...collection.files.filter(file => ownsPath(file.path)).map(file => 'file:' + file.id),
      ...collection.folders.filter(folder => ownsPath(folder.path)).map(folder => 'folder:' + folder.folderId),
    ].sort();
  }
  private mutationMatches(mutation:SyntheticMutation, side:'before' | 'after') {
    const snapshot = mutation[side];
    const matchesItem = (kind:'file' | 'folder', id:string) => {
      const current = this.locatedItem(this.state.collections, kind, id); const saved = this.locatedItem(snapshot, kind, id);

      return JSON.stringify(current) === JSON.stringify(saved);
    };
    const guards = new Map<string, { collectionId:string; path:string; descendants:boolean }>();
    const addGuard = (kind:'file' | 'folder', id:string) => {
      for (const collections of [mutation.before, mutation.after]) {
        const located = this.locatedItem(collections, kind, id);

        if (!located) continue;
        const path = located.item.path; const descendants = kind === 'folder'; const key = [located.collectionId, path, descendants ? 'tree' : 'item'].join('\0');

        guards.set(key, { collectionId: located.collectionId, path, descendants });
      }
    };

    mutation.fileIds.forEach(id => addGuard('file', id)); mutation.folderIds.forEach(id => addGuard('folder', id));

    return mutation.fileIds.every(id => matchesItem('file', id)) && mutation.folderIds.every(id => matchesItem('folder', id)) &&
      mutation.folderShareIds.every(id => JSON.stringify(this.folderShares.find(share => this.folderShareId(share) === id)) === JSON.stringify(mutation[side === 'before' ? 'beforeFolderShares' : 'afterFolderShares'].find(share => this.folderShareId(share) === id))) &&
      [...guards.values()].every(guard => JSON.stringify(this.namespaceOwners(this.state.collections, guard.collectionId, guard.path, guard.descendants)) === JSON.stringify(this.namespaceOwners(snapshot, guard.collectionId, guard.path, guard.descendants)));
  }
  private applyMutation(mutation:SyntheticMutation, side:'before' | 'after') {
    for (const collection of this.state.collections) { collection.files = collection.files.filter(file => !mutation.fileIds.includes(file.id)); collection.folders = collection.folders.filter(folder => !mutation.folderIds.includes(folder.folderId)) }
    for (const saved of mutation[side]) {
      const collection = this.collection(saved.id);

      collection.files.push(...clone(saved.files.filter(file => mutation.fileIds.includes(file.id))));
      collection.folders.push(...clone(saved.folders.filter(folder => mutation.folderIds.includes(folder.folderId))));
    }
    this.folderShares = this.folderShares.filter(share => !mutation.folderShareIds.includes(this.folderShareId(share)));
    this.folderShares.push(...clone(mutation[side === 'before' ? 'beforeFolderShares' : 'afterFolderShares'].filter(share => mutation.folderShareIds.includes(this.folderShareId(share)))));
  }
  private refreshReceipt(operation:SyntheticOperation) {
    const items = operation.receipt.items; const pending = items.some(item => item.state === 'pending'); const completed = items.some(item => item.state === 'completed'); const failed = items.some(item => item.state === 'failed'); const cancelled = items.some(item => item.state === 'cancelled'); const undone = items.some(item => item.state === 'undone'); const undoConflict = items.some(item => item.state === 'completed' && item.error?.code === 'state-conflict' && !item.undoSupported);

    operation.receipt.state = pending ? 'pending' : undone && !completed ? 'undone' : failed && !completed && !cancelled ? 'failed' : cancelled && !completed && !failed ? 'cancelled' : failed || cancelled || undone && completed || undoConflict ? 'partial' : 'completed';
    operation.receipt.undoSupported = !pending && items.some(item => item.state === 'completed' && item.undoSupported);
    operation.receipt.retryable = !pending && items.some(item => ['failed', 'cancelled'].includes(item.state) && item.retryable);
    operation.receipt.updatedAt = new Date().toISOString();
  }

  async restoreVersion() {}
  private trashConflict(message:string):never { throw Object.assign(new Error(message), { status: 409, code: 'trash-state-conflict' }) }
  private exactTrashState(actual:SyntheticTrashState | undefined, item:FilesTrashItem, currentRevision:string) {
    return Boolean(actual?.listed && actual.revision === item.revision && currentRevision === item.revision && JSON.stringify(actual.tombstone) === JSON.stringify(item.currentTombstone));
  }
  private receiptMembers(collection:SyntheticCollection, receiptId:string) {
    const plan = this.state.folderReceipts[receiptId];
    const files = plan?.files.map(member => collection.files.find(file => file.id === member.id)).filter((file):file is SyntheticFile => Boolean(file)) ?? [];
    const folders = plan?.folders.map(member => collection.folders.find(folder => folder.folderId === member.id)).filter((folder):folder is SyntheticFolder => Boolean(folder)) ?? [];
    const exact = Boolean(plan && plan.collectionId === collection.id && files.length === plan.files.length && folders.length === plan.folders.length &&
      plan.folders.some(member => member.id === plan.rootFolderId && member.path === plan.rootPath) &&
      plan.files.every(member => {
        const file = files.find(candidate => candidate.id === member.id);

        return Boolean(file?.deletedAt && file.path === member.path && file.operationRevision === member.revision && file.syntheticTrash?.revision === member.revision && file.syntheticTrash.parentReceiptId === receiptId && file.syntheticTrash.tombstone.receiptId === member.receiptId);
      }) && plan.folders.every(member => {
        const folder = folders.find(candidate => candidate.folderId === member.id);

        return Boolean(folder?.deletedAt && folder.path === member.path && folder.revision === member.revision && folder.syntheticTrash?.revision === member.revision && folder.syntheticTrash.parentReceiptId === receiptId && folder.syntheticTrash.tombstone.receiptId === receiptId);
      }));
    const expectedFiles = new Set(plan?.files.map(member => member.id) ?? []); const expectedFolders = new Set(plan?.folders.map(member => member.id) ?? []);
    const inNamespace = (path:string) => Boolean(plan && (path === plan.rootPath || path.startsWith(plan.rootPath + '/')));
    const namespaceExact = Boolean(plan && collection.files.filter(file => inNamespace(file.path)).every(file => expectedFiles.has(file.id)) &&
      collection.folders.filter(folder => inNamespace(folder.path)).every(folder => expectedFolders.has(folder.folderId)));

    return { files, folders, exact, namespaceExact, plan };
  }
  private folderRestoreNamespaceOccupied(collection:SyntheticCollection, plan:SyntheticFolderReceiptPlan) {
    const expectedFiles = new Set(plan.files.map(member => member.id)); const expectedFolders = new Set(plan.folders.map(member => member.id));
    const inNamespace = (path:string) => path === plan.rootPath || path.startsWith(plan.rootPath + '/');

    return collection.files.some(file => !file.deletedAt && inNamespace(file.path) && !expectedFiles.has(file.id)) ||
      collection.folders.some(folder => !folder.deletedAt && inNamespace(folder.path) && !expectedFolders.has(folder.folderId));
  }
  async restoreTrashItem(item:FilesTrashItem):Promise<FilesTrashRestoreResult> {
    const collection = this.currentCollection();

    if (item.kind === 'file') {
      const file = collection.files.find(candidate => candidate.id === item.id);

      if (!file?.deletedAt || !this.exactTrashState(file.syntheticTrash, item, file.operationRevision ?? '0')) this.trashConflict('Synthetic restore was blocked because the file revision or current tombstone changed.');
      if (this.activeFileAt(collection, file.path, new Set([file.id])) || this.activeFolderAt(collection, file.path)) this.trashConflict('Synthetic restore was blocked because the original path is occupied.');
      const receiptId = file.syntheticTrash!.tombstone.receiptId ?? null;

      file.deletedAt = undefined; file.syntheticTrash = undefined; file.updatedAt = new Date().toISOString(); file.operationRevision = this.nextRevision(); this.persist();
      return { status: 'restored', kind: 'file', id: file.id, path: file.path, revision: file.operationRevision, currentTombstone: null, receiptId, versionId: file.currentVersionId };
    }
    const folder = collection.folders.find(candidate => candidate.folderId === item.id); const receiptId = folder?.syntheticTrash?.tombstone.receiptId;

    if (!folder?.deletedAt || !receiptId || !this.exactTrashState(folder.syntheticTrash, item, folder.revision)) this.trashConflict('Synthetic restore was blocked because the folder revision or current receipt changed.');
    const members = this.receiptMembers(collection, receiptId);
    if (!members.exact) this.trashConflict('Synthetic restore was blocked because a child revision changed after the folder entered Trash.');
    if (this.folderRestoreNamespaceOccupied(collection, members.plan!)) this.trashConflict('Synthetic restore was blocked because the original folder namespace is occupied.');
    if (!members.namespaceExact) this.trashConflict('Synthetic restore was blocked because the folder subtree gained an unrelated item after entering Trash.');
    members.files.forEach(file => { file.deletedAt = undefined; file.syntheticTrash = undefined; file.updatedAt = new Date().toISOString(); file.operationRevision = this.nextRevision() });
    members.folders.forEach(candidate => { candidate.deletedAt = undefined; candidate.syntheticTrash = undefined; candidate.revision = this.nextRevision() });
    delete this.state.folderReceipts[receiptId];
    this.persist();
    return { status: 'restored', kind: 'folder', id: folder.folderId, path: folder.path, revision: folder.revision, currentTombstone: null, receiptId };
  }
  async purgeTrashItem(item:FilesTrashItem):Promise<FilesTrashPurgeResult> {
    const collection = this.currentCollection();

    if (item.kind === 'file') {
      const file = collection.files.find(candidate => candidate.id === item.id);

      if (!file?.deletedAt || !this.exactTrashState(file.syntheticTrash, item, file.operationRevision ?? '0')) this.trashConflict('Synthetic purge was blocked because the file revision or current tombstone changed.');
      const receiptId = file.syntheticTrash!.tombstone.receiptId ?? null; const recoveryRequired = file.syntheticTrash!.purgeOutcome === 'recovery-required';

      collection.files = collection.files.filter(candidate => candidate.id !== file.id); this.persist();
      if (recoveryRequired) return { status: 'recovery-required', metadataPurged: true, chunks: 'pending', retainedArtifacts: 'preserved', undo: 'invalidated', receiptId, reason: 'Synthetic metadata was removed, but the fixture intentionally preserves retained artifacts for recovery.' };
      return { status: 'purged', metadataPurged: true, chunks: 'complete', retainedArtifacts: 'complete', undo: receiptId ? 'invalidated' : 'unavailable', receiptId };
    }
    const folder = collection.folders.find(candidate => candidate.folderId === item.id); const receiptId = folder?.syntheticTrash?.tombstone.receiptId;

    if (!folder?.deletedAt || !receiptId || !this.exactTrashState(folder.syntheticTrash, item, folder.revision)) this.trashConflict('Synthetic purge was blocked because the folder revision or current receipt changed.');
    const members = this.receiptMembers(collection, receiptId);
    if (!members.exact || !members.namespaceExact) this.trashConflict('Synthetic purge was blocked because the folder membership changed after entering Trash.');
    const fileIds = new Set(members.files.map(file => file.id)); const folderIds = new Set(members.folders.map(candidate => candidate.folderId));

    collection.files = collection.files.filter(file => !fileIds.has(file.id)); collection.folders = collection.folders.filter(candidate => !folderIds.has(candidate.folderId)); delete this.state.folderReceipts[receiptId]; this.persist();
    return { status: 'purged', kind: 'folder', id: folder.folderId, path: folder.path, revision: folder.revision, currentTombstone: null, metadataPurged: true, chunks: 'complete', retainedArtifacts: 'complete', undo: 'invalidated', receiptId };
  }
  async restoreTrash(fileId:string) { const item = (await this.load()).trash?.find(candidate => candidate.kind === 'file' && candidate.id === fileId); if (!item) throw new Error('Synthetic file is not in Trash'); await this.restoreTrashItem(item) }
  async trashFile(fileId:string) { const file = this.currentCollection().files.find(item => item.id === fileId && !item.deletedAt); if (!file) throw new Error('Synthetic file is no longer available'); const receiptId = crypto.randomUUID(); file.deletedAt = new Date().toISOString(); file.updatedAt = file.deletedAt; file.operationRevision = this.nextRevision(); file.syntheticTrash = { listed: true, revision: file.operationRevision, tombstone: { kind: 'version', id: file.currentVersionId, receiptId, operationId: receiptId, undo: { state: 'available', expiresAt: iso(30) } } }; this.persist() }
  async purgeTrash(fileId:string) { const collection = this.currentCollection(); const file = collection.files.find(item => item.id === fileId && item.deletedAt); if (!file) throw new Error('Synthetic file is not in Trash'); collection.files = collection.files.filter(item => item.id !== fileId); this.persist() }
  async createPublicLink(fileId:string, options:ShareLinkOptions) { const share:ShareLink = { id: 'share-' + fileId, url: 'https://share.sulla.cloud/v/Synthetic', name: '03-share.html · Share dialog', password: Boolean(options.password), expiresAt: options.expiresAt ?? undefined, viewCount: 0, keepAvailable: options.keepAvailable, keepUntil: options.keepUntil ?? undefined, displaySharerName: options.displaySharerName, servedFrom: options.keepAvailable ? 'cloud' : 'desktop', assetKind: options.assetKind ?? 'artifact', mode: options.mode, source: 'Sulla-made › mockups', targetId: fileId, targetType: 'file', collectionId: this.state.selectedCollectionId, createdAt: iso() }; this.shares.unshift(share); return share }
  async updatePublicLink(id:string, options:Partial<ShareLinkOptions>) { const share = this.shares.find(item => item.id === id); if (!share) throw new Error('Synthetic link not found'); Object.assign(share, options, { password: options.password === undefined ? share.password : Boolean(options.password), servedFrom: options.keepAvailable ? 'cloud' : share.servedFrom }); return share }
  async listPublicLinks() { return this.shares.map(item => ({ ...item })) }
  async revokePublicLink(id:string) { const share = this.shares.find(item => item.id === id); if (share) share.revokedAt = iso() }
  async restorePublicLink(id:string, password?:string) { const share = this.shares.find(item => item.id === id); if (!share) throw new Error('Synthetic link not found'); if (share.password && (!password || password.length < 8)) throw new Error('Re-enter the synthetic link password'); share.revokedAt = undefined; return share }
  async shareActivity():Promise<ShareActivity[]> { return [{ id: 'event-1', action: 'viewed', occurredAt: iso(-1), detail: '03-share.html' }, { id: 'event-2', action: 'downloaded', occurredAt: iso(-2), detail: 'Vault phase 2 walkthrough.mp4' }] }
  async listFolderShares() { return this.folderShares }
  async shareFolder(collectionId:string, folderPath:string, principalType:SharePrincipalType, principalId:string, role:'view' | 'edit') { const share = { id: principalType + ':' + principalId, collectionId, folderPath, principalType, principalId, role }; this.folderShares.push(share); this.persist(); return share }
  async unshareFolder(share:FolderShare) { this.folderShares = this.folderShares.filter(item => item.id !== share.id); this.persist() }
  async listFileShares(fileId:string):Promise<FileAccessList> { return { ownerId: 'synthetic-owner', direct: this.fileShares.filter(item => item.fileId === fileId).map(item => ({ ...item })), inherited: this.folderShares.map(item => ({ ...item, id: item.id ?? ['folder', item.folderPath, item.principalType, item.principalId].join(':'), source: 'folder' as const })) } }
  async shareFile(fileId:string, principalType:SharePrincipalType, principalId:string, role:'view' | 'edit') { const existing = this.fileShares.find(item => item.fileId === fileId && item.principalType === principalType && item.principalId === principalId); if (existing) { existing.role = role; return { ...existing } } const share:FileShare = { id: ['file', fileId, principalType, principalId].join(':'), fileId, principalType, principalId, role }; this.fileShares.push(share); return { ...share } }
  async updateFileShare(fileId:string, shareId:string, role:'view' | 'edit') { const share = this.fileShares.find(item => item.fileId === fileId && item.id === shareId); if (!share) throw new Error('Synthetic file share not found'); share.role = role; return { ...share } }
  async unshareFile(fileId:string, shareId:string) { this.fileShares = this.fileShares.filter(item => item.fileId !== fileId || item.id !== shareId) }
  async listMembers() { return { members: [{ id: 'synthetic-owner', email: 'jonathon@example.test', role: 'owner' }, { id: 'maya', email: 'maya@example.test', role: 'member' }], groups: [{ id: 'design', name: 'Design', members: ['maya'] }] } }
}
