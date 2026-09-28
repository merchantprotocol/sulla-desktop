// bookmarkService.ts — the single write path for bookmarks.
//
// Both the app's Bookmarks pane (bookmarksIpc) and the chrome.bookmarks API
// (chromeApi/chromeBookmarks) mutate through here, so:
//   - every change broadcasts `bookmarks:changed` to the app windows, and
//   - every change emits a structured event on `bookmarkEvents`, which the
//     chrome.bookmarks adapter turns into onCreated/onChanged/onMoved/onRemoved.

import { EventEmitter } from 'events';

import { BrowserWindow } from 'electron';

import { BrowserBookmarkModel, MAX_FAVICON_BYTES, normalizeBookmarkUrl, type BookmarkRecord } from '@pkg/agent/database/models/BrowserBookmarkModel';
import { getBrowserSession } from '@pkg/main/browserTabs/browserSession';
import Logging from '@pkg/utils/logging';

const console = Logging.background;

const FAVICON_TIMEOUT_MS = 4_000;

export interface BookmarkMovedEvent {
  record:      BookmarkRecord;
  parentId:    string | null;
  index:       number;
  oldParentId: string | null;
  oldIndex:    number;
}

export interface BookmarkRemovedEvent {
  record:  BookmarkRecord;
  parentId: string | null;
  index:   number;
  /** The removed row plus every descendant (for folders). */
  subtree: BookmarkRecord[];
}

interface BookmarkEventMap {
  created: [BookmarkRecord];
  changed: [BookmarkRecord];
  moved:   [BookmarkMovedEvent];
  removed: [BookmarkRemovedEvent];
}

class BookmarkEvents extends EventEmitter {
  override on<K extends keyof BookmarkEventMap>(event: K, listener: (...args: BookmarkEventMap[K]) => void): this {
    return super.on(event, listener as (...args: any[]) => void);
  }

  override emit<K extends keyof BookmarkEventMap>(event: K, ...args: BookmarkEventMap[K]): boolean {
    return super.emit(event, ...args);
  }
}

export const bookmarkEvents = new BookmarkEvents();

function isAppWindow(url: string): boolean {
  return /^(file:|app:)/.test(url);
}

export function broadcastBookmarksChanged(): void {
  try {
    for (const win of BrowserWindow.getAllWindows()) {
      try {
        if (!win.isDestroyed() && isAppWindow(win.webContents.getURL())) win.webContents.send('bookmarks:changed');
      } catch { /* window closing */ }
    }
  } catch { /* no windows (tests) */ }
}

/** Sibling list of `parentId`, in display order. */
export function siblingsOf(all: readonly BookmarkRecord[], parentId: string | null): BookmarkRecord[] {
  return all
    .filter(r => (r.parent_id ?? null) === parentId)
    .sort((a, b) => a.position - b.position || String(a.created_at).localeCompare(String(b.created_at)));
}

export function indexOf(all: readonly BookmarkRecord[], record: BookmarkRecord): number {
  return siblingsOf(all, record.parent_id ?? null).findIndex(r => r.id === record.id);
}

export function descendantsOf(all: readonly BookmarkRecord[], id: string): BookmarkRecord[] {
  const out: BookmarkRecord[] = [];
  const walk = (parentId: string) => {
    for (const child of all.filter(r => r.parent_id === parentId)) {
      out.push(child);
      walk(child.id);
    }
  };
  walk(id);

  return out;
}

// ── Favicons ──

/**
 * Fetch a favicon through the browser session (same cookies/UA the tab used)
 * and return it as a bounded data: URL. Best-effort — null on any failure.
 */
