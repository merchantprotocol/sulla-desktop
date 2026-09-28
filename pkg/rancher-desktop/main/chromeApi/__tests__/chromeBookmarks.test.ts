/**
 * @jest-environment node
 */
/* eslint-disable @typescript-eslint/require-await -- async mocks stand in for Postgres */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

// ── In-memory stand-in for BrowserBookmarkModel (same move/renumber semantics) ──
const mockDb: any[] = [];
let mockSeq = 0;
let mockClock = 0;

jest.mock('@pkg/agent/database/models/BrowserBookmarkModel', () => {
  const now = () => new Date(Date.UTC(2026, 8, 28, 0, 0, ++mockClock)).toISOString();
  const siblings = (pid: string | null, exclude?: string) => mockDb
    .filter(r => r.parent_id === pid && r.id !== exclude)
    .sort((a, b) => a.position - b.position);

  return {
    MAX_FAVICON_BYTES:    65536,
    normalizeBookmarkUrl: (u: string) => new URL(u).toString(),
    BrowserBookmarkModel: {
      list: async() => mockDb.map(r => ({ ...r })),
      get:  async(id: string) => {
        const r = mockDb.find(x => x.id === id);

        return r ? { ...r } : null;
      },
      create: async(input: any) => {
        const pid = input.parentId ?? null;
        const row = {
          id:         `bm_${ ++mockSeq }`,
          parent_id:  pid,
          kind:       input.kind,
          title:      input.title || (input.kind === 'folder' ? 'New folder' : input.url),
          url:        input.kind === 'bookmark' ? new URL(input.url).toString() : null,
          favicon:    null,
          position:   siblings(pid).length + 1,
          created_at: now(),
          updated_at: now(),
        };
        mockDb.push(row);

        return { ...row };
      },
      update: async(id: string, input: any) => {
        const r = mockDb.find(x => x.id === id);
        if (!r) return null;
        if (input.title !== undefined) r.title = input.title;
        if (input.url !== undefined) r.url = new URL(input.url).toString();
        if (input.favicon !== undefined) r.favicon = input.favicon;
        r.updated_at = now();

        return { ...r };
      },
      remove: async(id: string) => {
        const doomed = new Set([id]);
        let grew = true;
        while (grew) {
          grew = false;
          for (const r of mockDb) {
            if (r.parent_id && doomed.has(r.parent_id) && !doomed.has(r.id)) {
              doomed.add(r.id);
              grew = true;
            }
          }
        }
        const before = mockDb.length;
        for (let i = mockDb.length - 1; i >= 0; i--) if (doomed.has(mockDb[i].id)) mockDb.splice(i, 1);

        return mockDb.length < before;
      },
      move: async(id: string, parentId: string | null, index: number) => {
        const list = siblings(parentId, id).map(r => r.id);
        list.splice(Math.max(0, Math.min(index, list.length)), 0, id);
        list.forEach((rid, i) => {
          const r = mockDb.find(x => x.id === rid);
          r.parent_id = parentId;
          r.position = i + 1;
        });
      },
    },
  };
});
jest.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));
jest.mock('@pkg/main/browserTabs/browserSession', () => ({ getBrowserSession: () => ({ fetch: async() => ({ ok: false }) }) }));
jest.mock('@pkg/window/browserTabViewManager', () => ({ BrowserTabViewManager: { getInstance: () => ({ getFaviconUrl: () => null }) } }));

// eslint-disable-next-line import-x/first -- modules above must be mocked first
import { bookmarkService } from '../../bookmarks/bookmarkService';
// eslint-disable-next-line import-x/first
import { createChromeBookmarks } from '../chromeBookmarks';

const dockerLinks = [{ id: 'docker:app:5199', container: 'app', project: null, title: 'app', url: 'http://localhost:5199/', hostPort: 5199 }];

