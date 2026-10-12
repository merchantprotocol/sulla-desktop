import { BookmarkTool, type BookmarkOutput } from './common';

import type { BookmarkRecord } from '../../database/models/BrowserBookmarkModel';

export class BookmarksListWorker extends BookmarkTool {
  protected async _validatedCall(input: any) {
    const all = await this.service().list();
    const folderId = typeof input.folderId === 'string' && input.folderId.trim() ? input.folderId.trim() : null;
    if (folderId) this.findFolder(all, folderId);

    const childrenOf = (parentId: string | null): BookmarkRecord[] => all
      .filter(record => (record.parent_id ?? null) === parentId)
      .sort((a, b) => a.position - b.position || String(a.created_at).localeCompare(String(b.created_at)));

    if (input.format === 'flat') {
      return this.response(childrenOf(folderId).map(record => this.output(record)));
    }

    const build = (parentId: string | null): BookmarkOutput[] => childrenOf(parentId).map((record) => {
      const item = this.output(record);
      if (record.kind === 'folder') item.children = build(record.id);

      return item;
    });

    return this.response(build(folderId));
  }
}