export async function fetchFaviconDataUrl(iconUrl: string, fetcher: (url: string, init: RequestInit) => Promise<Response>): Promise<string | null> {
  if (!/^https?:/i.test(iconUrl)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FAVICON_TIMEOUT_MS);

  try {
    const res = await fetcher(iconUrl, { signal: controller.signal, redirect: 'follow' });
    if (!res.ok) return null;
    const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const mime = type === 'image/vnd.microsoft.icon' || type === 'image/x-icon' ? 'image/x-icon' : type;
    if (!/^image\/(png|x-icon|gif|jpeg|webp|svg\+xml)$/.test(mime)) return null;
    const declared = Number(res.headers.get('content-length') || 0);
    if (declared > MAX_FAVICON_BYTES) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > MAX_FAVICON_BYTES) return null;

    return `data:${ mime };base64,${ buf.toString('base64') }`;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function captureFavicon(bookmarkId: string, pageUrl: string, tabId?: string): Promise<void> {
  const candidates: string[] = [];
  // Lazy import — the view manager pulls in window code that must not load
  // while sullaEvents is being initialised (same reason sulla.ts defers it).
  const { BrowserTabViewManager } = await import('@pkg/window/browserTabViewManager');
  const advertised = tabId ? BrowserTabViewManager.getInstance().getFaviconUrl(tabId) : null;
  if (advertised) candidates.push(advertised);
  try {
    const { protocol, origin } = new URL(pageUrl);
    if (protocol === 'http:' || protocol === 'https:') candidates.push(`${ origin }/favicon.ico`);
  } catch { /* unparsable — no fallback */ }

  const sess = getBrowserSession();
  for (const candidate of candidates) {
    const dataUrl = await fetchFaviconDataUrl(candidate, (url, init) => sess.fetch(url, init));
    if (dataUrl) {
      // Icon-only change: refresh the UI but don't emit a chrome onChanged
      // (Chrome doesn't fire onChanged for favicons either).
      await BrowserBookmarkModel.update(bookmarkId, { favicon: dataUrl });
      broadcastBookmarksChanged();

      return;
    }
  }
}

// ── Mutations ──

export interface CreateInput {
  kind:      'bookmark' | 'folder';
  title?:    string;
  url?:      string;
  parentId?: string | null;
  /** Position among the new siblings; omitted = append. */
  index?:    number;
  /** Tab the page is open in, so its advertised favicon can be captured. */
  tabId?:    string;
}

export const bookmarkService = {
  list: () => BrowserBookmarkModel.list(),

  async create(input: CreateInput): Promise<BookmarkRecord> {
    const parentId = input.parentId ?? null;
    let record = await BrowserBookmarkModel.create({
      kind:  input.kind === 'folder' ? 'folder' : 'bookmark',
      title: input.title,
      url:   input.url,
      parentId,
    });

    if (typeof input.index === 'number' && Number.isFinite(input.index)) {
      await BrowserBookmarkModel.move(record.id, parentId, input.index);
      record = (await BrowserBookmarkModel.get(record.id)) ?? record;
    }

    broadcastBookmarksChanged();
    bookmarkEvents.emit('created', record);

    if (record.kind === 'bookmark' && record.url) {
      captureFavicon(record.id, record.url, input.tabId)
        .catch(err => console.warn('[Bookmarks] favicon capture failed:', err));
    }

    return record;
  },

  async update(id: string, input: { title?: string; url?: string }): Promise<BookmarkRecord | null> {
    const before = await BrowserBookmarkModel.get(id);
    if (!before) return null;
    if (before.kind === 'folder' && input.url !== undefined) throw new Error("Can't set URL of a bookmark folder.");

    const record = await BrowserBookmarkModel.update(id, { title: input.title, url: input.url });
    if (!record) return null;

    broadcastBookmarksChanged();
    if (record.title !== before.title || record.url !== before.url) bookmarkEvents.emit('changed', record);

    // Re-pointed to a different site — the old icon no longer applies.
    if (record.url && before.url && normalizeBookmarkUrl(before.url) !== record.url &&
        new URL(before.url).origin !== new URL(record.url).origin) {
      await BrowserBookmarkModel.update(id, { favicon: null });
      captureFavicon(id, record.url).catch(() => {});
    }

    return record;
  },

  /**
   * Delete a bookmark or folder. `recursive: false` refuses non-empty
   * folders (chrome.bookmarks.remove semantics); the app pane deletes whole
   * folders after its own confirm, i.e. removeTree semantics.
   */
  async remove(id: string, opts: { recursive: boolean } = { recursive: true }): Promise<boolean> {
    const all = await BrowserBookmarkModel.list();
    const record = all.find(r => r.id === id);
    if (!record) return false;
    const subtree = descendantsOf(all, id);
    if (!opts.recursive && record.kind === 'folder' && subtree.length > 0) {
      throw new Error("Can't remove non-empty folder (use recursive to force).");
    }
    const index = indexOf(all, record);

    const removed = await BrowserBookmarkModel.remove(id);
    if (!removed) return false;

    broadcastBookmarksChanged();
    bookmarkEvents.emit('removed', { record, parentId: record.parent_id ?? null, index, subtree: [record, ...subtree] });

    return true;
  },

  /** Move `id` to `index` within `parentId`'s children (index counted without the moved row). */
  async move(id: string, parentId: string | null, index: number): Promise<BookmarkRecord> {
    const before = await BrowserBookmarkModel.list();
    const record = before.find(r => r.id === id);
    if (!record) throw new Error("Can't find bookmark for id.");
    const oldParentId = record.parent_id ?? null;
    const oldIndex = indexOf(before, record);

    await BrowserBookmarkModel.move(id, parentId, index);

    const after = await BrowserBookmarkModel.list();
    const moved = after.find(r => r.id === id) ?? record;
    const newIndex = indexOf(after, moved);

    broadcastBookmarksChanged();
    if (oldParentId !== (moved.parent_id ?? null) || oldIndex !== newIndex) {
      bookmarkEvents.emit('moved', { record: moved, parentId: moved.parent_id ?? null, index: newIndex, oldParentId, oldIndex });
    }

    return moved;
  },
};
