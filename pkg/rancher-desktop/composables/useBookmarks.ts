import { computed, ref } from 'vue';

import type { BookmarkRecord } from '@pkg/agent/database/models/BrowserBookmarkModel';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

export type { BookmarkRecord };

export interface BookmarkNode {
  record:   BookmarkRecord;
  children: BookmarkNode[];
}

// Shared across every consumer (pane, browser toolbar star) so there is one
// list and one IPC subscription for the whole window.
const records = ref<BookmarkRecord[]>([]);
const loaded = ref(false);
const error = ref<string | null>(null);
let subscribed = false;
let inflight: Promise<void> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

// Postgres lives in the VM and can come up well after the window does.
const RETRY_MS = 3_000;

async function refresh(): Promise<void> {
  if (inflight) return inflight;
  inflight = (async() => {
    try {
      records.value = await ipcRenderer.invoke('bookmarks:list');
      loaded.value = true;
      error.value = null;
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
      if (!retryTimer) {
        retryTimer = setTimeout(() => {
          retryTimer = null;
          refresh();
        }, RETRY_MS);
      }
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}

function subscribe(): void {
  if (subscribed) return;
  subscribed = true;
  try {
    ipcRenderer.on('bookmarks:changed', () => { refresh() });
  } catch { /* non-Electron context */ }
  refresh();
}

/** Build the folder tree from flat rows (already ordered by position). */
export function buildBookmarkTree(rows: readonly BookmarkRecord[]): BookmarkNode[] {
  const nodes = new Map<string, BookmarkNode>();
  for (const record of rows) nodes.set(record.id, { record, children: [] });

  const roots: BookmarkNode[] = [];
  for (const record of rows) {
    const node = nodes.get(record.id)!;
    const parent = record.parent_id ? nodes.get(record.parent_id) : undefined;
    (parent ? parent.children : roots).push(node);
  }
  const byPosition = (a: BookmarkNode, b: BookmarkNode) => a.record.position - b.record.position;
  const sortDeep = (list: BookmarkNode[]) => {
    list.sort(byPosition);
    for (const n of list) sortDeep(n.children);
  };
  sortDeep(roots);

  return roots;
}

/** Comparable form of a URL: ignores a trailing slash and the #fragment. */
export function bookmarkUrlKey(url: string | null | undefined): string {
  if (!url) return '';
  try {
    const u = new URL(url);
    u.hash = '';

    return u.toString().replace(/\/$/, '');
  } catch {
    return url.replace(/\/$/, '');
  }
}

export function useBookmarks() {
  subscribe();

  const tree = computed(() => buildBookmarkTree(records.value));
  const byUrl = computed(() => {
    const map = new Map<string, BookmarkRecord>();
    for (const r of records.value) {
      if (r.kind === 'bookmark' && r.url && !map.has(bookmarkUrlKey(r.url))) map.set(bookmarkUrlKey(r.url), r);
    }

    return map;
  });

  function findByUrl(url: string | null | undefined): BookmarkRecord | undefined {
    return byUrl.value.get(bookmarkUrlKey(url));
  }

  async function mutate<T>(fn: () => Promise<T>): Promise<T> {
    const result = await fn();
    await refresh();

    return result;
  }

  return {
    records,
    tree,
    loaded,
    error,
    refresh,
    findByUrl,
    addBookmark: (input: { url: string; title?: string; parentId?: string | null; tabId?: string }) => mutate(() => ipcRenderer.invoke('bookmarks:create', { kind: 'bookmark', ...input })),
    addFolder:   (title: string, parentId: string | null = null) => mutate(() => ipcRenderer.invoke('bookmarks:create', { kind: 'folder', title, parentId })),
    update:      (id: string, input: { title?: string; url?: string }) => mutate(() => ipcRenderer.invoke('bookmarks:update', id, input)),
    remove:      (id: string) => mutate(() => ipcRenderer.invoke('bookmarks:delete', id)),
    move:        (id: string, parentId: string | null, index: number) => mutate(() => ipcRenderer.invoke('bookmarks:move', id, parentId, index)),
  };
}
