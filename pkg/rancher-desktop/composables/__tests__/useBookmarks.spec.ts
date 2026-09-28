import { describe, expect, it, jest } from '@jest/globals';

jest.unstable_mockModule('@pkg/utils/ipcRenderer', () => ({
  ipcRenderer: { invoke: jest.fn(() => Promise.resolve([])), on: jest.fn(), send: jest.fn() },
}));

const row = (id: string, parentId: string | null, position: number, kind: 'bookmark' | 'folder' = 'bookmark') => ({
  id, parent_id: parentId, position, kind, title: id, url: kind === 'bookmark' ? `https://${ id }.test/` : null, favicon: null, created_at: '', updated_at: '',
});

describe('useBookmarks helpers', () => {
  const load = () => import('../useBookmarks');

  it('builds a position-ordered tree and keeps orphans at the top level', async() => {
    const { buildBookmarkTree } = await load();
    const tree = buildBookmarkTree([
      row('b', null, 2),
      row('f', null, 1, 'folder'),
      row('f2', 'f', 2),
      row('f1', 'f', 1),
      row('orphan', 'missing', 3),
    ]);

    expect(tree.map(n => n.record.id)).toEqual(['f', 'b', 'orphan']);
    expect(tree[0].children.map(n => n.record.id)).toEqual(['f1', 'f2']);
  });

  it('matches URLs regardless of trailing slash or fragment', async() => {
    const { bookmarkUrlKey } = await load();
    expect(bookmarkUrlKey('https://a.test/docs/#intro')).toBe(bookmarkUrlKey('https://a.test/docs'));
    expect(bookmarkUrlKey('https://a.test/?q=1')).not.toBe(bookmarkUrlKey('https://a.test/?q=2'));
    expect(bookmarkUrlKey(undefined)).toBe('');
  });
});
