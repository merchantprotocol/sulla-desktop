import type {
  FileAccessList, FilesDataSource, FilesDetail, FilesFolderState, FilesItem, FilesOperationItem,
  FilesOperationItemReceipt, FilesOperationReceipt, FilesOperationRequest, FilesOperationRetry,
  FilesOperationState, FilesPreview, FilesSnapshot, FilesVersion, FileShare, FolderShare,
  ShareActivity, ShareLink, ShareLinkOptions, SharePrincipalType,
} from './types';

/* eslint-disable @typescript-eslint/require-await -- the preview adapter intentionally implements the async production datasource contract in memory */

const now = Date.now();
const iso = (days = 0) => new Date(now + days * 86_400_000).toISOString();
const STORAGE_KEY = 'sulla:files:synthetic-receipt-preview:v1';
const clone = <T>(value:T):T => JSON.parse(JSON.stringify(value)) as T;

interface SyntheticFolder extends FilesFolderState { deletedAt?:string }
interface SyntheticCollection { id:string; name:string; home:string; files:FilesItem[]; folders:SyntheticFolder[] }
interface SyntheticMutation { before:SyntheticCollection[]; after:SyntheticCollection[]; fileIds:string[]; folderIds:string[] }
interface SyntheticOperation {
  request:FilesOperationRequest;
  fingerprint:string;
  receipt:FilesOperationReceipt;
  mutations:Record<string, SyntheticMutation>;
  retryOverrides:Record<string, NonNullable<FilesOperationRetry['items']>[number]>;
}
interface SyntheticState {
  revision:number;
  sequence:number;
  selectedCollectionId:string;
  collections:SyntheticCollection[];
  operations:Record<string, SyntheticOperation>;
  idempotency:Record<string, { fingerprint:string; operationId:string }>;
  stars:Record<string, string[]>;
}

/** Stateful synthetic fixtures for /files-preview. Never reads Files IPC or private files. */
export class SyntheticFilesDataSource implements FilesDataSource {
  readonly syntheticPreview = true;
  capabilities = {
    upload: false, versionHistory: true, restoreVersions: true, trash: true, orgSharing: true,
    publicLinks: true, onlineOnly: false, nativeFilesystem: false, durableOperations: true,
    folderReceipts: true, nativeFolderReceipts: false,
    folderCollisionPolicies: ['keep-both', 'skip'] as ('keep-both' | 'skip')[],
    crossCollectionOperations: 'stored-same-audience-files' as const,
  };
  onlineOnlyReason = 'Synthetic preview';
  private paused = false;
  private state:SyntheticState;
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private shares:ShareLink[] = [
    { id: 'share-capture', url: 'https://share.sulla.cloud/v/m3Xp9A', name: 'Screenshot 2026-10-16 at 11.17.02.png', mode: 'view', password: false, expiresAt: iso(30), viewCount: 0, keepAvailable: true, keepUntil: iso(30), displaySharerName: true, servedFrom: 'cloud', assetKind: 'capture', source: 'Copy on Sulla Cloud', createdAt: iso(-1) },
    { id: 'share-artifact', url: 'https://share.sulla.cloud/v/Tq8mWe', name: '03-share.html · Share dialog', mode: 'view', password: false, expiresAt: iso(13), viewCount: 7, lastViewedAt: iso(-1), keepAvailable: true, keepUntil: iso(2), displaySharerName: true, servedFrom: 'cloud', assetKind: 'artifact', source: 'Sulla-made › mockups', targetId: 'synthetic-file', createdAt: iso(-3) },
    { id: 'share-file', url: 'https://share.sulla.cloud/v/8kQ2vT', name: 'Vault phase 2 walkthrough.mp4', mode: 'view', password: true, expiresAt: iso(13), viewCount: 14, lastViewedAt: iso(-2), keepAvailable: false, displaySharerName: true, servedFrom: 'desktop', assetKind: 'file', source: 'This Mac · live', targetId: 'synthetic-file', targetType: 'file', collectionId: 'synthetic-collection', createdAt: iso(-8) },
    { id: 'share-revoked', url: 'https://share.sulla.cloud/v/Jd9xCp', name: 'Route settlement · week 41', mode: 'view', password: false, viewCount: 12, keepAvailable: false, displaySharerName: true, servedFrom: 'desktop', assetKind: 'artifact', source: 'This Mac', revokedAt: iso(-2), createdAt: iso(-12) },
  ];
  private folderShares:FolderShare[] = [];
  private fileShares:FileShare[] = [{ id: 'file-share-design', fileId: 'synthetic-video', principalType: 'group', principalId: 'design', principalName: 'Design', role: 'view' }];

