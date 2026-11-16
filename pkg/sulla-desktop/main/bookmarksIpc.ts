// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

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

import type { IpcController, IpcRegistrar } from './ipc/IpcController';

export { fetchFaviconDataUrl } from '@pkg/main/bookmarks/bookmarkService';

/** The bookmarkService surface this controller uses. */
export interface BookmarksIpcService {
  list(): Promise<unknown>;
  create(input: { kind: 'folder' | 'bookmark'; title?: string; url?: string; parentId: string | null; tabId?: string }): Promise<unknown>;
  update(id: string, input: { title?: string; url?: string }): Promise<unknown>;
  remove(id: string, opts: { recursive: boolean }): Promise<unknown>;
  move(id: string, parentId: string | null, index: number): Promise<unknown>;
}

export interface BookmarksIpcDependencies {
  bookmarks: BookmarksIpcService;
  /** Wires artifact bookmark sync before channels exist (old init order). */
  configureArtifactSync(): void;
  listDockerLinks(): Promise<unknown>;
  /** True when the sender is a Desktop app window (not a web page). */
  isAppWindow(sender: Electron.WebContents): boolean;
}

/** bookmarks:* — only Desktop app frames may manage bookmarks. */
export class BookmarksIpcController implements IpcController {
  constructor(private readonly ipc: IpcRegistrar, private readonly deps: BookmarksIpcDependencies) {}

  trusted(event: Electron.IpcMainInvokeEvent): void {
    if (!this.deps.isAppWindow(event.sender) || event.senderFrame !== event.sender.mainFrame ||
        !/^(file:|app:)/.test(event.senderFrame?.url || '')) {
      throw new Error('Only the Desktop application can manage bookmarks.');
    }
  }

  register(): void {
    const { bookmarks } = this.deps;
    this.deps.configureArtifactSync();

    this.ipc.handle('bookmarks:list', async(event) => {
      this.trusted(event);

      return bookmarks.list();
    });

    this.ipc.handle('bookmarks:create', async(event, input) => {
      this.trusted(event);

      return bookmarks.create({
        kind:     input?.kind === 'folder' ? 'folder' : 'bookmark',
        title:    input?.title,
        url:      input?.url,
        parentId: input?.parentId ?? null,
        tabId:    typeof input?.tabId === 'string' ? input.tabId : undefined,
      });
    });

    this.ipc.handle('bookmarks:update', async(event, id, input) => {
      this.trusted(event);

      return bookmarks.update(id, { title: input?.title, url: input?.url });
    });

    this.ipc.handle('bookmarks:delete', async(event, id) => {
      this.trusted(event);

      return bookmarks.remove(id, { recursive: true });
    });

    this.ipc.handle('bookmarks:move', async(event, id, parentId, index) => {
      this.trusted(event);
      await bookmarks.move(id, parentId ?? null, Number(index));
    });

    // Live, read-only "Docker" section: running containers with open ports.
    this.ipc.handle('bookmarks:docker-links', async(event) => {
      this.trusted(event);

      return this.deps.listDockerLinks();
    });
  }
}
