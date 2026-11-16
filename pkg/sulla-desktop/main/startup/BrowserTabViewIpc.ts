// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { startEventLoopLagMonitor } from '@pkg/main/eventLoopLagMonitor';

import type { MainProcessIpcContext, MainProcessIpcStep } from './MainProcessIpcContext';

/** WebContentsView-backed browser tabs: create, navigate, bounds, focus and script execution. */
export class BrowserTabViewIpc implements MainProcessIpcStep {
  readonly name = 'browser-tab-views';

  async register(ctx: MainProcessIpcContext): Promise<void> {
    const { ipc } = ctx;

    // ── Browser Tab Views (WebContentsView-based) ─────────────────────────────
    const { BrowserTabViewManager } = await import('@pkg/window/browserTabViewManager');
    const tabViewManager = BrowserTabViewManager.getInstance();

    ctx.tabViewManager = tabViewManager;
    startEventLoopLagMonitor();

    const { tabRegistry } = await import('@pkg/main/browserTabs/TabRegistry');

    // Renderer asks main to ensure a WebContentsView exists for `tabId` pointing
    // at `url`. Idempotent: if it already exists, navigate it to the new URL.
    // View bounds are set separately via 'browser-tab-view:set-bounds' once the
    // UI knows where to render. This is the single entry point into the
    // TabRegistry from the UI; agent tools call tabRegistry.open() directly.
    ipc.handle('browser-tab-view:create', async(_event: Electron.IpcMainInvokeEvent, tabId: string, url: string, _bounds: Electron.Rectangle) => {
      tabRegistry.open({ assetId: tabId, url, origin: 'user' });
    });

    ipc.handle('browser-tab-view:destroy', async(_event: Electron.IpcMainInvokeEvent, tabId: string) => {
      tabRegistry.close(tabId);
    });

    ipc.handle('browser-tab-view:navigate', async(_event: Electron.IpcMainInvokeEvent, tabId: string, url: string) => {
      tabViewManager.navigateTo(tabId, url);
    });

    ipc.handle('browser-tab-view:go-back', async(_event: Electron.IpcMainInvokeEvent, tabId: string) => {
      tabViewManager.goBack(tabId);
    });

    ipc.handle('browser-tab-view:go-forward', async(_event: Electron.IpcMainInvokeEvent, tabId: string) => {
      tabViewManager.goForward(tabId);
    });

    ipc.handle('browser-tab-view:reload', async(_event: Electron.IpcMainInvokeEvent, tabId: string) => {
      tabViewManager.reload(tabId);
    });

    ipc.handle('browser-tab-view:stop', async(_event: Electron.IpcMainInvokeEvent, tabId: string) => {
      tabViewManager.stop(tabId);
    });

    ipc.handle('browser-tab-view:set-bounds', async(_event: Electron.IpcMainInvokeEvent, tabId: string, bounds: Electron.Rectangle) => {
      tabViewManager.setBounds(tabId, bounds);
    });

    // Single authoritative visibility channel. Renderer emits one event
    // whenever its computed "which tab should be visible right now" changes.
    // A hidden-tab clear includes the originating tab id so stale watcher
    // events from the previously visible tab cannot hide the newly active tab.
    ipc.handle('browser-tab-view:focus', async(_event: Electron.IpcMainInvokeEvent, tabId: string | null, clearOnlyIfFocusedTabId?: string, sentAt?: number) => {
      tabViewManager.setFocusedTab(tabId, clearOnlyIfFocusedTabId, sentAt);
    });

    // A chrome text field (chat composer, address bar) lost focus without any
    // human action in the chrome — e.g. an agent opening/driving tabs.
    ipc.handle('browser-tab-view:reclaim-chrome-focus', async(event: Electron.IpcMainInvokeEvent) => {
      return tabViewManager.reclaimChromeFocus(event.sender);
    });

    ipc.handle('browser-tab-view:exec-js', async(_event: Electron.IpcMainInvokeEvent, tabId: string, code: string) => {
      return tabViewManager.executeJavaScript(tabId, code);
    });
  }
}
