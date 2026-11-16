// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { SyntheticFilesStore } from './synthetic/SyntheticFilesStore';
import { SyntheticMutationJournal } from './synthetic/SyntheticMutationJournal';
import { SyntheticOperationExecutor } from './synthetic/SyntheticOperationExecutor';
import { SyntheticOperationService } from './synthetic/SyntheticOperationService';
import { SyntheticSharingService } from './synthetic/SyntheticSharingService';
import { SyntheticTrashService } from './synthetic/SyntheticTrashService';
import { SyntheticValues } from './synthetic/SyntheticValues';
import type { FileAccessList, FileShare, FilesCapabilities, FilesDataSource, FilesDetail, FilesFolderSourceSnapshot, FilesOperationCapabilities, FilesOperationReceipt, FilesOperationRequest, FilesOperationRetry, FilesPreview, FilesSaveRequest, FilesSaveSuccess, FilesSnapshot, FilesTrashItem, FilesTrashPurgeResult, FilesTrashRestoreResult, FilesTrashTombstone, FilesVersion, FolderShare, ShareActivity, ShareLink, ShareLinkOptions, SharePrincipalType } from './types';

/* eslint-disable @typescript-eslint/require-await -- the preview adapter intentionally implements the async production datasource contract in memory */

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
  private contents=new Map<string,string>();

  constructor(
    private readonly store = new SyntheticFilesStore(),
    private readonly journal = new SyntheticMutationJournal(store),
    private readonly operations = new SyntheticOperationService(store, new SyntheticOperationExecutor(store, journal), journal),
    private readonly trash = new SyntheticTrashService(store),
    private readonly sharing = new SyntheticSharingService(store),
  ) {
    this.capabilities.crossCollectionOperations = this.store.state.selectedCollectionId === 'synthetic-collection' ? 'all-authorized' : 'stored-authorized';
    this.operations.resumePending();
  }

  async load():Promise<FilesSnapshot> {
    const collection = this.store.currentCollection(); const active = collection.files.filter(file => !file.deletedAt); const indexed = active.filter(file => file.indexStatus === 'indexed').length;

    return {
      collection: { id: collection.id, name: collection.name, home: collection.home, systemArea: collection.systemArea, orgId: 'synthetic-org', retentionPolicy: {}, storageQuota: 10_000_000_000, keptBytes: active.reduce((sum, file) => sum + file.size, 0), desktopCount: 0, memberCount: 2, accountName: 'Preview user', accountRole: 'owner', ownerUserId: 'synthetic-user', cloudCatalogSync: Boolean(collection.cloudCatalogSync) },
      availableCollections: this.store.state.collections.map(item => ({ id: item.id, name: item.name, systemArea: item.systemArea })),
      folders: collection.folders.filter(folder => !folder.deletedAt).map(folder => this.store.folderState(folder, collection.id)),
      files: collection.files.map(({ syntheticTrash: _syntheticTrash, ...file }) => ({ ...file })),
      trash: [
        ...collection.files.filter(file => file.deletedAt && file.syntheticTrash?.listed).map(file => {
          const { syntheticTrash, ...item } = file;

          return { ...item, kind: 'file' as const, revision: syntheticTrash!.revision, currentTombstone: SyntheticValues.clone(syntheticTrash!.tombstone) as Extract<FilesTrashTombstone, { kind:'version' }> };
        }),
        ...collection.folders.filter(folder => folder.deletedAt && folder.syntheticTrash?.listed).map(folder => ({
          kind: 'folder' as const, id: folder.folderId, path: folder.path, revision: folder.syntheticTrash!.revision,
          deletedAt: folder.deletedAt!, currentTombstone: SyntheticValues.clone(folder.syntheticTrash!.tombstone) as Extract<FilesTrashTombstone, { kind:'receipt' }>,
          capabilities: { canEdit: true, canManage: true, canViewDraft: true, canPublish: true },
        })),
      ],
      status: { state: this.paused ? 'paused' : 'synced', pendingFiles: 0, lastSyncAt: this.store.iso(), serverConfigured: true, location: 'server', serverLabel: 'Synthetic stored preview', indexing: { total: active.length, pending: 0, indexing: 0, indexed, partial: 0, unsupported: 0, failed: 0, complete: indexed === active.length } },
    };
  }
  selectCollection(collectionId:string) {
    this.store.collection(collectionId); this.store.state.selectedCollectionId = collectionId;
    this.capabilities.crossCollectionOperations = collectionId === 'synthetic-collection' ? 'all-authorized' : 'stored-authorized';
    this.store.persist();
  }
  async operationCapabilities(collectionId:string):Promise<FilesOperationCapabilities> {
    const available = this.store.state.collections.some(collection => collection.id === collectionId);

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
    const collection = this.store.collection(collectionId); const normalized = this.store.normalizePath(path);
    const exists = Boolean(this.store.activeFolderAt(collection, normalized) || collection.files.some(file => !file.deletedAt && file.path.startsWith(normalized + '/')) || collection.folders.some(folder => !folder.deletedAt && folder.path.startsWith(normalized + '/')));

    if (!exists) throw new Error('Synthetic folder was not found');
    return SyntheticValues.clone(this.store.folderSourceSnapshot(collection, normalized));
  }
  async history(fileId:string, currentVersionId:string):Promise<FilesVersion[]> { return Array.from({ length: 7 }, (_, index) => ({ id: index === 0 ? currentVersionId : fileId + '-version-' + (7 - index), size: 184_000_000 + index * 300_000, deleted: false, created_by_type: index ? 'user' : 'agent-run', created_by_id: index ? 'Jonathon' : 'heartbeat run #4,112', created_at: this.store.iso(-index / 24), message: index ? ['Trimmed last 12 seconds', 'Camera bubble moved to corner', 'Uploaded from tray'][index - 1] || 'Recording updated' : 'Transcript added', device_id: index ? 'Mac Studio' : 'heartbeat run #4,112', current: index === 0 })) }
  async preview(fileId:string):Promise<FilesPreview> { const file=this.store.state.collections.flatMap(item=>item.files).find(item=>item.id===fileId);if(!file)throw new Error('Synthetic file not found.');let content=this.contents.get(fileId);if(content===undefined){content=file.mime==='text/markdown'?'---\nstatus: Draft\nowner: Preview user\n---\n\n# '+file.path.split('/').at(-1)+'\n\nSynthetic Markdown stays editable as exact source.\n\n- [ ] Try the document editor\n':'Synthetic text preview for '+file.path+'\n';this.contents.set(fileId,content)}return { data:new TextEncoder().encode(content),mime:file.mime,path:file.path } }
  async saveContent(request:FilesSaveRequest):Promise<FilesSaveSuccess> { const file=this.store.state.collections.flatMap(item=>item.files).find(item=>item.id===request.fileId);if(!file)throw new Error('Synthetic file not found.');if(request.baseVersionId!==file.currentVersionId)throw Object.assign(new Error('Synthetic document changed.'),{status:409,code:'VERSION_CONFLICT',currentVersionId:file.currentVersionId});this.contents.set(file.id,request.content);file.currentVersionId=this.store.nextId('version');file.versionCount+=1;file.updatedAt=new Date().toISOString();this.store.persist();return{status:'saved',fileId:file.id,path:file.path,mime:file.mime,content:request.content,versionId:file.currentVersionId} }
  async detail(fileId = 'synthetic-video'):Promise<FilesDetail> { const file = this.store.state.collections.flatMap(item => item.files).find(item => item.id === fileId) ?? this.store.currentCollection().files[0]; return { item: file, capabilities: { canEdit: true, canManage: true, canViewDraft: true, canPublish: true }, provenance: { type: 'synthetic-preview', id: 'fixture' }, version: (await this.history(file.id, file.currentVersionId))[0], recording: file.mime.startsWith('video/') ? { version_id: file.currentVersionId, language: 'en', generator: 'synthetic fixture', duration_seconds: 42, generated_at: this.store.iso(), transcript: [{ start: 0, end: 8, text: 'Synthetic Files preview fixture.' }], chapters: [{ start: 0, end: 42, title: 'Preview fixture' }] } : undefined, links: [], activity: [], access: { role: 'owner', inherited: [] } } }
  async mediaUrl(fileId:string):Promise<string> { const file = this.store.state.collections.flatMap(item => item.files).find(item => item.id === fileId); if (file?.mime !== 'image/png') return ''; const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="700"><rect width="1200" height="700" fill="#152536"/><path d="M130 520 390 280l150 140 150-190 380 290H130Z" fill="#5096b3"/><circle cx="900" cy="220" r="72" fill="#a5d8e8"/></svg>'; return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg) }
  async search(query:string) { const files = (await this.load()).files.filter(file => !file.deletedAt && file.path.toLowerCase().includes(query.toLowerCase())); return { files, coverage: { total: files.length, pending: 0, indexing: 0, indexed: files.length, partial: 0, unsupported: 0, failed: 0, complete: true } } }
  async reindex() {}
  async setPaused(paused:boolean) { this.paused = paused; return (await this.load()).status }
  async chooseUpload(_destination = '') { return 0 }
  async uploadPaths(_paths:string[], _destination = '') { return 0 }
  async createFolder(path:string) { const collection = this.store.currentCollection(); const value = this.store.normalizePath(path); if (!this.store.activeFileAt(collection, value) && !this.store.activeFolderAt(collection, value)) collection.folders.push({ folderId: this.store.nextId('synthetic-folder'), path: value, revision: this.store.nextRevision() }); this.store.persist() }
  async updateFolderDescription(folderId:string,description:string,namingHint?:string) { const folder=this.store.currentCollection().folders.find(item=>item.folderId===folderId); if(folder){folder.description=description;folder.namingHint=namingHint;folder.needsDescription=false;folder.revision=this.store.nextRevision();this.store.persist()} }
  async setCollectionCloudSync(collectionId:string,enabled:boolean) { const collection=this.store.state.collections.find(item=>item.id===collectionId); if(collection){collection.cloudCatalogSync=enabled;this.store.persist()} }
  async openFolder() {}
  async openFile() {}
  async downloadFile() { return false }
  async downloadFiles() { return { count: 0, error: 'Downloads are unavailable in the synthetic preview.' } }
  async listStars(collectionId:string) { return (this.store.state.stars[collectionId] ?? []).map(key => key.startsWith('folder:') ? { folderPath: key.slice(7) } : { fileId: key }) }
  async setStar(collectionId:string, target:{ fileId?:string; folderPath?:string }, starred:boolean) { const key = target.fileId ?? 'folder:' + target.folderPath; const stars = new Set(this.store.state.stars[collectionId] ?? []); starred ? stars.add(key) : stars.delete(key); this.store.state.stars[collectionId] = [...stars]; this.store.persist() }
  async operate(action:'move' | 'copy', collectionId:string, items:{ fileId?:string; folderPath?:string; targetPath:string }[]) {
    const collection = this.store.collection(collectionId);
    let receipt = await this.submitOperation({ idempotencyKey: crypto.randomUUID(), collectionId, items: items.map(item => {
      const file = item.fileId ? collection.files.find(candidate => candidate.id === item.fileId) : undefined;
      const folder = item.folderPath ? collection.folders.find(candidate => candidate.path === item.folderPath && !candidate.deletedAt) : undefined;

      return { itemId: crypto.randomUUID(), action, kind: item.folderPath ? 'folder' : 'file', ...item, ...(file ? { expectedVersionId: file.currentVersionId, expectedRevision: file.operationRevision } : {}), ...(folder ? { expectedFolder: this.store.folderState(folder, collection.id), sourceSubtreeSignature: this.store.folderSourceSnapshot(collection, folder.path).subtreeSignature } : {}) };
    }) });

    while (receipt.state === 'pending') { await new Promise(resolve => setTimeout(resolve, 25)); receipt = await this.getOperation(receipt.operationId) }
    if (receipt.items.some(item => item.state === 'failed')) throw new Error(receipt.items.find(item => item.error)?.error?.message ?? 'Synthetic operation failed');
  }
  async restoreVersion() {}
  async restoreTrash(fileId:string) { const item = (await this.load()).trash?.find(candidate => candidate.kind === 'file' && candidate.id === fileId); if (!item) throw new Error('Synthetic file is not in Trash'); await this.restoreTrashItem(item) }

  submitOperation(request:FilesOperationRequest):Promise<FilesOperationReceipt> { return this.operations.submitOperation(request) }
  getOperation(operationId:string):Promise<FilesOperationReceipt> { return this.operations.getOperation(operationId) }
  cancelOperation(operationId:string):Promise<FilesOperationReceipt> { return this.operations.cancelOperation(operationId) }
  retryOperation(operationId:string, retry:FilesOperationRetry = {}):Promise<FilesOperationReceipt> { return this.operations.retryOperation(operationId, retry) }
  undoOperation(operationId:string):Promise<FilesOperationReceipt> { return this.operations.undoOperation(operationId) }
  restoreTrashItem(item:FilesTrashItem):Promise<FilesTrashRestoreResult> { return this.trash.restoreTrashItem(item) }
  purgeTrashItem(item:FilesTrashItem):Promise<FilesTrashPurgeResult> { return this.trash.purgeTrashItem(item) }
  trashFile(fileId:string):Promise<void> { return this.trash.trashFile(fileId) }
  purgeTrash(fileId:string):Promise<void> { return this.trash.purgeTrash(fileId) }
  createPublicLink(fileId:string, options:ShareLinkOptions):Promise<ShareLink> { return this.sharing.createPublicLink(fileId, options) }
  updatePublicLink(id:string, options:Partial<ShareLinkOptions>):Promise<ShareLink> { return this.sharing.updatePublicLink(id, options) }
  listPublicLinks():Promise<ShareLink[]> { return this.sharing.listPublicLinks() }
  revokePublicLink(id:string):Promise<void> { return this.sharing.revokePublicLink(id) }
  restorePublicLink(id:string, password?:string):Promise<ShareLink> { return this.sharing.restorePublicLink(id, password) }
  shareActivity():Promise<ShareActivity[]> { return this.sharing.shareActivity() }
  listFolderShares():Promise<FolderShare[]> { return this.sharing.listFolderShares() }
  shareFolder(collectionId:string, folderPath:string, principalType:SharePrincipalType, principalId:string, role:'view' | 'edit'):Promise<FolderShare> { return this.sharing.shareFolder(collectionId, folderPath, principalType, principalId, role) }
  unshareFolder(share:FolderShare):Promise<void> { return this.sharing.unshareFolder(share) }
  listFileShares(fileId:string):Promise<FileAccessList> { return this.sharing.listFileShares(fileId) }
  shareFile(fileId:string, principalType:SharePrincipalType, principalId:string, role:'view' | 'edit'):Promise<FileShare> { return this.sharing.shareFile(fileId, principalType, principalId, role) }
  updateFileShare(fileId:string, shareId:string, role:'view' | 'edit'):Promise<FileShare> { return this.sharing.updateFileShare(fileId, shareId, role) }
  unshareFile(fileId:string, shareId:string):Promise<void> { return this.sharing.unshareFile(fileId, shareId) }
  listMembers() { return this.sharing.listMembers() }
}