  constructor() {
    this.state = this.restoreState() ?? this.initialState();
    Object.values(this.state.operations).filter(value => value.receipt.state === 'pending').forEach(value => this.schedule(value.receipt.operationId));
  }

  private initialState():SyntheticState {
    const primary:SyntheticCollection = {
      id: 'synthetic-collection', name: 'Files', home: 'preview',
      files: [
        this.file('synthetic-video', 'Projects/Alpha/demo-recording.mp4', 'video/mp4', 184_000_000, 'version-video', '1'),
        this.file('synthetic-notes', 'Projects/Alpha/meeting-notes.md', 'text/markdown', 12_400, 'version-notes', '2'),
        this.file('synthetic-image', 'Projects/Beta/architecture.png', 'image/png', 2_400_000, 'version-image', '3'),
        this.file('synthetic-data', 'Projects/Beta/sample-data.json', 'application/json', 8_800, 'version-data', '4'),
        this.file('synthetic-readme', 'Readme.md', 'text/markdown', 2_100, 'version-readme', '5'),
        this.file('synthetic-collision', 'Projects/Beta/meeting-notes.md', 'text/markdown', 9_600, 'version-collision', '6'),
      ],
      folders: [
        { folderId: 'synthetic-folder-projects', path: 'Projects', revision: '7' },
        { folderId: 'synthetic-folder-alpha', path: 'Projects/Alpha', revision: '8' },
        { folderId: 'synthetic-folder-beta', path: 'Projects/Beta', revision: '9' },
        { folderId: 'synthetic-folder-empty', path: 'Projects/Empty folder', revision: '10' },
      ],
    };
    const stored:SyntheticCollection = {
      id: 'synthetic-stored-collection', name: 'Stored review', home: 'stored-preview',
      files: [
        this.file('synthetic-stored-brief', 'Review/product-brief.md', 'text/markdown', 18_200, 'version-stored-brief', '11'),
        this.file('synthetic-stored-readme', 'Readme.md', 'text/markdown', 3_400, 'version-stored-readme', '12'),
      ],
      folders: [
        { folderId: 'synthetic-stored-review', path: 'Review', revision: '13' },
        { folderId: 'synthetic-stored-empty', path: 'Archive', revision: '14' },
      ],
    };

    return { revision: 14, sequence: 0, selectedCollectionId: primary.id, collections: [primary, stored], operations: {}, idempotency: {}, stars: {} };
  }

