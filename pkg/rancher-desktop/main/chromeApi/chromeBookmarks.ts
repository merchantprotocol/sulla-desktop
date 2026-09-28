// chrome.bookmarks on top of Sulla's bookmark store.
//
// Tree shape (what extensions expect from Chrome):
//   "0"  root                     — not modifiable
//   ├─ "1"  Bookmarks             — the user's saved bookmarks (DB rows with parent_id NULL)
//   └─ "docker"  Docker           — live running containers, unmodifiable: 'managed'
//
// Everything below "1" is a real browser_bookmarks row; its DB id is the
// chrome id. Writes go through bookmarkService, so changes made here show up
// in the Bookmarks pane, and changes made in the pane fire the chrome events.

import { bookmarkEvents, bookmarkService, indexOf, siblingsOf } from '@pkg/main/bookmarks/bookmarkService';
import { listDockerLinks, type DockerLink } from '@pkg/main/dockerLinks';

import { ChromeEventImpl } from './chromeEvent';

import type { BookmarkRecord } from '@pkg/agent/database/models/BrowserBookmarkModel';
import type {
  BookmarkChanges, BookmarkCreateArg, BookmarkDestination, BookmarkMoveInfo, BookmarkRemoveInfo,
  BookmarkSearchQuery, BookmarkTreeNode, ChromeApi,
} from './types';

export const ROOT_ID = '0';
export const BOOKMARKS_FOLDER_ID = '1';
export const DOCKER_FOLDER_ID = 'docker';
const DOCKER_TIMEOUT_MS = 3_000;

const NOT_FOUND = "Can't find bookmark for id.";
const ROOT_READONLY = "Can't modify the root bookmark folders.";
const MANAGED_READONLY = "Can't modify managed bookmarks.";

type Store = Pick<typeof bookmarkService, 'list' | 'create' | 'update' | 'remove' | 'move'>;
/** Live Docker links, or null when Docker isn't reachable (folder omitted). */
type DockerSource = () => Promise<DockerLink[] | null>;

const toMs = (value: string | undefined): number | undefined => {
  const ms = value ? Date.parse(value) : NaN;

  return Number.isFinite(ms) ? ms : undefined;
};

const chromeParentId = (parentId: string | null | undefined): string => parentId ?? BOOKMARKS_FOLDER_ID;
const dbParentId = (chromeId: string | undefined): string | null => (!chromeId || chromeId === BOOKMARKS_FOLDER_ID ? null : chromeId);

/** One DB row as a BookmarkTreeNode (optionally with its subtree). */
export function toNode(all: readonly BookmarkRecord[], record: BookmarkRecord, withChildren: boolean): BookmarkTreeNode {
  const node: BookmarkTreeNode = {
    id:        record.id,
    parentId:  chromeParentId(record.parent_id),
    index:     indexOf(all, record),
    title:     record.title,
    dateAdded: toMs(record.created_at),
  };
  if (record.kind === 'bookmark') {
    node.url = record.url ?? '';
  } else {
    node.dateGroupModified = toMs(record.updated_at);
    if (withChildren) node.children = siblingsOf(all, record.id).map(child => toNode(all, child, true));
  }

  return node;
}

function bookmarksFolder(all: readonly BookmarkRecord[], withChildren: boolean): BookmarkTreeNode {
  const node: BookmarkTreeNode = { id: BOOKMARKS_FOLDER_ID, parentId: ROOT_ID, index: 0, title: 'Bookmarks' };
  if (withChildren) node.children = siblingsOf(all, null).map(r => toNode(all, r, true));

  return node;
}

function dockerFolder(links: DockerLink[], withChildren: boolean): BookmarkTreeNode {
  const node: BookmarkTreeNode = { id: DOCKER_FOLDER_ID, parentId: ROOT_ID, index: 1, title: 'Docker', unmodifiable: 'managed' };
  if (withChildren) {
    node.children = links.map((link, index) => ({
      id: link.id, parentId: DOCKER_FOLDER_ID, index, title: link.title, url: link.url, unmodifiable: 'managed' as const,
    }));
  }

  return node;
}

