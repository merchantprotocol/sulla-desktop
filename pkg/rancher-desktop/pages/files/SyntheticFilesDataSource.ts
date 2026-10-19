import type { FileAccessList, FilesDataSource, FilesDetail, FileShare, FilesItem, FilesPreview, FilesSnapshot, FilesVersion, FolderShare, ShareActivity, ShareLink, ShareLinkOptions, SharePrincipalType } from './types';

/* eslint-disable @typescript-eslint/require-await -- the preview adapter intentionally implements the async production datasource contract in memory */

const now = Date.now();
const iso = (days = 0) => new Date(now + days * 86_400_000).toISOString();

/** In-memory fixtures for the isolated /files-preview route. Never reads Files IPC. */
export class SyntheticFilesDataSource implements FilesDataSource {
  readonly syntheticPreview = true;
  capabilities = { upload: false, versionHistory: true, restoreVersions: true, trash: true, orgSharing: true, publicLinks: true, onlineOnly: false, nativeFilesystem: false };
  onlineOnlyReason = 'Synthetic preview';
  private paused = false;
  private copySequence = 0;
  private stars = new Set<string>();
  private files:FilesItem[] = [
    this.file('synthetic-video', 'Projects/Alpha/demo-recording.mp4', 'video/mp4', 184_000_000, 'version-video'),
    this.file('synthetic-notes', 'Projects/Alpha/meeting-notes.md', 'text/markdown', 12_400, 'version-notes'),
    this.file('synthetic-image', 'Projects/Beta/architecture.png', 'image/png', 2_400_000, 'version-image'),
    this.file('synthetic-data', 'Projects/Beta/sample-data.json', 'application/json', 8_800, 'version-data'),
    this.file('synthetic-readme', 'Readme.md', 'text/markdown', 2_100, 'version-readme'),
  ];

  private file(id:string, path:string, mime:string, size:number, versionId:string):FilesItem {
    return { id, path, mime, size, updatedAt: iso(0), currentVersionId: versionId, versionCount: 1, createdByType: 'user', createdById: 'synthetic-user', ownerDisplayName: 'Preview user', syncState: 'synced', indexStatus: 'indexed', indexReasonCode: 'synthetic_fixture', indexReason: 'Synthetic preview fixture.', indexedAt: iso(0) };
  }

  private shares:ShareLink[] = [
    { id: 'share-capture', url: 'https://share.sulla.cloud/v/m3Xp9A', name: 'Screenshot 2026-10-16 at 11.17.02.png', mode: 'view', password: false, expiresAt: iso(30), viewCount: 0, keepAvailable: true, keepUntil: iso(30), displaySharerName: true, servedFrom: 'cloud', assetKind: 'capture', source: 'Copy on Sulla Cloud', createdAt: iso(-1) },
    { id: 'share-artifact', url: 'https://share.sulla.cloud/v/Tq8mWe', name: '03-share.html · Share dialog', mode: 'view', password: false, expiresAt: iso(13), viewCount: 7, lastViewedAt: iso(-1), keepAvailable: true, keepUntil: iso(2), displaySharerName: true, servedFrom: 'cloud', assetKind: 'artifact', source: 'Sulla-made › mockups', targetId: 'synthetic-file', createdAt: iso(-3) },
    { id: 'share-file', url: 'https://share.sulla.cloud/v/8kQ2vT', name: 'Vault phase 2 walkthrough.mp4', mode: 'view', password: true, expiresAt: iso(13), viewCount: 14, lastViewedAt: iso(-2), keepAvailable: false, displaySharerName: true, servedFrom: 'desktop', assetKind: 'file', source: 'This Mac · live', targetId: 'synthetic-file', targetType: 'file', collectionId: 'synthetic-collection', createdAt: iso(-8) },
    { id: 'share-revoked', url: 'https://share.sulla.cloud/v/Jd9xCp', name: 'Route settlement · week 41', mode: 'view', password: false, viewCount: 12, keepAvailable: false, displaySharerName: true, servedFrom: 'desktop', assetKind: 'artifact', source: 'This Mac', revokedAt: iso(-2), createdAt: iso(-12) },
  ];

  private folderShares:FolderShare[] = [];
  private fileShares:FileShare[] = [
    { id: 'file-share-design', fileId: 'synthetic-video', principalType: 'group', principalId: 'design', principalName: 'Design', role: 'view' },
  ];

