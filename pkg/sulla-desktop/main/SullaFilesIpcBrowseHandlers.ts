// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { FilesListingPager } from './FilesListingPager';
import { FilesChangeFeed } from './sullaFilesChangeFeed';
import { FilesApiError } from './sullaFilesClient';
import { SULLA_FILES_UUID as UUID } from './SullaFilesIpcSupport';

import type { FileReference, SullaFilesIpcApi, SullaFilesIpcRegistrar } from './SullaFilesIpcSupport';

/** Live change feed, collection/folder listing, search, stars and metadata reads. */
export class SullaFilesIpcBrowseHandlers {
  private readonly feeds = new Map<number, FilesChangeFeed>();

  constructor(private readonly api:SullaFilesIpcApi) {}

  /** The per-renderer change feed and folder tree, registered first as before. */
  registerFeed(ipc:SullaFilesIpcRegistrar):void {
    ipc.handle('files-ui:watch', (event, collectionId:string) => {
      this.feeds.get(event.sender.id)?.stop();
      this.feeds.delete(event.sender.id);
      if (!collectionId) return;
      if (!UUID.test(collectionId)) throw new Error('Invalid Files collection');
      const sender = event.sender;
      let collectionsSignature:string | undefined;
      const feed = new FilesChangeFeed(
        async(after, head) => {
          const [page, collections] = await Promise.all([
            this.api.json(`/v1/collections/${ collectionId }/journal?after=${ after }&changesOnly=true${ head ? '&head=true' : '' }`, { signal: AbortSignal.timeout(5000) }),
            this.api.json('/v1/collections?changesOnly=true', { signal: AbortSignal.timeout(5000) }),
          ]);
          const signature = JSON.stringify(collections);
          if (collectionsSignature !== undefined && signature !== collectionsSignature && !sender.isDestroyed() && this.feeds.get(sender.id) === feed) {
            sender.send('files-ui:changed', { collectionId, seq: page.seq, paths: [] });
          }
          collectionsSignature = signature;
          return page;
        },
        (seq, paths) => { if (!sender.isDestroyed()) sender.send('files-ui:changed', { collectionId, seq, paths }) },
      );
      this.feeds.set(sender.id, feed);
      sender.once('destroyed', () => { feed.stop(); if (this.feeds.get(sender.id) === feed) this.feeds.delete(sender.id) });
      feed.start();
    });

    ipc.handle('sulla-files:folders', async(_event, input:{ collectionId:string; details?:boolean }) => {
      // Folder rows feed the tree and the folder metadata panel; read in bounded pages.
      const folders:unknown[] = [];
      for await (const page of FilesListingPager.pages<unknown>(url => this.api.listingRequest(url), '/v1/folders', { collectionId: input.collectionId, ...(input.details ? { details: 'true' } : {}) })) folders.push(...page);
      return folders;
    });
  }

