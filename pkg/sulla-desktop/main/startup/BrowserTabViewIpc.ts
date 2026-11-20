// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { startEventLoopLagMonitor } from '@pkg/main/eventLoopLagMonitor';
import { agentWindowFromSender } from '@pkg/window/agentWindowTrust';

import type { MainProcessIpcContext, MainProcessIpcStep } from './MainProcessIpcContext';

export function focusTabForOwner(setFocused: () => void, tabId: string | null, owner: Electron.BrowserWindow, currentOwner: Electron.BrowserWindow | null): void {
  if (tabId && !currentOwner) return;
  if (currentOwner && currentOwner !== owner) return;
  setFocused();
}

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
    const ownerWindow = (event: Electron.IpcMainInvokeEvent): Electron.BrowserWindow => {
      const owner = agentWindowFromSender(event.sender);
      if (!owner || owner.isDestroyed()) throw new Error('Untrusted browser tab caller');
      return owner;
    };
    const assertOwner = (event: Electron.IpcMainInvokeEvent, tabId: string): Electron.BrowserWindow => {
      const owner = ownerWindow(event);
      if (!tabViewManager.ownsTab(tabId, owner)) throw new Error(`Browser tab "${ tabId }" is not owned by this window`);
      return owner;
    };

    // Renderer asks main to ensure a WebContentsView exists for `tabId` pointing
    // at `url`. Existing records attach idempotently; only explicit navigation
    // may change their URL (the renderer can hold stale graph-owned metadata).
    // View bounds are set separately via 'browser-tab-view:set-bounds' once the
    // UI knows where to render. This is the single entry point into the
    // TabRegistry from the UI; agent tools call tabRegistry.open() directly.
    ipc.handle('browser-tab-view:create', async(event: Electron.IpcMainInvokeEvent, tabId: string, url: string, _bounds: Electron.Rectangle) => {
      const owner = ownerWindow(event);
      if (tabRegistry.get(tabId)) {
        // Window custody authorizes attachment, not graph-session navigation.
        // Do not reopen as an unbound caller or change URL/owner/activation.
        assertOwner(event, tabId);
        return;
      }
      tabRegistry.open({ assetId: tabId, url, origin: 'user', ownerWindow: owner });
    });

    ipc.handle('browser-tab-view:destroy', async(event: Electron.IpcMainInvokeEvent, tabId: string) => {
      assertOwner(event, tabId);
      if (tabViewManager.isTransferring(tabId)) return;
      tabRegistry.close(tabId);
    });

    ipc.handle('browser-tab-view:navigate', async(event: Electron.IpcMainInvokeEvent, tabId: string, url: string) => {
      assertOwner(event, tabId);
      tabViewManager.navigateTo(tabId, url);
    });

    ipc.handle('browser-tab-view:go-back', async(event: Electron.IpcMainInvokeEvent, tabId: string) => {
      assertOwner(event, tabId);
      tabViewManager.goBack(tabId);
    });

    ipc.handle('browser-tab-view:go-forward', async(event: Electron.IpcMainInvokeEvent, tabId: string) => {
      assertOwner(event, tabId);
      tabViewManager.goForward(tabId);
    });

    ipc.handle('browser-tab-view:reload', async(event: Electron.IpcMainInvokeEvent, tabId: string) => {
      assertOwner(event, tabId);
      tabViewManager.reload(tabId);
    });

    ipc.handle('browser-tab-view:stop', async(event: Electron.IpcMainInvokeEvent, tabId: string) => {
      assertOwner(event, tabId);
      tabViewManager.stop(tabId);
    });

    ipc.handle('browser-tab-view:set-bounds', async(event: Electron.IpcMainInvokeEvent, tabId: string, bounds: Electron.Rectangle) => {
      const owner = ownerWindow(event);
      const currentOwner = tabViewManager.getOwnerWindow(tabId);
      if (!currentOwner) return;
      if (currentOwner !== owner) {
        // An in-flight renderer bounds update can cross a window-transfer boundary.
        // Ignore it without weakening ownership: setBounds is never called for a non-owner.
        console.debug(`[BrowserTabViewIpc] ignored stale bounds from non-owner window=${ owner.id } tabId=${ tabId }`);
        return;
      }
      tabViewManager.setBounds(tabId, bounds, owner);
    });

    // Single authoritative visibility channel. Renderer emits one event
    // whenever its computed "which tab should be visible right now" changes.
    // A hidden-tab clear includes the originating tab id so stale watcher
    // events from the previously visible tab cannot hide the newly active tab.
    ipc.handle('browser-tab-view:focus', async(event: Electron.IpcMainInvokeEvent, tabId: string | null, clearOnlyIfFocusedTabId?: string, sentAt?: number) => {
      const owner = ownerWindow(event);
      const tabOwner = tabId ? tabViewManager.getOwnerWindow(tabId) : null;
      const clearOwner = clearOnlyIfFocusedTabId ? tabViewManager.getOwnerWindow(clearOnlyIfFocusedTabId) : null;
      if (clearOwner && clearOwner !== owner) {
        console.debug(`[BrowserTabViewIpc] ignored stale focus update from non-owner window=${ owner.id } tabId=${ clearOnlyIfFocusedTabId }`);
        return;
      }
      focusTabForOwner(() => tabViewManager.setFocusedTab(tabId, clearOnlyIfFocusedTabId, sentAt, owner), tabId, owner, tabOwner);
    });

    // A chrome text field (chat composer, address bar) lost focus without any
    // human action in the chrome — e.g. an agent opening/driving tabs.
    ipc.handle('browser-tab-view:reclaim-chrome-focus', async(event: Electron.IpcMainInvokeEvent) => {
      return tabViewManager.reclaimChromeFocus(event.sender);
    });

    ipc.handle('browser-tab-view:exec-js', async(event: Electron.IpcMainInvokeEvent, tabId: string, code: string) => {
      assertOwner(event, tabId);
      return tabViewManager.executeJavaScript(tabId, code);
    });
  }
}
