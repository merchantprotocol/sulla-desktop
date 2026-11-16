// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { computed, ref, type Ref } from 'vue';

import type { BookmarkRecord } from '@pkg/agent/database/models/BrowserBookmarkModel';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

export type { BookmarkRecord };

export interface BookmarkNode {
  record:   BookmarkRecord;
  children: BookmarkNode[];
}

type BookmarksIpc = Pick<typeof ipcRenderer, 'invoke' | 'on'>;

// Postgres lives in the VM and can come up well after the window does.
const RETRY_MS = 3_000;

/**
 * Shared across every consumer (pane, browser toolbar star) so there is one
 * list and one IPC subscription for the whole window.
 */
export class BookmarksStore {
  private static instance: BookmarksStore | null = null;

  /** The single store every component in this window shares. */
  static shared(): BookmarksStore {
    if (!BookmarksStore.instance) BookmarksStore.instance = new BookmarksStore(ipcRenderer);

    return BookmarksStore.instance;
  }

  readonly records: Ref<BookmarkRecord[]> = ref([]);
  readonly loaded = ref(false);
  readonly error = ref<string | null>(null);
  private subscribed = false;
  private inflight: Promise<void> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly ipc: BookmarksIpc) {}

  readonly refresh = (): Promise<void> => {
    if (this.inflight) return this.inflight;
    this.inflight = (async() => {
      try {
        this.records.value = await this.ipc.invoke('bookmarks:list');
        this.loaded.value = true;
        this.error.value = null;
      } catch (err) {
        this.error.value = err instanceof Error ? err.message : String(err);
        if (!this.retryTimer) {
          this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            this.refresh();
          }, RETRY_MS);
        }
      } finally {
        this.inflight = null;
      }
    })();

    return this.inflight;
  };

  /** Subscribe to change events once per window and load the list. */
  subscribe(): void {
    if (this.subscribed) return;
    this.subscribed = true;
    try {
      this.ipc.on('bookmarks:changed', () => { this.refresh() });
    } catch { /* non-Electron context */ }
    this.refresh();
  }

  /** Run an IPC mutation, then reload the shared list. */
  async mutate<T>(fn: (ipc: BookmarksIpc) => Promise<T>): Promise<T> {
    const result = await fn(this.ipc);
    await this.refresh();

    return result;
  }
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
  const store = BookmarksStore.shared();

  store.subscribe();

  const { records } = store;
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

  return {
    records,
    tree,
    loaded:      store.loaded,
    error:       store.error,
    refresh:     store.refresh,
    findByUrl,
    addBookmark: (input: { url: string; title?: string; parentId?: string | null; tabId?: string }) => store.mutate(ipc => ipc.invoke('bookmarks:create', { kind: 'bookmark', ...input })),
    addFolder:   (title: string, parentId: string | null = null) => store.mutate(ipc => ipc.invoke('bookmarks:create', { kind: 'folder', title, parentId })),
    update:      (id: string, input: { title?: string; url?: string }) => store.mutate(ipc => ipc.invoke('bookmarks:update', id, input)),
    remove:      (id: string) => store.mutate(ipc => ipc.invoke('bookmarks:delete', id)),
    move:        (id: string, parentId: string | null, index: number) => store.mutate(ipc => ipc.invoke('bookmarks:move', id, parentId, index)),
  };
}
