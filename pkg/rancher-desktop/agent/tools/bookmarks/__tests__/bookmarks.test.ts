/** @jest-environment node */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import type { BookmarkRecord } from '../../../database/models/BrowserBookmarkModel';

const list = jest.fn<() => Promise<BookmarkRecord[]>>();
const create = jest.fn<(input: any) => Promise<BookmarkRecord>>();
const remove = jest.fn<(id: string, options: { recursive: boolean }) => Promise<boolean>>();

jest.unstable_mockModule('@pkg/main/bookmarks/bookmarkService', () => ({
  bookmarkService: {
    list,
    create,
    remove,
    update: jest.fn(),
    move:   jest.fn(),
  },
}));

const { BookmarksAddWorker } = await import('../add');
const { BookmarksRemoveWorker } = await import('../remove');

function record(input: Partial<BookmarkRecord> & Pick<BookmarkRecord, 'id' | 'kind' | 'title'>): BookmarkRecord {
  return {
    parent_id:  null,
    url:        null,
    favicon:    null,
    position:   1,
    created_at: '2026-10-11T00:00:00.000Z',
    updated_at: '2026-10-11T00:00:00.000Z',
    ...input,
  };
}

describe('bookmark tools', () => {
  let rows: BookmarkRecord[];

  beforeEach(() => {
    jest.clearAllMocks();
    rows = [];
    list.mockImplementation(() => Promise.resolve([...rows]));
    create.mockImplementation((input: any) => {
      const created = record({
        id:        `bm_${ rows.length + 1 }`,
        kind:      input.kind,
        title:     input.title || (input.kind === 'folder' ? 'New folder' : 'example.com'),
        url:       input.url || null,
        parent_id: input.parentId ?? null,
      });
      rows.push(created);
      return Promise.resolve(created);
    });
    remove.mockResolvedValue(true);
  });

  it('returns an existing URL in the same folder instead of duplicating it', async() => {
    rows = [
      record({ id: 'sulla', kind: 'folder', title: 'Sulla' }),
      record({ id: 'saved', kind: 'bookmark', title: 'Example', url: 'https://example.com/', parent_id: 'sulla' }),
    ];

    const result = await (new BookmarksAddWorker() as any)._validatedCall({ url: 'https://example.com' });

    expect(JSON.parse(result.responseString)).toMatchObject({ created: false, bookmark: { id: 'saved' } });
    expect(create).not.toHaveBeenCalled();
  });

  it('creates every missing folder in folderPath before adding the bookmark', async() => {
    const result = await (new BookmarksAddWorker() as any)._validatedCall({
      url:        'https://example.com/research',
      folderPath: 'Sulla/Research',
    });

    expect(create.mock.calls.map(([input]) => input)).toEqual([
      expect.objectContaining({ kind: 'folder', title: 'Sulla', parentId: null }),
      expect.objectContaining({ kind: 'folder', title: 'Research', parentId: 'bm_1' }),
      expect.objectContaining({ kind: 'bookmark', parentId: 'bm_2', url: 'https://example.com/research' }),
    ]);
    expect(JSON.parse(result.responseString)).toMatchObject({ created: true, bookmark: { parentId: 'bm_2' } });
  });

  it('refuses to remove a non-empty folder unless recursive is true', async() => {
    rows = [
      record({ id: 'folder', kind: 'folder', title: 'Research' }),
      record({ id: 'child', kind: 'bookmark', title: 'Source', url: 'https://example.com/', parent_id: 'folder' }),
    ];
    const worker = new BookmarksRemoveWorker() as any;

    await expect(worker._validatedCall({ id: 'folder', recursive: false }))
      .rejects.toThrow('recursive: true');
    expect(remove).not.toHaveBeenCalled();

    await expect(worker._validatedCall({ id: 'folder', recursive: true })).resolves.toBeDefined();
    expect(remove).toHaveBeenCalledWith('folder', { recursive: true });
  });
});