  private restoreState():SyntheticState | null {
    try {
      const raw = typeof sessionStorage === 'undefined' ? null : sessionStorage.getItem(STORAGE_KEY);
      const value = raw ? JSON.parse(raw) as SyntheticState : null;

      return value?.collections?.some(item => item.id === value.selectedCollectionId) && value.operations && value.idempotency ? value : null;
    } catch { return null }
  }
  private persist() {
    try { if (typeof sessionStorage !== 'undefined') sessionStorage.setItem(STORAGE_KEY, JSON.stringify(this.state)) }
    catch { /* In-memory behavior remains available if session storage is unavailable. */ }
  }
  private file(id:string, path:string, mime:string, size:number, currentVersionId:string, operationRevision:string):FilesItem {
    return { id, path, mime, size, updatedAt: iso(), currentVersionId, operationRevision, versionCount: 1, createdByType: 'user', createdById: 'synthetic-user', ownerDisplayName: 'Preview user', syncState: 'synced', indexStatus: 'indexed', indexReasonCode: 'synthetic_fixture', indexReason: 'Synthetic preview fixture.', indexedAt: iso() };
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
  private sameFileState(a?:FilesOperationState, b?:FilesOperationState) {
    return Boolean(a && b && a.collectionId === b.collectionId && a.fileId === b.fileId && a.path === b.path && a.versionId === b.versionId && a.revision === b.revision && a.deleted === b.deleted);
  }
  private sameFolderState(a?:FilesFolderState, b?:FilesFolderState) {
    return Boolean(a && b && a.folderId === b.folderId && a.path === b.path && a.revision === b.revision);
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
      collection: { id: collection.id, name: collection.name, home: collection.home, orgId: 'synthetic-org', retentionPolicy: {}, storageQuota: 10_000_000_000, keptBytes: active.reduce((sum, file) => sum + file.size, 0), desktopCount: 0, memberCount: 2, accountName: 'Preview user', accountRole: 'owner', ownerUserId: 'synthetic-user' },
      availableCollections: this.state.collections.map(item => ({ id: item.id, name: item.name })),
      folders: collection.folders.filter(folder => !folder.deletedAt).map(folder => ({ folderId: folder.folderId, path: folder.path, revision: folder.revision })),
      files: collection.files.map(file => ({ ...file })),
      status: { state: this.paused ? 'paused' : 'synced', pendingFiles: 0, lastSyncAt: iso(), serverConfigured: true, location: 'server', serverLabel: 'Synthetic stored preview', indexing: { total: active.length, pending: 0, indexing: 0, indexed, partial: 0, unsupported: 0, failed: 0, complete: indexed === active.length } },
    };
  }
  selectCollection(collectionId:string) { this.collection(collectionId); this.state.selectedCollectionId = collectionId; this.persist() }
  async history(fileId:string, currentVersionId:string):Promise<FilesVersion[]> { return Array.from({ length: 7 }, (_, index) => ({ id: index === 0 ? currentVersionId : fileId + '-version-' + (7 - index), size: 184_000_000 + index * 300_000, deleted: false, created_by_type: index ? 'user' : 'agent-run', created_by_id: index ? 'Jonathon' : 'heartbeat run #4,112', created_at: iso(-index / 24), message: index ? ['Trimmed last 12 seconds', 'Camera bubble moved to corner', 'Uploaded from tray'][index - 1] || 'Recording updated' : 'Transcript added', device_id: index ? 'Mac Studio' : 'heartbeat run #4,112', current: index === 0 })) }
  async preview():Promise<FilesPreview> { return { data: new TextEncoder().encode('<h1>Synthetic Files preview</h1>'), mime: 'text/html', path: 'Sulla-made/mockups/03-share.html' } }
  async detail(fileId = 'synthetic-video'):Promise<FilesDetail> { const file = this.state.collections.flatMap(item => item.files).find(item => item.id === fileId) ?? this.currentCollection().files[0]; return { item: file, capabilities: { canEdit: true, canManage: true, canViewDraft: true, canPublish: true }, provenance: { type: 'synthetic-preview', id: 'fixture' }, version: (await this.history(file.id, file.currentVersionId))[0], recording: file.mime.startsWith('video/') ? { version_id: file.currentVersionId, language: 'en', generator: 'synthetic fixture', duration_seconds: 42, generated_at: iso(), transcript: [{ start: 0, end: 8, text: 'Synthetic Files preview fixture.' }], chapters: [{ start: 0, end: 42, title: 'Preview fixture' }] } : undefined, links: [], activity: [], access: { role: 'owner', inherited: [] } } }
  async mediaUrl(fileId:string):Promise<string> { const file = this.state.collections.flatMap(item => item.files).find(item => item.id === fileId); if (file?.mime !== 'image/png') return ''; const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="700"><rect width="1200" height="700" fill="#152536"/><path d="M130 520 390 280l150 140 150-190 380 290H130Z" fill="#5096b3"/><circle cx="900" cy="220" r="72" fill="#a5d8e8"/></svg>'; return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg) }
  async search(query:string) { const files = (await this.load()).files.filter(file => !file.deletedAt && file.path.toLowerCase().includes(query.toLowerCase())); return { files, coverage: { total: files.length, pending: 0, indexing: 0, indexed: files.length, partial: 0, unsupported: 0, failed: 0, complete: true } } }
  async reindex() {}
  async setPaused(paused:boolean) { this.paused = paused; return (await this.load()).status }
  async chooseUpload(_destination = '') { return 0 }
  async uploadPaths(_paths:string[], _destination = '') { return 0 }
  async createFolder(path:string) { const collection = this.currentCollection(); const value = this.normalizePath(path); if (!this.activeFileAt(collection, value) && !this.activeFolderAt(collection, value)) collection.folders.push({ folderId: this.nextId('synthetic-folder'), path: value, revision: this.nextRevision() }); this.persist() }
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

      return { itemId: crypto.randomUUID(), action, kind: item.folderPath ? 'folder' : 'file', ...item, ...(file ? { expectedVersionId: file.currentVersionId, expectedRevision: file.operationRevision } : {}), ...(folder ? { expectedFolder: clone(folder) } : {}) };
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

    for (const id of ids) {
      const receipt = operation.receipt.items.find(item => item.itemId === id); const override = retry.items?.find(item => item.itemId === id);

      if (!receipt || !receipt.retryable || !['failed', 'cancelled'].includes(receipt.state)) throw new Error('Only retryable failed or cancelled synthetic items can be retried');
      if (override?.collisionPolicy === 'replace' && (!receipt.error?.destination || !override.expectedDestination || !this.sameFileState(receipt.error.destination, override.expectedDestination))) throw new Error('Replace requires the exact displayed synthetic destination snapshot');
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
        item.error = { status: 409, code: 'state-conflict', message: 'Synthetic undo was blocked because the current revision changed.' }; item.undoSupported = false;
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
    const before = clone(this.state.collections); const receiptId = crypto.randomUUID();

    try {
      const override = operation.retryOverrides[item.itemId]; const policy = override?.collisionPolicy ?? item.collisionPolicy; const collection = this.collection(operation.request.collectionId);

      if (item.action === 'create-folder') this.executeCreateFolder(collection, item, receipt, receiptId, policy);
      else if (item.kind === 'folder' || item.folderPath) this.executeFolder(collection, item, receipt, receiptId, policy);
      else this.executeFile(collection, item, receipt, receiptId, policy, override?.expectedDestination ?? item.expectedDestination);
      if (receipt.state === 'completed') operation.mutations[item.itemId] = this.captureMutation(before, this.state.collections);
    } catch (cause) {
      const error = cause as { status?:number; code?:string; message?:string; destination?:FilesOperationState };

      Object.assign(receipt, { state: 'failed', receiptId: null, error: { status: error.status ?? 409, code: error.code ?? 'state-conflict', message: error.message ?? String(cause), ...(error.destination ? { destination: error.destination } : {}) }, retryable: true, undoSupported: false });
    }
  }
  private resolveDestination(collection:SyntheticCollection, requested:string, policy:FilesOperationItem['collisionPolicy'], receipt:FilesOperationItemReceipt, ignoredFiles = new Set<string>(), ignoredFolders = new Set<string>(), expected?:FilesOperationState) {
    const file = this.activeFileAt(collection, requested, ignoredFiles); const folder = this.activeFolderAt(collection, requested, ignoredFolders);

    if (!file && !folder) return { path: requested };
    if (policy === 'skip') { Object.assign(receipt, { state: 'skipped', receiptId: crypto.randomUUID(), error: null, retryable: false }); return null }
    if (policy === 'keep-both') return { path: this.keepBothPath(collection, requested, ignoredFiles, ignoredFolders) };
    const destination = file ? this.fileState(file, collection.id) : undefined;

    if (policy !== 'replace') throw { status: 409, code: 'destination-conflict', message: 'A synthetic item already exists at ' + requested + '.', ...(destination ? { destination } : {}) };
    if (!file || !expected || !this.sameFileState(destination, expected)) throw { status: 409, code: 'destination-conflict', message: 'Replace requires the current authorized synthetic destination snapshot.', ...(destination ? { destination } : {}) };
    return { path: requested, displaced: file, displacedBefore: destination };
  }
  private executeFile(source:SyntheticCollection, item:FilesOperationItem, receipt:FilesOperationItemReceipt, receiptId:string, policy?:FilesOperationItem['collisionPolicy'], expectedDestination?:FilesOperationState) {
    const file = source.files.find(candidate => candidate.id === item.fileId && !candidate.deletedAt);

    if (!file) throw { code: 'state-conflict', message: 'Synthetic source file is no longer available.' };
    const before = this.fileState(file, source.id);
    if (before.versionId !== item.expectedVersionId || before.revision !== item.expectedRevision) throw { code: 'state-conflict', message: 'Synthetic source version or revision changed.' };
    receipt.before = clone(before); receipt.receiptId = receiptId;
    if (item.action === 'trash') {
      file.deletedAt = new Date().toISOString(); file.updatedAt = file.deletedAt; file.operationRevision = this.nextRevision();
      Object.assign(receipt, { after: this.fileState(file, source.id), state: 'completed', undoSupported: true, retryable: false });
      return;
    }
    if (!item.targetPath) throw { status: 400, code: 'invalid-operation', message: 'Synthetic destination path is required.' };
    const targetCollection = this.collection(item.targetCollectionId ?? source.id);
    if (item.targetCollectionId && policy === 'replace') throw { status: 422, code: 'cross-collection-replace-unavailable', message: 'Synthetic cross-collection Replace is unavailable.' };
    const target = this.resolveDestination(targetCollection, this.normalizePath(item.targetPath), policy, receipt, new Set<string>(item.action === 'move' ? [file.id] : []), new Set<string>(), expectedDestination);
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
  private executeFolder(collection:SyntheticCollection, item:FilesOperationItem, receipt:FilesOperationItemReceipt, receiptId:string, policy?:FilesOperationItem['collisionPolicy']) {
    const sourcePath = this.normalizePath(item.folderPath ?? ''); const folder = collection.folders.find(candidate => !candidate.deletedAt && candidate.path === sourcePath);

    if (!folder || item.expectedFolder && !this.sameFolderState(folder, item.expectedFolder)) throw { code: 'state-conflict', message: 'Synthetic folder or revision changed.' };
    receipt.before = { folderId: folder.folderId, path: folder.path, revision: folder.revision }; receipt.receiptId = receiptId;
    const files = collection.files.filter(file => !file.deletedAt && file.path.startsWith(sourcePath + '/')); const folders = collection.folders.filter(candidate => !candidate.deletedAt && (candidate.path === sourcePath || candidate.path.startsWith(sourcePath + '/')));
    if (item.action === 'trash') {
      const deletedAt = new Date().toISOString();

      files.forEach(file => { file.deletedAt = deletedAt; file.operationRevision = this.nextRevision(); file.updatedAt = deletedAt });
      folders.forEach(candidate => { candidate.deletedAt = deletedAt; candidate.revision = this.nextRevision() }); receipt.after = null;
    } else {
      if (!item.targetPath) throw { status: 400, code: 'invalid-operation', message: 'Synthetic folder destination is required.' };
      if (policy === 'replace') throw { status: 422, code: 'folder-replace-unavailable', message: 'Synthetic folders support Keep Both or Skip, not Replace.' };
      const ignoredFiles = new Set(files.map(file => file.id)); const ignoredFolders = new Set(folders.map(value => value.folderId));
      const target = this.resolveDestination(collection, this.normalizePath(item.targetPath), policy, receipt, item.action === 'move' ? ignoredFiles : new Set<string>(), item.action === 'move' ? ignoredFolders : new Set<string>());
      if (!target) return;
      const mappedFiles = files.map(file => ({ file, path: target.path + file.path.slice(sourcePath.length) })); const mappedFolders = folders.map(value => ({ folder: value, path: target.path + value.path.slice(sourcePath.length) }));
      const conflict = mappedFiles.find(value => this.activeFileAt(collection, value.path, ignoredFiles) || this.activeFolderAt(collection, value.path, ignoredFolders)) ?? mappedFolders.find(value => this.activeFileAt(collection, value.path, ignoredFiles) || this.activeFolderAt(collection, value.path, ignoredFolders));

      if (conflict) throw { code: 'destination-conflict', message: 'A synthetic descendant already exists at ' + conflict.path + '.' };
      if (item.action === 'copy') {
        mappedFolders.forEach(value => collection.folders.push({ folderId: this.nextId('synthetic-folder-copy'), path: value.path, revision: this.nextRevision() }));
        mappedFiles.forEach(value => collection.files.push({ ...clone(value.file), id: this.nextId('synthetic-copy'), path: value.path, currentVersionId: this.nextId('version-copy'), operationRevision: this.nextRevision(), updatedAt: new Date().toISOString() }));
        const copied = collection.folders.find(value => value.path === target.path)!; receipt.after = clone(copied);
      } else {
        mappedFolders.forEach(value => { value.folder.path = value.path; value.folder.revision = this.nextRevision() });
        mappedFiles.forEach(value => { value.file.path = value.path; value.file.operationRevision = this.nextRevision(); value.file.updatedAt = new Date().toISOString() });
        receipt.after = { folderId: folder.folderId, path: folder.path, revision: folder.revision };
      }
    }
    Object.assign(receipt, { state: 'completed', error: null, undoSupported: true, retryable: false });
  }

  private captureMutation(before:SyntheticCollection[], after:SyntheticCollection[]):SyntheticMutation {
    const beforeFiles = new Map(before.flatMap(collection => collection.files.map(file => [file.id, JSON.stringify(file)] as const))); const afterFiles = new Map(after.flatMap(collection => collection.files.map(file => [file.id, JSON.stringify(file)] as const))); const beforeFolders = new Map(before.flatMap(collection => collection.folders.map(folder => [folder.folderId, JSON.stringify(folder)] as const))); const afterFolders = new Map(after.flatMap(collection => collection.folders.map(folder => [folder.folderId, JSON.stringify(folder)] as const)));

    return { before: clone(before), after: clone(after), fileIds: [...new Set([...beforeFiles.keys(), ...afterFiles.keys()])].filter(id => beforeFiles.get(id) !== afterFiles.get(id)), folderIds: [...new Set([...beforeFolders.keys(), ...afterFolders.keys()])].filter(id => beforeFolders.get(id) !== afterFolders.get(id)) };
  }
  private mutationMatches(mutation:SyntheticMutation, side:'before' | 'after') {
    const snapshot = mutation[side];

    return mutation.fileIds.every(id => JSON.stringify(this.state.collections.flatMap(collection => collection.files).find(file => file.id === id)) === JSON.stringify(snapshot.flatMap(collection => collection.files).find(file => file.id === id))) &&
      mutation.folderIds.every(id => JSON.stringify(this.state.collections.flatMap(collection => collection.folders).find(folder => folder.folderId === id)) === JSON.stringify(snapshot.flatMap(collection => collection.folders).find(folder => folder.folderId === id)));
  }
  private applyMutation(mutation:SyntheticMutation, side:'before' | 'after') {
    for (const collection of this.state.collections) { collection.files = collection.files.filter(file => !mutation.fileIds.includes(file.id)); collection.folders = collection.folders.filter(folder => !mutation.folderIds.includes(folder.folderId)) }
    for (const saved of mutation[side]) {
      const collection = this.collection(saved.id);

      collection.files.push(...clone(saved.files.filter(file => mutation.fileIds.includes(file.id))));
      collection.folders.push(...clone(saved.folders.filter(folder => mutation.folderIds.includes(folder.folderId))));
    }
  }
  private refreshReceipt(operation:SyntheticOperation) {
    const items = operation.receipt.items; const pending = items.some(item => item.state === 'pending'); const completed = items.some(item => item.state === 'completed'); const failed = items.some(item => item.state === 'failed'); const cancelled = items.some(item => item.state === 'cancelled'); const undone = items.some(item => item.state === 'undone'); const undoConflict = items.some(item => item.state === 'completed' && item.error?.code === 'state-conflict' && !item.undoSupported);

    operation.receipt.state = pending ? 'pending' : undone && !completed ? 'undone' : failed && !completed && !cancelled ? 'failed' : cancelled && !completed && !failed ? 'cancelled' : failed || cancelled || undone && completed || undoConflict ? 'partial' : 'completed';
    operation.receipt.undoSupported = !pending && items.some(item => item.state === 'completed' && item.undoSupported);
    operation.receipt.retryable = !pending && items.some(item => ['failed', 'cancelled'].includes(item.state) && item.retryable);
    operation.receipt.updatedAt = new Date().toISOString();
  }

  async restoreVersion() {}
  async restoreTrash(fileId:string) { const file = this.currentCollection().files.find(item => item.id === fileId); if (!file?.deletedAt) throw new Error('Synthetic file is not in Trash'); file.deletedAt = undefined; file.updatedAt = new Date().toISOString(); file.operationRevision = this.nextRevision(); this.persist() }
  async trashFile(fileId:string) { const file = this.currentCollection().files.find(item => item.id === fileId && !item.deletedAt); if (!file) throw new Error('Synthetic file is no longer available'); file.deletedAt = new Date().toISOString(); file.operationRevision = this.nextRevision(); this.persist() }
  async purgeTrash(fileId:string) { const collection = this.currentCollection(); const file = collection.files.find(item => item.id === fileId && item.deletedAt); if (!file) throw new Error('Synthetic file is not in Trash'); collection.files = collection.files.filter(item => item.id !== fileId); this.persist() }
  async createPublicLink(fileId:string, options:ShareLinkOptions) { const share:ShareLink = { id: 'share-' + fileId, url: 'https://share.sulla.cloud/v/Synthetic', name: '03-share.html · Share dialog', password: Boolean(options.password), expiresAt: options.expiresAt ?? undefined, viewCount: 0, keepAvailable: options.keepAvailable, keepUntil: options.keepUntil ?? undefined, displaySharerName: options.displaySharerName, servedFrom: options.keepAvailable ? 'cloud' : 'desktop', assetKind: options.assetKind ?? 'artifact', mode: options.mode, source: 'Sulla-made › mockups', targetId: fileId, targetType: 'file', collectionId: this.state.selectedCollectionId, createdAt: iso() }; this.shares.unshift(share); return share }
  async updatePublicLink(id:string, options:Partial<ShareLinkOptions>) { const share = this.shares.find(item => item.id === id); if (!share) throw new Error('Synthetic link not found'); Object.assign(share, options, { password: options.password === undefined ? share.password : Boolean(options.password), servedFrom: options.keepAvailable ? 'cloud' : share.servedFrom }); return share }
  async listPublicLinks() { return this.shares.map(item => ({ ...item })) }
  async revokePublicLink(id:string) { const share = this.shares.find(item => item.id === id); if (share) share.revokedAt = iso() }
  async restorePublicLink(id:string, password?:string) { const share = this.shares.find(item => item.id === id); if (!share) throw new Error('Synthetic link not found'); if (share.password && (!password || password.length < 8)) throw new Error('Re-enter the synthetic link password'); share.revokedAt = undefined; return share }
  async shareActivity():Promise<ShareActivity[]> { return [{ id: 'event-1', action: 'viewed', occurredAt: iso(-1), detail: '03-share.html' }, { id: 'event-2', action: 'downloaded', occurredAt: iso(-2), detail: 'Vault phase 2 walkthrough.mp4' }] }
  async listFolderShares() { return this.folderShares }
  async shareFolder(collectionId:string, folderPath:string, principalType:SharePrincipalType, principalId:string, role:'view' | 'edit') { const share = { id: principalType + ':' + principalId, collectionId, folderPath, principalType, principalId, role }; this.folderShares.push(share); return share }
  async unshareFolder(share:FolderShare) { this.folderShares = this.folderShares.filter(item => item.id !== share.id) }
  async listFileShares(fileId:string):Promise<FileAccessList> { return { ownerId: 'synthetic-owner', direct: this.fileShares.filter(item => item.fileId === fileId).map(item => ({ ...item })), inherited: this.folderShares.map(item => ({ ...item, id: item.id ?? ['folder', item.folderPath, item.principalType, item.principalId].join(':'), source: 'folder' as const })) } }
  async shareFile(fileId:string, principalType:SharePrincipalType, principalId:string, role:'view' | 'edit') { const existing = this.fileShares.find(item => item.fileId === fileId && item.principalType === principalType && item.principalId === principalId); if (existing) { existing.role = role; return { ...existing } } const share:FileShare = { id: ['file', fileId, principalType, principalId].join(':'), fileId, principalType, principalId, role }; this.fileShares.push(share); return { ...share } }
  async updateFileShare(fileId:string, shareId:string, role:'view' | 'edit') { const share = this.fileShares.find(item => item.fileId === fileId && item.id === shareId); if (!share) throw new Error('Synthetic file share not found'); share.role = role; return { ...share } }
  async unshareFile(fileId:string, shareId:string) { this.fileShares = this.fileShares.filter(item => item.fileId !== fileId || item.id !== shareId) }
  async listMembers() { return { members: [{ id: 'synthetic-owner', email: 'jonathon@example.test', role: 'owner' }, { id: 'maya', email: 'maya@example.test', role: 'member' }], groups: [{ id: 'design', name: 'Design', members: ['maya'] }] } }
}
