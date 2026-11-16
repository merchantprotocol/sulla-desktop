// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { SyntheticFilesStore } from './SyntheticFilesStore';
import type { FileAccessList, FileShare, FolderShare, ShareActivity, ShareLink, ShareLinkOptions, SharePrincipalType } from '../types';

/* eslint-disable @typescript-eslint/require-await -- the preview adapter intentionally implements the async production datasource contract in memory */

/** Public links, folder shares, file shares and members for the preview. */
export class SyntheticSharingService {
  private readonly shares:ShareLink[];

  constructor(private readonly store:SyntheticFilesStore) { this.shares = store.fixtures.shareLinks() }

  async createPublicLink(fileId:string, options:ShareLinkOptions) { const share:ShareLink = { id: 'share-' + fileId, url: 'https://share.sulla.cloud/v/Synthetic', name: '03-share.html · Share dialog', password: Boolean(options.password), expiresAt: options.expiresAt ?? undefined, viewCount: 0, keepAvailable: options.keepAvailable, keepUntil: options.keepUntil ?? undefined, displaySharerName: options.displaySharerName, servedFrom: options.keepAvailable ? 'cloud' : 'desktop', assetKind: options.assetKind ?? 'artifact', mode: options.mode, source: 'Sulla-made › mockups', targetId: fileId, targetType: 'file', collectionId: this.store.state.selectedCollectionId, createdAt: this.store.iso() }; this.shares.unshift(share); return share }
  async updatePublicLink(id:string, options:Partial<ShareLinkOptions>) { const share = this.shares.find(item => item.id === id); if (!share) throw new Error('Synthetic link not found'); Object.assign(share, options, { password: options.password === undefined ? share.password : Boolean(options.password), servedFrom: options.keepAvailable ? 'cloud' : share.servedFrom }); return share }
  async listPublicLinks() { return this.shares.map(item => ({ ...item })) }
  async revokePublicLink(id:string) { const share = this.shares.find(item => item.id === id); if (share) share.revokedAt = this.store.iso() }
  async restorePublicLink(id:string, password?:string) { const share = this.shares.find(item => item.id === id); if (!share) throw new Error('Synthetic link not found'); if (share.password && (!password || password.length < 8)) throw new Error('Re-enter the synthetic link password'); share.revokedAt = undefined; return share }
  async shareActivity():Promise<ShareActivity[]> { return [{ id: 'event-1', action: 'viewed', occurredAt: this.store.iso(-1), detail: '03-share.html' }, { id: 'event-2', action: 'downloaded', occurredAt: this.store.iso(-2), detail: 'Vault phase 2 walkthrough.mp4' }] }
  async listFolderShares() { return this.store.folderShares }
  async shareFolder(collectionId:string, folderPath:string, principalType:SharePrincipalType, principalId:string, role:'view' | 'edit') { const share = { id: principalType + ':' + principalId, collectionId, folderPath, principalType, principalId, role }; this.store.folderShares.push(share); this.store.persist(); return share }
  async unshareFolder(share:FolderShare) { this.store.folderShares = this.store.folderShares.filter(item => item.id !== share.id); this.store.persist() }
  async listFileShares(fileId:string):Promise<FileAccessList> { return { ownerId: 'synthetic-owner', direct: this.store.fileShares.filter(item => item.fileId === fileId).map(item => ({ ...item })), inherited: this.store.folderShares.map(item => ({ ...item, id: item.id ?? ['folder', item.folderPath, item.principalType, item.principalId].join(':'), source: 'folder' as const })) } }
  async shareFile(fileId:string, principalType:SharePrincipalType, principalId:string, role:'view' | 'edit') { const existing = this.store.fileShares.find(item => item.fileId === fileId && item.principalType === principalType && item.principalId === principalId); if (existing) { existing.role = role; return { ...existing } } const share:FileShare = { id: ['file', fileId, principalType, principalId].join(':'), fileId, principalType, principalId, role }; this.store.fileShares.push(share); return { ...share } }
  async updateFileShare(fileId:string, shareId:string, role:'view' | 'edit') { const share = this.store.fileShares.find(item => item.fileId === fileId && item.id === shareId); if (!share) throw new Error('Synthetic file share not found'); share.role = role; return { ...share } }
  async unshareFile(fileId:string, shareId:string) { this.store.fileShares = this.store.fileShares.filter(item => item.fileId !== fileId || item.id !== shareId) }
  async listMembers() { return { members: [{ id: 'synthetic-owner', email: 'jonathon@example.test', role: 'owner' }, { id: 'maya', email: 'maya@example.test', role: 'member' }], groups: [{ id: 'design', name: 'Design', members: ['maya'] }] } }
}
