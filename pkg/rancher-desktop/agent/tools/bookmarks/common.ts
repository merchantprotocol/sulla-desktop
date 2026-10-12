import { normalizeBookmarkUrl, type BookmarkRecord } from '../../database/models/BrowserBookmarkModel';
import { BaseTool, type ToolResponse } from '../base';

import { bookmarkService } from '@pkg/main/bookmarks/bookmarkService';

export interface BookmarkOutput {
  id:        string;
  kind:      'bookmark' | 'folder';
  title:     string;
  url:       string | null;
  parentId:  string | null;
  position:  number;
  children?: BookmarkOutput[];
}

export abstract class BookmarkTool extends BaseTool {
  name = '';
  description = '';

  protected service() {
    return bookmarkService;
  }

  protected output(record: BookmarkRecord): BookmarkOutput {
    return {
      id:       record.id,
      kind:     record.kind,
      title:    record.title,
      url:      record.url,
      parentId: record.parent_id ?? null,
      position: record.position,
    };
  }

  protected response(value: unknown): ToolResponse {
    return { successBoolean: true, responseString: JSON.stringify(value, null, 2) };
  }

  protected findFolder(all: readonly BookmarkRecord[], id: string): BookmarkRecord {
    const folder = all.find(record => record.id === id && record.kind === 'folder');
    if (!folder) throw new Error(`Bookmark folder "${ id }" was not found.`);

    return folder;
  }

  protected async ensureFolderPath(folderPath: string): Promise<BookmarkRecord> {
    const parts = folderPath.split('/').map(part => part.trim()).filter(Boolean);
    if (!parts.length) throw new Error('folderPath must contain at least one folder name.');

    let parentId: string | null = null;
    let current: BookmarkRecord | undefined;

    for (const title of parts) {
      const all = await this.service().list();
      current = all.find(record =>
        record.kind === 'folder' &&
        (record.parent_id ?? null) === parentId &&
        record.title === title,
      );
      current ??= await this.service().create({ kind: 'folder', title, parentId });
      parentId = current.id;
    }

    return current!;
  }

  protected async resolveDestination(input: { folderId?: string; folderPath?: string }): Promise<BookmarkRecord> {
    const folderId = input.folderId?.trim();
    const folderPath = input.folderPath?.trim();
    if (folderId && folderPath) throw new Error('Use either folderId or folderPath, not both.');
    if (folderId) return this.findFolder(await this.service().list(), folderId);

    return this.ensureFolderPath(folderPath || 'Sulla');
  }

  protected normalizeUrl(url: string): string {
    return normalizeBookmarkUrl(url);
  }
}