function setup(docker: any[] | null = dockerLinks) {
  const api = createChromeBookmarks(bookmarkService, async() => docker);
  const events: any[] = [];
  api.onCreated.addListener((id, node) => events.push(['created', id, node]));
  api.onChanged.addListener((id, info) => events.push(['changed', id, info]));
  api.onMoved.addListener((id, info) => events.push(['moved', id, info]));
  api.onRemoved.addListener((id, info) => events.push(['removed', id, info]));

  return { api, events };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

beforeEach(() => {
  mockDb.length = 0;
});

describe('chrome.bookmarks', () => {
  it('getTree returns Chrome-shaped roots with the live Docker folder marked managed', async() => {
    const { api } = setup();
    await api.create({ title: 'Alpha', url: 'https://alpha.test/' });

    const [root] = await api.getTree();

    expect(root.id).toBe('0');
    expect(root.children!.map(c => [c.id, c.title, c.unmodifiable])).toEqual([['1', 'Bookmarks', undefined], ['docker', 'Docker', 'managed']]);
    expect(root.children![0].children!.map(c => [c.title, c.url, c.parentId, c.index])).toEqual([['Alpha', 'https://alpha.test/', '1', 0]]);
    expect(root.children![1].children![0]).toMatchObject({ id: 'docker:app:5199', url: 'http://localhost:5199/', unmodifiable: 'managed' });
  });

  it('omits the Docker folder when Docker is unreachable', async() => {
    const { api } = setup(null);
    const [root] = await api.getTree();

    expect(root.children!.map(c => c.id)).toEqual(['1']);
  });

  it('create defaults to the Bookmarks folder, honours index, and fires onCreated', async() => {
    const { api, events } = setup();
    const folder = await api.create({ title: 'Work' });
    const b = await api.create({ parentId: folder.id, title: 'B', url: 'https://b.test/' });
    const a = await api.create({ parentId: folder.id, index: 0, title: 'A', url: 'https://a.test/' });
    await flush();

    expect(folder).toMatchObject({ parentId: '1', title: 'Work' });
    expect(folder.url).toBeUndefined();
    expect(a.index).toBe(0);
    expect((await api.getChildren(folder.id)).map(n => n.title)).toEqual(['A', 'B']);
    expect(events.filter(e => e[0] === 'created').map(e => e[1])).toEqual([folder.id, b.id, a.id]);
  });

  it('moves with Chrome index semantics and reports old/new positions', async() => {
    const { api, events } = setup();
    const a = await api.create({ title: 'a', url: 'https://a.test/' });
    await api.create({ title: 'b', url: 'https://b.test/' });
    await api.create({ title: 'c', url: 'https://c.test/' });

    // Chrome: moving a to index 2 in the same folder puts it before c.
    const moved = await api.move(a.id, { index: 2 });

    expect((await api.getChildren('1')).map(n => n.title)).toEqual(['b', 'a', 'c']);
    expect(moved.index).toBe(1);
    expect(events.find(e => e[0] === 'moved')).toEqual(['moved', a.id, { parentId: '1', index: 1, oldParentId: '1', oldIndex: 0 }]);
  });

  it('edits made through the app pane fire chrome events too', async() => {
    const { api, events } = setup();
    const node = await api.create({ title: 'Old', url: 'https://old.test/' });

    await bookmarkService.update(node.id, { title: 'New' });

    expect(events).toContainEqual(['changed', node.id, { title: 'New', url: 'https://old.test/' }]);
  });

  it('remove refuses non-empty folders; removeTree deletes and reports the subtree', async() => {
    const { api, events } = setup();
    const folder = await api.create({ title: 'Work' });
    await api.create({ parentId: folder.id, title: 'x', url: 'https://x.test/' });

    await expect(api.remove(folder.id)).rejects.toThrow("Can't remove non-empty folder");
    await api.removeTree(folder.id);

    expect(await api.getChildren('1')).toEqual([]);
    const removed = events.find(e => e[0] === 'removed');
    expect(removed[2]).toMatchObject({ parentId: '1', index: 0, node: { id: folder.id, title: 'Work' } });
    expect(removed[2].node.children.map((c: any) => c.title)).toEqual(['x']);
  });

  it('rejects writes to root and managed nodes, and unknown ids', async() => {
    const { api } = setup();

    await expect(api.create({ parentId: '0', title: 'nope' })).rejects.toThrow('root bookmark folders');
    await expect(api.create({ parentId: 'docker', title: 'nope', url: 'https://n.test/' })).rejects.toThrow('managed');
    await expect(api.update('1', { title: 'x' })).rejects.toThrow('root bookmark folders');
    await expect(api.remove('docker:app:5199')).rejects.toThrow('managed');
    await expect(api.get('bm_missing')).rejects.toThrow("Can't find bookmark for id.");
  });

  it('searches by text terms, exact url and exact title (Docker links included)', async() => {
    const { api } = setup();
    await api.create({ title: 'Ripple Core staging', url: 'https://staging.ripplecore.app/' });
    await api.create({ title: 'Docs', url: 'https://docs.test/' });

    expect((await api.search('ripple staging')).map(n => n.title)).toEqual(['Ripple Core staging']);
    expect((await api.search({ url: 'https://docs.test/' })).map(n => n.title)).toEqual(['Docs']);
    expect((await api.search({ title: 'Docs' })).map(n => n.title)).toEqual(['Docs']);
    expect((await api.search('localhost')).map(n => n.id)).toEqual(['docker:app:5199']);
    expect(await api.search('')).toEqual([]);
  });

  it('getRecent returns newest bookmarks first and validates the count', async() => {
    const { api } = setup();
    await api.create({ title: 'first', url: 'https://1.test/' });
    await api.create({ title: 'folder' });
    await api.create({ title: 'second', url: 'https://2.test/' });

    expect((await api.getRecent(5)).map(n => n.title)).toEqual(['second', 'first']);
    await expect(api.getRecent(0)).rejects.toThrow('less than 1');
  });
});
