/** @jest-environment node */
import { jest } from '@jest/globals';
import mockModules from '@pkg/utils/testUtils/mockModules';

import type { BookmarkRecord } from '@pkg/agent/database/models/BrowserBookmarkModel';
import type { ChatArtifactRecord } from '@pkg/shared/chatArtifacts';

mockModules({
  electron: {
    BrowserWindow: { getAllWindows: () => [] },
    session:       { fromPartition: () => ({ fetch: jest.fn() }) },
  },
});
const { ArtifactBookmarkSync, artifactBookmarkUrl } = await import('../artifactBookmarkSync');

function artifact(id: string, name: string): ChatArtifactRecord {
  return {
    id, threadId: `thread-${ id }`, name, kind: 'markdown', content: name,
    status: 'working', isOpen: true, isDeleted: false, version: 1,
    language: null, path: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

class MemoryBookmarks {
  records: BookmarkRecord[] = [];
  nextId = 1;

  async ensureFolder(id: string, title: string) {
    let record = this.records.find(item => item.id === id);
    if (!record) {
      record = this.row(id, 'folder', title, null, null);
      this.records.push(record);
    }
    return record;
  }

  async findByUrl(url: string) {
    return this.records.filter(item => item.url === url);
  }

  async create(input: any) {
    const record = this.row(`b${ this.nextId++ }`, input.kind, input.title, input.url, input.parentId);
    this.records.push(record);
    return record;
  }

  async update(id: string, input: any) {
    const record = this.records.find(item => item.id === id);
    if (!record) return null;
    Object.assign(record, input);
    return record;
  }

  async remove(id: string) {
    const before = this.records.length;
    this.records = this.records.filter(item => item.id !== id && item.parent_id !== id);
    return this.records.length !== before;
  }

  private row(id: string, kind: 'bookmark' | 'folder', title: string, url: string | null, parentId: string | null): BookmarkRecord {
    return { id, parent_id: parentId, kind, title, url, favicon: null, position: this.records.length + 1, created_at: '', updated_at: '' };
  }
}

describe('ArtifactBookmarkSync', () => {
  test('create is idempotent, rename updates in place, and delete removes the bookmark', async() => {
    const bookmarks = new MemoryBookmarks();
    const item = artifact('a1', 'Plan');
    const sync = new ArtifactBookmarkSync(bookmarks as any);

    await sync.created(item);
    await sync.created(item);
    expect(await bookmarks.findByUrl(artifactBookmarkUrl(item.id))).toHaveLength(1);

    item.name = 'Roadmap';
    await sync.renamed(item);
    expect((await bookmarks.findByUrl(artifactBookmarkUrl(item.id)))[0].title).toBe('Roadmap');

    await sync.deleted(item);
    expect(await bookmarks.findByUrl(artifactBookmarkUrl(item.id))).toHaveLength(0);
  });
});
