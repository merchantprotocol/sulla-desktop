// tabsIpc.ts — Thin read-only IPC surface for the renderer UI.
//
// Flow: main owns the tab list (TabRegistry). UI asks "what tabs are open?"
// and subscribes to pushes. UI never tells main "add this tab" — user tab
// opens come through a single `tabs:open` handler, same path the agent uses.
//
// There is NO reactive two-way sync. Renderer mirrors main's state; that's it.

import { ipcMain, webContents } from 'electron';

import { tabRegistry, type TabRecord } from './TabRegistry';
import { getBrowserSession } from './browserSession';

import { safeSend } from '@pkg/utils/safeSend';

const CHANGE_CHANNEL = 'tabs:change';

export function initTabsIpc(): void {
  ipcMain.handle('tabs:list', (): TabRecord[] => tabRegistry.list());
  ipcMain.handle('tabs:active', (): string | null => tabRegistry.getActiveAssetId());

  ipcMain.handle('tabs:open', (_event, payload: { assetId?: string; url: string; title?: string }) => {
    const assetId = payload.assetId || `user_${ Date.now().toString(36) }_${ Math.random().toString(36).slice(2, 8) }`;
    return tabRegistry.open({ assetId, url: payload.url, title: payload.title, origin: 'user' });
  });

  ipcMain.handle('tabs:close', (_event, assetId: string) => tabRegistry.close(assetId));

  ipcMain.handle('tabs:setActive', (_event, assetId: string) => {
    tabRegistry.setActive(assetId);
  });

  // Broadcast changes to Sulla's own renderers. Browser-tab guests (and their
  // popups) share the browser session and are skipped: they never listen on
  // this channel, and pushing every open tab's URL and title into arbitrary
  // web pages' processes is both wasted IPC and a privacy leak. Disposed
  // WebContents are dropped by safeSend.
  tabRegistry.onChange((tabs) => {
    const browserSession = getBrowserSession();

    for (const wc of webContents.getAllWebContents()) {
      if (wc.session === browserSession) continue;
      safeSend(wc, CHANGE_CHANNEL, tabs);
    }
  });
}
