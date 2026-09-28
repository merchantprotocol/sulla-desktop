// bookmarksIpc.ts — Electron IPC bridge for the app's Bookmarks pane.
//
//   bookmarks:list         → every bookmark/folder row (renderer builds the tree)
//   bookmarks:create       → add a bookmark or folder; favicon captured async
//   bookmarks:update       → rename / re-point a bookmark
//   bookmarks:delete       → remove a bookmark, or a folder and its contents
//   bookmarks:move         → reparent / reorder
//   bookmarks:docker-links → live links for running containers' open ports
//
// Mutations go through bookmarkService, the same write path chrome.bookmarks
// uses, so both surfaces stay in sync and emit the same events.

import { BrowserWindow } from 'electron';

import { bookmarkService } from '@pkg/main/bookmarks/bookmarkService';
import { listDockerLinks } from '@pkg/main/dockerLinks';
import { getIpcMainProxy } from '@pkg/main/ipcMain';
import Logging from '@pkg/utils/logging';

export { fetchFaviconDataUrl } from '@pkg/main/bookmarks/bookmarkService';

const console = Logging.background;
const ipcMainProxy = getIpcMainProxy(console);

function trusted(event: Electron.IpcMainInvokeEvent): void {
  if (!BrowserWindow.fromWebContents(event.sender) || event.senderFrame !== event.sender.mainFrame ||
      !/^(file:|app:)/.test(event.senderFrame?.url || '')) {
    throw new Error('Only the Desktop application can manage bookmarks.');
  }
}

export function initBookmarksIpc(): void {
  ipcMainProxy.handle('bookmarks:list', async(event) => {
    trusted(event);

    return bookmarkService.list();
  });

  ipcMainProxy.handle('bookmarks:create', async(event, input) => {
    trusted(event);

    return bookmarkService.create({
      kind:     input?.kind === 'folder' ? 'folder' : 'bookmark',
      title:    input?.title,
      url:      input?.url,
      parentId: input?.parentId ?? null,
      tabId:    typeof input?.tabId === 'string' ? input.tabId : undefined,
    });
  });

  ipcMainProxy.handle('bookmarks:update', async(event, id, input) => {
    trusted(event);

    return bookmarkService.update(id, { title: input?.title, url: input?.url });
  });

  ipcMainProxy.handle('bookmarks:delete', async(event, id) => {
    trusted(event);

    return bookmarkService.remove(id, { recursive: true });
  });

  ipcMainProxy.handle('bookmarks:move', async(event, id, parentId, index) => {
    trusted(event);
    await bookmarkService.move(id, parentId ?? null, Number(index));
  });

  // Live, read-only "Docker" section: running containers with open ports.
  ipcMainProxy.handle('bookmarks:docker-links', async(event) => {
    trusted(event);

    return listDockerLinks();
  });
}
