import type { FileAccessList, FilesDataSource, FilesDetail, FileShare, FilesPreview, FilesSnapshot, FilesVersion, FolderShare, ShareActivity, ShareLink, ShareLinkOptions, SharePrincipalType } from './types';

/* eslint-disable @typescript-eslint/require-await -- the preview adapter intentionally implements the async production datasource contract in memory */

const now = Date.now();
const iso = (days = 0) => new Date(now + days * 86_400_000).toISOString();

/** In-memory fixtures for the isolated /files-preview route. Never reads Files IPC. */
export class SyntheticFilesDataSource implements FilesDataSource {
  readonly syntheticPreview = true;
  capabilities = { upload: true, versionHistory: true, restoreVersions: true, trash: true, orgSharing: true, publicLinks: true, onlineOnly: false, nativeFilesystem: true };
  onlineOnlyReason = 'Synthetic preview';
  private shares:ShareLink[] = [
    { id: 'share-capture', url: 'https://share.sulla.cloud/v/m3Xp9A', name: 'Screenshot 2026-10-16 at 11.17.02.png', mode: 'view', password: false, expiresAt: iso(30), viewCount: 0, keepAvailable: true, keepUntil: iso(30), displaySharerName: true, servedFrom: 'cloud', assetKind: 'capture', source: 'Copy on Sulla Cloud', createdAt: iso(-1) },
    { id: 'share-artifact', url: 'https://share.sulla.cloud/v/Tq8mWe', name: '03-share.html · Share dialog', mode: 'view', password: false, expiresAt: iso(13), viewCount: 7, lastViewedAt: iso(-1), keepAvailable: true, keepUntil: iso(2), displaySharerName: true, servedFrom: 'cloud', assetKind: 'artifact', source: 'Sulla-made › mockups', targetId: 'synthetic-file', createdAt: iso(-3) },
    { id: 'share-file', url: 'https://share.sulla.cloud/v/8kQ2vT', name: 'Vault phase 2 walkthrough.mp4', mode: 'view', password: true, expiresAt: iso(13), viewCount: 14, lastViewedAt: iso(-2), keepAvailable: false, displaySharerName: true, servedFrom: 'desktop', assetKind: 'file', source: 'This Mac · live', targetId: 'synthetic-file', targetType: 'file', collectionId: 'synthetic-collection', createdAt: iso(-8) },
    { id: 'share-revoked', url: 'https://share.sulla.cloud/v/Jd9xCp', name: 'Route settlement · week 41', mode: 'view', password: false, viewCount: 12, keepAvailable: false, displaySharerName: true, servedFrom: 'desktop', assetKind: 'artifact', source: 'This Mac', revokedAt: iso(-2), createdAt: iso(-12) },
  ];

  private folderShares:FolderShare[] = [];
  private fileShares:FileShare[] = [
    { id: 'file-share-design', fileId: 'synthetic-file', principalType: 'group', principalId: 'design', principalName: 'Design', role: 'view' },
  ];

  async load():Promise<FilesSnapshot> { return { collection: { id: 'synthetic-collection', name: 'Files', home: 'desktop-only', orgId: 'synthetic-org', retentionPolicy: { trashDays: 90 }, storageQuota: 10_000_000_000, keptBytes: 184_000_000, desktopCount: 2, memberCount: 4, accountName: 'Jonathon', accountRole: 'owner', ownerUserId: 'synthetic-owner' }, files: [{ id: 'synthetic-file', path: 'Sulla Server/Mockups/Vault phase 2 walkthrough.mp4', mime: 'video/mp4', size: 184_000_000, updatedAt: iso(0), currentVersionId: 'version-7', versionCount: 7, createdByType: 'agent-run', createdById: 'heartbeat run #4,112', ownerDisplayName: 'Jonathon', syncState: 'online-only' }], status: { state: 'synced', pendingFiles: 0, lastSyncAt: iso(0), serverConfigured: true, location: 'server', serverLabel: 'Sulla Server' } } }
  async history():Promise<FilesVersion[]> { return Array.from({ length: 7 }, (_, index) => ({ id: `version-${ 7 - index }`, size: 184_000_000 + index * 300_000, deleted: false, created_by_type: index ? 'user' : 'agent-run', created_by_id: index ? 'Jonathon' : 'heartbeat run #4,112', created_at: iso(-index / 24), message: index ? ['Trimmed last 12 seconds', 'Camera bubble moved to corner', 'Uploaded from tray'][index - 1] || 'Recording updated' : 'Transcript added', device_id: index ? 'Mac Studio' : 'heartbeat run #4,112', current: index === 0 })) }
  async preview():Promise<FilesPreview> { return { data: new TextEncoder().encode('<h1>Synthetic Files preview</h1>'), mime: 'text/html', path: 'Sulla-made/mockups/03-share.html' } }
  async detail():Promise<FilesDetail> { return { provenance: { type: 'agent-run', id: 'heartbeat run #4,112' }, version: (await this.history())[0], recording: { version_id: 'version-7', language: 'en', generator: 'whisper.cpp · auto', duration_seconds: 402, generated_at: iso(0), transcript: [{ start: 0, end: 40, text: 'Okay, this is the vault after the phase two switch-over. The personal side is still locked on the device, and nothing on this screen leaves the Mac.' }, { start: 41, end: 111, text: 'Here’s the agent credentials tab. When I flip “agents can use”, the tool catalog injects it at call time.' }, { start: 112, end: 149, text: 'Watch the audit line fill in as the worker calls GitHub. Every use is logged with the run id.' }, { start: 150, end: 193, text: 'The org vault is folder based. View, use-by-agents, edit, manage.' }], chapters: [{ start: 0, end: 111, title: 'Personal and agent credentials' }, { start: 112, end: 229, title: 'Audit trail and org access' }, { start: 230, end: 402, title: 'Unlock follow-up' }] }, links: [{ id: 'linked-plan', path: 'PLAN-vault.md', mime: 'text/markdown', kind: 'links_to', direction: 'incoming', createdAt: iso(-1) }, { id: 'linked-shot', path: 'vault-unlock-twice.png', mime: 'image/png', kind: 'derived_from', direction: 'outgoing', createdAt: iso(-1) }], activity: [{ id: 'a1', who_type: 'user', who_id: 'Dana Kim', action: 'preview', at: iso(0), details: { watched: '4:10 of 6:42' } }, { id: 'a2', who_type: 'agent-or-device', who_id: 'Heartbeat', device_or_run_id: '#4,112', action: 'transcript', at: iso(-0.02) }], access: { role: 'owner', inherited: [{ id: 'access-1', folder_path: 'Sulla Server', principal_type: 'user', principal_id: 'Maya Reyes', role: 'edit' }, { id: 'access-2', folder_path: 'Sulla Server', principal_type: 'user', principal_id: 'Dana Kim', role: 'edit' }] } } }
  async mediaUrl():Promise<string> { return '' }
  async search() { return (await this.load()).files }
  async setPaused() { return (await this.load()).status }
  async chooseUpload(_destination = '') { return 0 }
  async uploadPaths(_paths:string[], _destination = '') { return 0 }
  async createFolder() {}
  async openFolder() {}
  async openFile() {}
  async downloadFile() { return true }
  async downloadFiles(items:{ fileId:string }[]) { return { count: items.length } }
  async listStars() { return [] }
  async setStar() {}
  async operate() {}
  async restoreVersion() {}
  async restoreTrash() {}
  async trashFile() {}
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