/** Chrome's text search: every whitespace-separated term must appear in the title or URL. */
function matchesText(title: string, url: string | undefined, text: string): boolean {
  const hay = `${ title } ${ url ?? '' }`.toLowerCase();

  return text.toLowerCase().split(/\s+/).filter(Boolean).every(term => hay.includes(term));
}

export function createChromeBookmarks(store: Store = bookmarkService, docker: DockerSource = defaultDockerSource): ChromeApi['bookmarks'] {
  const onCreated = new ChromeEventImpl<[string, BookmarkTreeNode]>();
  const onChanged = new ChromeEventImpl<[string, BookmarkChanges]>();
  const onMoved = new ChromeEventImpl<[string, BookmarkMoveInfo]>();
  const onRemoved = new ChromeEventImpl<[string, BookmarkRemoveInfo]>();

  // Pane edits and chrome.bookmarks edits both land here.
  bookmarkEvents.on('created', async(record) => {
    if (!onCreated.hasListeners()) return;
    const all = await store.list();
    const fresh = all.find(r => r.id === record.id) ?? record;
    onCreated.emit(record.id, toNode(all, fresh, false));
  });
  bookmarkEvents.on('changed', (record) => {
    onChanged.emit(record.id, record.kind === 'bookmark' ? { title: record.title, url: record.url ?? '' } : { title: record.title });
  });
  bookmarkEvents.on('moved', (e) => {
    onMoved.emit(e.record.id, {
      parentId: chromeParentId(e.parentId), index: e.index, oldParentId: chromeParentId(e.oldParentId), oldIndex: e.oldIndex,
    });
  });
  bookmarkEvents.on('removed', (e) => {
    onRemoved.emit(e.record.id, {
      parentId: chromeParentId(e.parentId),
      index:    e.index,
      node:     toNode(e.subtree, e.record, true),
    });
  });

  async function dockerLinksSafe(): Promise<DockerLink[] | null> {
    try {
      return await Promise.race([
        docker(),
        new Promise<null>(resolve => setTimeout(() => resolve(null), DOCKER_TIMEOUT_MS)),
      ]);
    } catch {
      return null;
    }
  }

  function assertWritable(id: string | undefined): void {
    if (id === ROOT_ID || id === BOOKMARKS_FOLDER_ID) throw new Error(ROOT_READONLY);
    if (id === DOCKER_FOLDER_ID || id?.startsWith('docker:')) throw new Error(MANAGED_READONLY);
  }

  async function nodeById(id: string, withChildren: boolean): Promise<BookmarkTreeNode> {
    const all = await store.list();
    if (id === ROOT_ID) {
      const links = await dockerLinksSafe();
      const root: BookmarkTreeNode = { id: ROOT_ID, title: '' };
      if (withChildren) root.children = [bookmarksFolder(all, true), ...(links ? [dockerFolder(links, true)] : [])];

      return root;
    }
    if (id === BOOKMARKS_FOLDER_ID) return bookmarksFolder(all, withChildren);
    if (id === DOCKER_FOLDER_ID || id.startsWith('docker:')) {
      const links = await dockerLinksSafe();
      if (links) {
        const folder = dockerFolder(links, true);
        if (id === DOCKER_FOLDER_ID) return withChildren ? folder : { ...folder, children: undefined };
        const link = folder.children!.find(c => c.id === id);
        if (link) return link;
      }
      throw new Error(NOT_FOUND);
    }
    const record = all.find(r => r.id === id);
    if (!record) throw new Error(NOT_FOUND);

    return toNode(all, record, withChildren);
  }

  const stripChildren = (node: BookmarkTreeNode): BookmarkTreeNode => {
    const { children: _c, ...rest } = node;

    return rest;
  };

  return {
    async get(idOrIdList) {
      const ids = Array.isArray(idOrIdList) ? idOrIdList : [idOrIdList];

      return Promise.all(ids.map(id => nodeById(String(id), false).then(stripChildren)));
    },

    async getChildren(id) {
      const node = await nodeById(String(id), true);

      return (node.children ?? []).map(stripChildren);
    },

    async getRecent(numberOfItems) {
      if (!(numberOfItems >= 1)) throw new Error('numberOfItems cannot be less than 1.');
      const all = await store.list();

      return all
        .filter(r => r.kind === 'bookmark')
        .sort((a, b) => (toMs(b.created_at) ?? 0) - (toMs(a.created_at) ?? 0))
        .slice(0, Math.floor(numberOfItems))
        .map(r => toNode(all, r, false));
    },

    async getTree() {
      return [await nodeById(ROOT_ID, true)];
    },

    async getSubTree(id) {
      return [await nodeById(String(id), true)];
    },

    async search(query: BookmarkSearchQuery) {
      const all = await store.list();
      const nodes = all.map(r => toNode(all, r, false));
      const links = await dockerLinksSafe();
      if (links) nodes.push(...dockerFolder(links, true).children!);

      if (typeof query === 'string') {
        if (!query.trim()) return [];

        return nodes.filter(n => matchesText(n.title, n.url, query));
      }
      const { query: text, url, title } = query ?? {};

      return nodes.filter(n =>
        (!text || matchesText(n.title, n.url, text)) &&
        (url === undefined || n.url === url) &&
        (title === undefined || n.title === title));
    },

    async create(bookmark: BookmarkCreateArg) {
      const parentId = bookmark?.parentId ?? BOOKMARKS_FOLDER_ID;
      if (parentId === ROOT_ID) throw new Error(ROOT_READONLY);
      if (parentId === DOCKER_FOLDER_ID) throw new Error(MANAGED_READONLY);
      const record = await store.create({
        kind:     bookmark?.url ? 'bookmark' : 'folder',
        title:    bookmark?.title ?? '',
        url:      bookmark?.url,
        parentId: dbParentId(parentId),
        index:    typeof bookmark?.index === 'number' ? bookmark.index : undefined,
      });
      const all = await store.list();

      return toNode(all, all.find(r => r.id === record.id) ?? record, false);
    },

    async update(id, changes: BookmarkChanges) {
      assertWritable(id);
      const record = await store.update(id, { title: changes?.title, url: changes?.url });
      if (!record) throw new Error(NOT_FOUND);
      const all = await store.list();

      return toNode(all, record, false);
    },

    async move(id, destination: BookmarkDestination) {
      assertWritable(id);
      const all = await store.list();
      const record = all.find(r => r.id === id);
      if (!record) throw new Error(NOT_FOUND);
      const targetChromeParent = destination?.parentId ?? chromeParentId(record.parent_id);
      if (targetChromeParent === ROOT_ID) throw new Error(ROOT_READONLY);
      if (targetChromeParent === DOCKER_FOLDER_ID) throw new Error(MANAGED_READONLY);
      const parentId = dbParentId(targetChromeParent);

      // Chrome's index counts the moved node in place, so moving later within
      // the same folder lands one slot earlier than the raw index.
      const oldIndex = indexOf(all, record);
      const sameParent = (record.parent_id ?? null) === parentId;
      let index = destination?.index ?? siblingsOf(all, parentId).length;
      if (sameParent && index > oldIndex) index -= 1;

      const moved = await store.move(id, parentId, index);

      return toNode(await store.list(), moved, false);
    },

    async remove(id) {
      assertWritable(id);
      if (!await store.remove(id, { recursive: false })) throw new Error(NOT_FOUND);
    },

    async removeTree(id) {
      assertWritable(id);
      if (!await store.remove(id, { recursive: true })) throw new Error(NOT_FOUND);
    },

    onCreated,
    onChanged,
    onMoved,
    onRemoved,
  };
}

async function defaultDockerSource(): Promise<DockerLink[] | null> {
  const result = await listDockerLinks();

  return result.available ? result.links : null;
}
