// bookmarksIpc.ts — Electron IPC bridge for browser bookmarks.
//
//   bookmarks:list    → every bookmark/folder row (renderer builds the tree)
//   bookmarks:create  → add a bookmark or folder; favicon captured async
//   bookmarks:update  → rename / re-point a bookmark
//   bookmarks:delete  → remove a bookmark or a folder and its contents
//   bookmarks:move    → reparent / reorder
//   bookmarks:docker-links → live links for running containers' open ports
//
// Every mutation broadcasts `bookmarks:changed` so all Sulla windows refresh.

import { BrowserWindow } from 'electron';

import { BrowserBookmarkModel, MAX_FAVICON_BYTES, normalizeBookmarkUrl } from '@pkg/agent/database/models/BrowserBookmarkModel';
import { getBrowserSession } from '@pkg/main/browserTabs/browserSession';
import { listDockerLinks } from '@pkg/main/dockerLinks';
import { getIpcMainProxy } from '@pkg/main/ipcMain';
import Logging from '@pkg/utils/logging';

const console = Logging.background;
const ipcMainProxy = getIpcMainProxy(console);

const FAVICON_TIMEOUT_MS = 4_000;

function isAppWindow(url: string): boolean {
  return /^(file:|app:)/.test(url);
}

function trusted(event: Electron.IpcMainInvokeEvent): void {
  if (!BrowserWindow.fromWebContents(event.sender) || event.senderFrame !== event.sender.mainFrame ||
      !isAppWindow(event.senderFrame?.url || '')) {
    throw new Error('Only the Desktop application can manage bookmarks.');
  }
}

function broadcastChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      if (!win.isDestroyed() && isAppWindow(win.webContents.getURL())) win.webContents.send('bookmarks:changed');
    } catch { /* window closing */ }
  }
}

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
      await BrowserBookmarkModel.update(bookmarkId, { favicon: dataUrl });
      broadcastChanged();

      return;
    }
  }
}

export function initBookmarksIpc(): void {
  ipcMainProxy.handle('bookmarks:list', async(event) => {
    trusted(event);

    return BrowserBookmarkModel.list();
  });

  ipcMainProxy.handle('bookmarks:create', async(event, input) => {
    trusted(event);
    const record = await BrowserBookmarkModel.create({
      kind:     input?.kind === 'folder' ? 'folder' : 'bookmark',
      title:    input?.title,
      url:      input?.url,
      parentId: input?.parentId ?? null,
    });
    broadcastChanged();

    if (record.kind === 'bookmark' && record.url) {
      captureFavicon(record.id, record.url, typeof input?.tabId === 'string' ? input.tabId : undefined)
        .catch(err => console.warn('[Bookmarks] favicon capture failed:', err));
    }

    return record;
  });

  ipcMainProxy.handle('bookmarks:update', async(event, id, input) => {
    trusted(event);
    const before = await BrowserBookmarkModel.get(id);
    const record = await BrowserBookmarkModel.update(id, { title: input?.title, url: input?.url });
    broadcastChanged();

    // Re-pointed to a different site — the old icon no longer applies.
    if (record?.url && before?.url && normalizeBookmarkUrl(before.url) !== record.url &&
        new URL(before.url).origin !== new URL(record.url).origin) {
      await BrowserBookmarkModel.update(id, { favicon: null });
      captureFavicon(id, record.url).catch(() => {});
    }

    return record;
  });

  ipcMainProxy.handle('bookmarks:delete', async(event, id) => {
    trusted(event);
    const removed = await BrowserBookmarkModel.remove(id);
    broadcastChanged();

    return removed;
  });

  // Live, read-only "Docker" section: running containers with open ports.
  ipcMainProxy.handle('bookmarks:docker-links', async(event) => {
    trusted(event);

    return listDockerLinks();
  });

  ipcMainProxy.handle('bookmarks:move', async(event, id, parentId, index) => {
    trusted(event);
    await BrowserBookmarkModel.move(id, parentId ?? null, Number(index));
    broadcastChanged();
  });
}