  async load():Promise<FilesSnapshot> {
    const active = this.files.filter(file => !file.deletedAt);
    const indexed = active.filter(file => file.indexStatus === 'indexed').length;

    return {
      collection: { id: 'synthetic-collection', name: 'Files', home: 'preview', orgId: 'synthetic-org', retentionPolicy: {}, storageQuota: 10_000_000_000, keptBytes: active.reduce((sum, file) => sum + file.size, 0), desktopCount: 0, memberCount: 2, accountName: 'Preview user', accountRole: 'owner', ownerUserId: 'synthetic-user' },
      files: this.files.map(file => ({ ...file })),
      status: { state: this.paused ? 'paused' : 'synced', pendingFiles: 0, lastSyncAt: iso(0), serverConfigured: false, location: 'local', serverLabel: 'Synthetic preview', indexing: { total: active.length, pending: 0, indexing: 0, indexed, partial: 0, unsupported: 0, failed: 0, complete: indexed === active.length } },
    };
  }
  async history():Promise<FilesVersion[]> { return Array.from({ length: 7 }, (_, index) => ({ id: `version-${ 7 - index }`, size: 184_000_000 + index * 300_000, deleted: false, created_by_type: index ? 'user' : 'agent-run', created_by_id: index ? 'Jonathon' : 'heartbeat run #4,112', created_at: iso(-index / 24), message: index ? ['Trimmed last 12 seconds', 'Camera bubble moved to corner', 'Uploaded from tray'][index - 1] || 'Recording updated' : 'Transcript added', device_id: index ? 'Mac Studio' : 'heartbeat run #4,112', current: index === 0 })) }
  async preview():Promise<FilesPreview> { return { data: new TextEncoder().encode('<h1>Synthetic Files preview</h1>'), mime: 'text/html', path: 'Sulla-made/mockups/03-share.html' } }
  async detail(fileId = 'synthetic-video'):Promise<FilesDetail> { const file = this.files.find(item => item.id === fileId) ?? this.files[0]; return { item: file, capabilities: { canEdit: true, canManage: true, canViewDraft: true, canPublish: true }, provenance: { type: 'synthetic-preview', id: 'fixture' }, version: (await this.history(file.id, file.currentVersionId))[0], recording: file.mime.startsWith('video/') ? { version_id: file.currentVersionId, language: 'en', generator: 'synthetic fixture', duration_seconds: 42, generated_at: iso(0), transcript: [{ start: 0, end: 8, text: 'Synthetic Files preview fixture.' }], chapters: [{ start: 0, end: 42, title: 'Preview fixture' }] } : undefined, links: [], activity: [], access: { role: 'owner', inherited: [] } } }
  async mediaUrl():Promise<string> { return '' }
  async search(query:string) { const files = (await this.load()).files.filter(file => !file.deletedAt && file.path.toLowerCase().includes(query.toLowerCase())); return { files, coverage: { total: files.length, pending: 0, indexing: 0, indexed: files.length, partial: 0, unsupported: 0, failed: 0, complete: true } } }
  async reindex() {}
  async setPaused(paused:boolean) { this.paused = paused; return (await this.load()).status }
  async chooseUpload(_destination = '') { return 0 }
  async uploadPaths(_paths:string[], _destination = '') { return 0 }
  async createFolder(path:string) { const marker = `${ path.replace(/\/$/, '') }/.preview-placeholder`; if (!this.files.some(file => file.path === marker)) this.files.push(this.file(`synthetic-folder-${ ++this.copySequence }`, marker, 'application/octet-stream', 0, `version-folder-${ this.copySequence }`)); }
  async openFolder() {}
  async openFile() {}
  async downloadFile() { return false }
  async downloadFiles() { return { count: 0, error: 'Downloads are unavailable in the synthetic preview.' } }
  async listStars() { return [...this.stars].map(key => key.startsWith('folder:') ? { folderPath: key.slice('folder:'.length) } : { fileId: key }) }
  async setStar(_collectionId:string, target:{ fileId?:string; folderPath?:string }, starred:boolean) { const key = target.fileId ?? `folder:${ target.folderPath }`; starred ? this.stars.add(key) : this.stars.delete(key); }
  async operate(action:'move' | 'copy', _collectionId:string, items:{ fileId?:string; folderPath?:string; targetPath:string }[]) {
    const sourceFiles = items.flatMap(item => item.fileId ? this.files.filter(file => file.id === item.fileId && !file.deletedAt).map(file => ({ file, relative: '' })) : this.files.filter(file => !file.deletedAt && file.path.startsWith(`${ item.folderPath }/`)).map(file => ({ file, relative: file.path.slice(item.folderPath!.length + 1) })));
    if (!sourceFiles.length) throw new Error('Synthetic source is no longer available');
    const destinations = sourceFiles.map(({ file, relative }) => ({ file, path: [items.find(item => item.fileId === file.id)?.targetPath ?? items.find(item => item.folderPath && file.path.startsWith(`${ item.folderPath }/`))?.targetPath, relative].filter(Boolean).join('/') }));
    if (destinations.some(({ path }) => this.files.some(file => !file.deletedAt && file.path === path))) throw new Error('Synthetic preview collision: choose another destination');
    if (action === 'move') destinations.forEach(({ file, path }) => { file.path = path; file.updatedAt = iso(0); });
    else destinations.forEach(({ file, path }) => this.files.push({ ...file, id: `${ file.id }-copy-${ ++this.copySequence }`, path, currentVersionId: `version-copy-${ this.copySequence }`, updatedAt: iso(0) }));
  }
  async restoreVersion() {}
  async restoreTrash(fileId:string) { const file = this.files.find(item => item.id === fileId); if (!file?.deletedAt) throw new Error('Synthetic file is not in Trash'); file.deletedAt = undefined; file.updatedAt = iso(0); }
  async trashFile(fileId:string) { const file = this.files.find(item => item.id === fileId && !item.deletedAt); if (!file) throw new Error('Synthetic file is no longer available'); file.deletedAt = iso(0); }
  async createPublicLink(fileId:string, options:ShareLinkOptions) { const share:ShareLink = { id: `share-${ fileId }`, url: 'https://share.sulla.cloud/v/Synthetic', name: '03-share.html · Share dialog', password: Boolean(options.password), expiresAt: options.expiresAt ?? undefined, viewCount: 0, keepAvailable: options.keepAvailable, keepUntil: options.keepUntil ?? undefined, displaySharerName: options.displaySharerName, servedFrom: options.keepAvailable ? 'cloud' : 'desktop', assetKind: options.assetKind ?? 'artifact', mode: options.mode, source: 'Sulla-made › mockups', targetId: fileId, targetType: 'file', collectionId: 'synthetic-collection', createdAt: iso(0) }; this.shares.unshift(share); return share }
  async updatePublicLink(id:string, options:Partial<ShareLinkOptions>) { const share = this.shares.find(item => item.id === id); if (!share) throw new Error('Synthetic link not found'); Object.assign(share, options, { password: options.password === undefined ? share.password : Boolean(options.password), servedFrom: options.keepAvailable ? 'cloud' : share.servedFrom }); return share }
  async listPublicLinks() { return this.shares.map(item => ({ ...item })) }
  async revokePublicLink(id:string) { const share = this.shares.find(item => item.id === id); if (share) share.revokedAt = iso(0); }
  async restorePublicLink(id:string, password?:string) { const share = this.shares.find(item => item.id === id); if (!share) throw new Error('Synthetic link not found'); if (share.password && (!password || password.length < 8)) throw new Error('Re-enter the synthetic link password'); share.revokedAt = undefined; return share }
  async shareActivity():Promise<ShareActivity[]> { return [{ id: 'event-1', action: 'viewed', occurredAt: iso(-1), detail: '03-share.html' }, { id: 'event-2', action: 'downloaded', occurredAt: iso(-2), detail: 'Vault phase 2 walkthrough.mp4' }] }
  async listFolderShares() { return this.folderShares }
  async shareFolder(collectionId:string, folderPath:string, principalType:SharePrincipalType, principalId:string, role:'view' | 'edit') { const share = { id: `${ principalType }:${ principalId }`, collectionId, folderPath, principalType, principalId, role }; this.folderShares.push(share); return share }
  async unshareFolder(share:FolderShare) { this.folderShares = this.folderShares.filter(item => item.id !== share.id) }
  async listFileShares(fileId:string):Promise<FileAccessList> { return { ownerId: 'synthetic-owner', direct: this.fileShares.filter(item => item.fileId === fileId).map(item => ({ ...item })), inherited: this.folderShares.map(item => ({ ...item, id: item.id ?? `folder:${ item.folderPath }:${ item.principalType }:${ item.principalId }`, source: 'folder' as const })) } }
  async shareFile(fileId:string, principalType:SharePrincipalType, principalId:string, role:'view' | 'edit') { const existing = this.fileShares.find(item => item.fileId === fileId && item.principalType === principalType && item.principalId === principalId); if (existing) { existing.role = role; return { ...existing } } const share:FileShare = { id: `file:${ fileId }:${ principalType }:${ principalId }`, fileId, principalType, principalId, role }; this.fileShares.push(share); return { ...share } }
  async updateFileShare(fileId:string, shareId:string, role:'view' | 'edit') { const share = this.fileShares.find(item => item.fileId === fileId && item.id === shareId); if (!share) throw new Error('Synthetic file share not found'); share.role = role; return { ...share } }
  async unshareFile(fileId:string, shareId:string) { this.fileShares = this.fileShares.filter(item => item.fileId !== fileId || item.id !== shareId) }
  async listMembers() { return { members: [{ id: 'synthetic-owner', email: 'jonathon@example.test', role: 'owner' }, { id: 'maya', email: 'maya@example.test', role: 'member' }], groups: [{ id: 'design', name: 'Design', members: ['maya'] }] } }
}