  register(ipc:SullaFilesIpcRegistrar):void {
    const json = this.api.json.bind(this.api);
    ipc.handle('sulla-files:collections', () => json('/v1/collections'));
    // Legacy whole-list channel (no in-repo renderer caller; the File Manager uses list-page).
    // It stays complete but paged, and refuses rather than truncates past the legacy row cap.
    ipc.handle('sulla-files:list', async(_event, input:{ collectionId: string; path?: string; trash?: boolean }) => {
      const files:any[] = [];
      for await (const page of FilesListingPager.pages<any>(url => this.api.listingRequest(url), '/v1/files', { collectionId: input.collectionId, path: input.path ?? '', trash: String(input.trash === true) })) {
        if (files.length + page.length > 20_000) throw new FilesApiError('Listing exceeds 20,000 files; use sulla-files:list-page', 413);
        files.push(...page);
      }
      return files;
    });
    ipc.handle('sulla-files:list-page', async(_event, input:{ collectionId:string; path?:string; trash?:boolean; cursor?:string; children?:boolean }) => {
      const query = new URLSearchParams({ collectionId: input.collectionId, path: input.path ?? '', trash: String(input.trash === true), limit: String(FilesListingPager.pageSize), ...(input.children ? { children: 'true' } : {}) });
      if (input.cursor) query.set('cursor', input.cursor);
      const response = await this.api.client.request(`/v1/files?${ query }`);
      if (!response.ok) throw new FilesApiError(await response.text(), response.status);
      return { files: await response.json(), nextCursor: response.headers.get('X-Next-Cursor'), hasMore: response.headers.get('X-Has-More') === 'true' };
    });
    // Cross-folder views and counts come from bounded server queries, never from the open folder's rows.
    ipc.handle('sulla-files:recent', (_event, input:{ collectionId:string; limit?:number; createdByType?:string }) => json(`/v1/files/recent?${ new URLSearchParams({ collectionId:input.collectionId, limit:String(input.limit ?? 50), ...(input.createdByType ? { createdByType:input.createdByType } : {}) }) }`));
    ipc.handle('sulla-files:stats', (_event, input:{ collectionId:string }) => json(`/v1/files/stats?collectionId=${ encodeURIComponent(input.collectionId) }`));
    ipc.handle('sulla-files:folder-summary', (_event, input:{ collectionId:string; path?:string }) => json(`/v1/folders/summary?${ new URLSearchParams({ collectionId:input.collectionId, path:input.path ?? '' }) }`));
    ipc.handle('sulla-files:create-empty-file', (_event, input:{ collectionId:string; path:string }) => json('/v1/files/empty', { method: 'POST', body: JSON.stringify(input) }));
    ipc.handle('sulla-files:search', (_event, input:{ query: string; collectionId?: string }) => json('/v1/search', { method: 'POST', body: JSON.stringify(input) }));
    ipc.handle('sulla-files:reindex', (_event, input:{ fileId: string }) => json(`/v1/files/${ encodeURIComponent(input.fileId) }/reindex`, { method: 'POST' }));
    ipc.handle('sulla-files:stars', (_event, input:{ collectionId: string }) => json(`/v1/stars?collectionId=${ encodeURIComponent(input.collectionId) }`));
    ipc.handle('sulla-files:set-star', (_event, input:{ starred: boolean; collectionId: string; fileId?: string; folderPath?: string }) => json('/v1/stars', { method: input.starred ? 'PUT' : 'DELETE', body: JSON.stringify(input) }));
    ipc.handle('sulla-files:operate', (_event, input:{ action: 'move' | 'copy'; collectionId: string; items: { fileId?: string; folderPath?: string; targetPath: string }[] }) => json('/v1/file-operations', { method: 'POST', body: JSON.stringify(input) }));
    ipc.handle('sulla-files:metadata', (_event, input:{ fileId: string }) => json(`/v1/files/${ encodeURIComponent(input.fileId) }`));
    ipc.handle('sulla-files:history', (_event, input:{ fileId: string }) => json(`/v1/files/${ encodeURIComponent(input.fileId) }/history`));
    ipc.handle('sulla-files:preview', async(_event, input:{ fileId: string; versionId?: string; thumbnail?: boolean }) => {
      const route = input.thumbnail ? 'thumbnail' : 'preview'; const query = input.versionId ? `?versionId=${ encodeURIComponent(input.versionId) }` : ''; const response = await this.api.client.request(`/v1/files/${ encodeURIComponent(input.fileId) }/${ route }${ query }`);
      if (!response.ok) throw new Error(`Files preview failed (${ response.status })`);

      return { mime: response.headers.get('content-type') ?? 'application/octet-stream', data: new Uint8Array(await response.arrayBuffer()) };
    });
    ipc.handle('files-ui:recent-references', async(_event, limit = 5) => {
      // Keeps only the newest <= 20 references while pages stream through.
      const keep = Math.max(1, Math.min(Number(limit) || 5, 20));
      let newest:FileReference[] = [];
      for await (const item of this.api.collectionFilePages(await json('/v1/collections') as any[])) {
        newest = [...newest, ...item.files.map(file => this.api.reference(file, item.collection))]
          .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, keep);
      }
      return newest;
    });
  }

  /** Folder writes; collection and folder ids are validated before any request. */
  registerFolders(ipc:SullaFilesIpcRegistrar):void {
    ipc.handle('files-ui:open-folder', () => {
      throw new Error('Files are stored securely in Sulla. Download a file or selected files to export copies to Finder.');
    });
    ipc.handle('files-ui:create-folder', async(_event, input:string | { collectionId?: string; path: string }) => {
      const relativePath = typeof input === 'string' ? input : input.path;
      const collectionId = typeof input === 'string' ? undefined : input.collectionId;
      if (!collectionId || !UUID.test(collectionId)) throw new Error('Choose a Files collection before creating a folder');
      await this.api.json('/v1/folders', { method: 'POST', body: JSON.stringify({ collectionId, path: relativePath }) });
    });
    ipc.handle('files-ui:update-folder-description', async(_event, input:{ folderId:string; description:string; namingHint?:string }) => {
      if (!UUID.test(input.folderId)) throw new Error('Choose a valid Files folder');
      await this.api.json(`/v1/folders/${ encodeURIComponent(input.folderId) }/description`, { method: 'PATCH', body: JSON.stringify({ description: input.description, namingHint: input.namingHint }) });
    });
    ipc.handle('files-ui:delete-folder', async(_event, input:{ collectionId:string; path:string }) => {
      if (!UUID.test(input.collectionId)) throw new Error('Choose a Files collection before removing a folder');
      await this.api.json(`/v1/folders?collectionId=${ encodeURIComponent(input.collectionId) }&path=${ encodeURIComponent(input.path) }`, { method: 'DELETE' });
    });
  }
}
