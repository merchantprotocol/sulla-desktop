import type { FilesDataSource, FilesPreview, FilesSnapshot, FilesVersion, FolderShare, ShareActivity, ShareLink, ShareLinkOptions, SharePrincipalType } from './types';

const now = Date.now();
const iso = (days = 0) => new Date(now + days * 86_400_000).toISOString();

/** In-memory fixtures for the isolated /files-preview route. Never reads Files IPC. */
export class SyntheticFilesDataSource implements FilesDataSource {
  capabilities = { upload: true, versionHistory: true, restoreVersions: true, trash: true, orgSharing: true, publicLinks: true, onlineOnly: false };
  onlineOnlyReason = 'Synthetic preview';
  private shares:ShareLink[] = [
    { id: 'share-capture', url: 'https://share.sulla.cloud/v/m3Xp9A', name: 'Screenshot 2026-10-16 at 11.17.02.png', mode: 'view', password: false, expiresAt: iso(30), viewCount: 0, keepAvailable: true, keepUntil: iso(30), displaySharerName: true, servedFrom: 'cloud', assetKind: 'capture', source: 'Copy on Sulla Cloud', createdAt: iso(-1) },
    { id: 'share-artifact', url: 'https://share.sulla.cloud/v/Tq8mWe', name: '03-share.html · Share dialog', mode: 'view', password: false, expiresAt: iso(13), viewCount: 7, lastViewedAt: iso(-1), keepAvailable: true, keepUntil: iso(2), displaySharerName: true, servedFrom: 'cloud', assetKind: 'artifact', source: 'Sulla-made › mockups', createdAt: iso(-3) },
    { id: 'share-file', url: 'https://share.sulla.cloud/v/8kQ2vT', name: 'Vault phase 2 walkthrough.mp4', mode: 'view', password: true, expiresAt: iso(13), viewCount: 14, lastViewedAt: iso(-2), keepAvailable: false, displaySharerName: true, servedFrom: 'desktop', assetKind: 'file', source: 'This Mac · live', createdAt: iso(-8) },
    { id: 'share-revoked', url: 'https://share.sulla.cloud/v/Jd9xCp', name: 'Route settlement · week 41', mode: 'view', password: false, viewCount: 12, keepAvailable: false, displaySharerName: true, servedFrom: 'desktop', assetKind: 'artifact', source: 'This Mac', revokedAt: iso(-2), createdAt: iso(-12) },
  ];
  private folderShares:FolderShare[] = [];

  async load():Promise<FilesSnapshot> { return { collection: { id: 'synthetic-collection', name: 'Files', home: 'desktop-only', orgId: 'synthetic-org', retentionPolicy: { trashDays: 90 }, storageQuota: 10_000_000_000, keptBytes: 1_200_000, desktopCount: 2, memberCount: 4, accountName: 'Jonathon', accountRole: 'owner', ownerUserId: 'synthetic-owner' }, files: [{ id: 'synthetic-file', path: 'Sulla-made/mockups/03-share.html', mime: 'text/html', size: 44_032, updatedAt: iso(-1), currentVersionId: 'version-3', versionCount: 3, createdByType: 'agent-run', createdById: 'mockup-designer #106', ownerDisplayName: 'Sulla' }], status: { state: 'synced', pendingFiles: 0, lastSyncAt: iso(0), serverConfigured: false, location: 'local' } } }
  async history():Promise<FilesVersion[]> { return [{ id: 'version-3', size: 44_032, deleted: false, created_by_type: 'agent-run', created_by_id: 'mockup-designer #106', created_at: iso(-1), current: true }] }
  async preview():Promise<FilesPreview> { return { data: new TextEncoder().encode('<h1>Synthetic Files preview</h1>'), mime: 'text/html', path: 'Sulla-made/mockups/03-share.html' } }
  async search() { return (await this.load()).files }
  async setPaused() { return (await this.load()).status }
  async chooseUpload() { return 0 }
  async uploadPaths() { return 0 }
  async createFolder() {}
  async openFolder() {}
  async openFile() {}
  async restoreVersion() {}
  async restoreTrash() {}
  async trashFile() {}
  async createPublicLink(fileId:string, options:ShareLinkOptions) { const share:ShareLink = { id: `share-${ fileId }`, url: 'https://share.sulla.cloud/v/Synthetic', name: '03-share.html · Share dialog', password: Boolean(options.password), expiresAt: options.expiresAt, viewCount: 0, keepAvailable: options.keepAvailable, keepUntil: options.keepUntil, displaySharerName: options.displaySharerName, servedFrom: options.keepAvailable ? 'cloud' : 'desktop', assetKind: options.assetKind ?? 'artifact', mode: options.mode, source: fileId, createdAt: iso(0) }; this.shares.unshift(share); return share }
  async updatePublicLink(id:string, options:Partial<ShareLinkOptions>) { const share = this.shares.find(item => item.id === id); if (!share) throw new Error('Synthetic link not found'); Object.assign(share, options, { password: options.password === undefined ? share.password : Boolean(options.password), servedFrom: options.keepAvailable ? 'cloud' : share.servedFrom }); return share }
  async listPublicLinks() { return this.shares.map(item => ({ ...item })) }
  async revokePublicLink(id:string) { const share = this.shares.find(item => item.id === id); if (share) share.revokedAt = iso(0) }
  async restorePublicLink(id:string) { const share = this.shares.find(item => item.id === id); if (!share) throw new Error('Synthetic link not found'); share.revokedAt = undefined; return share }
  async shareActivity():Promise<ShareActivity[]> { return [{ id: 'event-1', action: 'viewed', occurredAt: iso(-1), detail: '03-share.html' }, { id: 'event-2', action: 'downloaded', occurredAt: iso(-2), detail: 'Vault phase 2 walkthrough.mp4' }] }
  async listFolderShares() { return this.folderShares }
  async shareFolder(collectionId:string, folderPath:string, principalType:SharePrincipalType, principalId:string, role:'view' | 'edit') { const share = { id: `${ principalType }:${ principalId }`, collectionId, folderPath, principalType, principalId, role }; this.folderShares.push(share); return share }
  async unshareFolder(share:FolderShare) { this.folderShares = this.folderShares.filter(item => item.id !== share.id) }
  async listMembers() { return { members: [{ id: 'maya', email: 'maya@example.test', role: 'member' }], groups: [{ id: 'design', name: 'Design', members: ['maya'] }] } }
}
