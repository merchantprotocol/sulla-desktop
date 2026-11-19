// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import Electron, { WebContentsView } from 'electron';
import type { WorkspaceTabRequest } from '@pkg/shared/workspaceTabRequest';
import { agentWindowUrl } from './agentWindowUrl';
import { AppStartupTelemetry } from '@pkg/main/startup/AppStartupTelemetry';

interface InternalTabView { view: WebContentsView; owner: Electron.BrowserWindow; bounds: Electron.Rectangle; visible: boolean; crashed: boolean; transferring: boolean; running?: boolean; descriptor?: unknown }

/** Owns one isolated Electron renderer for each mounted internal tab. */
export class InternalTabViewManager {
  private static instance: InternalTabViewManager;
  private readonly tabs = new Map<string, InternalTabView>();
  private readonly hostDisposalListeners = new Map<string, Set<() => void>>();

  static getInstance(): InternalTabViewManager {
    this.instance ??= new InternalTabViewManager();
    return this.instance;
  }

  activate(owner: Electron.BrowserWindow, tabId: string, windowKey: string, bounds: Electron.Rectangle, descriptor?: unknown): void {
    let tab = this.tabs.get(tabId);
    if (!tab) {
      const view = new WebContentsView({ webPreferences: { devTools: !Electron.app.isPackaged, nodeIntegration: true, contextIsolation: false, webviewTag: true, webSecurity: false } });
      // The descriptor must be stored before the renderer loads: the host reads it synchronously at boot.
      tab = { view, owner, bounds, visible: true, crashed: false, transferring: false, descriptor };
      this.tabs.set(tabId, tab);
      this.trackOwner(owner);
      view.webContents.on('did-finish-load', () => {
        // The shell can still be settling its layout while the isolated host boots.
        // Ask it to re-read the live DOM rect rather than trusting activation bounds.
        if (this.tabs.get(tabId) === tab && !tab!.owner.isDestroyed()) {
          tab!.owner.webContents.send('internal-tab-view:loaded', tabId);
        }
      });
      view.webContents.on('render-process-gone', () => {
        tab!.visible = false;
        tab!.crashed = true;
        this.clearChatRunning(tabId, tab!);
        try { tab!.owner.contentView.removeChildView(view); } catch { /* already detached */ }
        this.notifyHostDisposed(tabId);
        tab!.owner.webContents.send('internal-tab-view:crashed', tabId);
      });
      const url = agentWindowUrl(`tabHost=1&tabId=${ encodeURIComponent(tabId) }&windowKey=${ encodeURIComponent(windowKey) }&startupId=${ encodeURIComponent(AppStartupTelemetry.startupId) }`);
      void view.webContents.loadURL(url);
    } else if (tab.owner !== owner) {
      this.moveToWindow(tabId, owner);
      tab = this.tabs.get(tabId)!;
    }
    tab.bounds = bounds;
    if (descriptor !== undefined) tab.descriptor = descriptor;
    if (tab.crashed) return;
    tab.visible = true;
    tab.owner.contentView.addChildView(tab.view);
    tab.view.setBounds(bounds);
  }

  setBounds(owner: Electron.BrowserWindow, tabId: string, bounds: Electron.Rectangle): void {
    const tab = this.tabs.get(tabId);
    if (!tab || tab.owner !== owner) return;
    tab.bounds = bounds;
    if (tab.visible) tab.view.setBounds(bounds);
  }

  notifyTabUpdate(sender: Electron.WebContents, tabId: string, descriptor: unknown): void {
    const tab = this.tabs.get(tabId);
    if (tab && tab.view.webContents === sender && !tab.owner.isDestroyed()) {
      tab.descriptor = descriptor;
      tab.owner.webContents.send('internal-tab-view:updated', tabId, descriptor);
    }
  }

  openWorkspaceTab(sender: Electron.WebContents, input: unknown): void {
    const owner = this.resolveOwner(sender);
    if (!owner || sender.isDestroyed() || !input || typeof input !== 'object') throw new Error('Invalid workspace tab request');
    const request = input as WorkspaceTabRequest;
    const file = request.mode === 'paper' ? request.documentFile : request.mode === 'files' ? request.filesNavigation : null;
    if (file && typeof file.fileId === 'string' && file.fileId && typeof file.path === 'string' && file.path) {
      const { fileId, path, collectionId } = file;
      const identity = { fileId, path, collectionId: typeof collectionId === 'string' ? collectionId : undefined };
      if (request.mode === 'paper') {
        owner.webContents.send('internal-tab-view:open-workspace-tab', { mode: 'paper', documentFile: identity });
        return;
      }
      if (request.mode === 'files' && typeof request.title === 'string') {
        owner.webContents.send('internal-tab-view:open-workspace-tab', {
          mode: 'files', title: request.title, filesNavigation: { ...identity, section: 'detail' },
        });
        return;
      }
    }
    if (request.mode === 'chat' && typeof request.title === 'string'
        && typeof request.initialAgentId === 'string' && request.initialAgentId.trim()) {
      owner.webContents.send('internal-tab-view:open-workspace-tab', {
        mode: 'chat', title: request.title, initialAgentId: request.initialAgentId,
      });
      return;
    }
    throw new Error('Invalid workspace tab request');
  }

  notifyChatRunning(sender: Electron.WebContents, tabId: string, running: boolean): void {
    const tab = this.tabs.get(tabId);
    if (tab?.view.webContents !== sender || tab.crashed || tab.owner.isDestroyed()) return;
    if (Boolean(tab.running) === running) return;
    tab.running = running;
    tab.owner.webContents.send('internal-tab-view:chat-running', tabId, running);
  }

  private clearChatRunning(tabId: string, tab: InternalTabView): void {
    if (!tab.running) return;
    tab.running = false;
    if (!tab.owner.isDestroyed()) tab.owner.webContents.send('internal-tab-view:chat-running', tabId, false);
  }

  /**
   * The tab a host renderer was created for, as its owner window last described it.
   * Only that tab's own renderer may read it.
   */
  descriptorFor(sender: Electron.WebContents, tabId: string): unknown {
    const tab = this.tabs.get(tabId);
    return tab && tab.view.webContents === sender ? tab.descriptor ?? null : null;
  }

  setVisible(owner: Electron.BrowserWindow, tabId: string, visible: boolean): void {
    const tab = this.tabs.get(tabId);
    if (!tab || tab.owner !== owner) return;
    tab.visible = visible;
    if (visible) { owner.contentView.addChildView(tab.view); tab.view.setBounds(tab.bounds); }
    else owner.contentView.removeChildView(tab.view);
  }

  reload(owner: Electron.BrowserWindow, tabId: string): void {
    const tab = this.tabs.get(tabId);
    if (tab?.owner === owner && !tab.view.webContents.isDestroyed()) {
      this.clearChatRunning(tabId, tab);
      tab.crashed = false;
      tab.visible = true;
      tab.owner.contentView.addChildView(tab.view);
      tab.view.setBounds(tab.bounds);
      tab.view.webContents.reload();
    }
  }

  moveToWindow(tabId: string, target: Electron.BrowserWindow): boolean {
    const tab = this.tabs.get(tabId);
    if (!tab || target.isDestroyed()) return false;
    if (tab.owner !== target) {
      this.notifyHostDisposed(tabId);
      try { tab.owner.contentView.removeChildView(tab.view); } catch { /* already detached */ }
      const running = tab.running;
      this.clearChatRunning(tabId, tab);
      tab.owner = target;
      this.trackOwner(target);
      if (running) this.notifyChatRunning(tab.view.webContents, tabId, true);
    }
    if (tab.visible) { target.contentView.addChildView(tab.view); tab.view.setBounds(tab.bounds); }
    return true;
  }

  resolveOwner(sender: Electron.WebContents): Electron.BrowserWindow | null {
    for (const tab of this.tabs.values()) if (tab.view.webContents === sender && !tab.owner.isDestroyed()) return tab.owner;
    return null;
  }

  /** Resolve only the registered tab host that owns this renderer. */
  hostViewForSender(sender: Electron.WebContents): WebContentsView | null {
    for (const tab of this.tabs.values()) if (tab.view.webContents === sender && !sender.isDestroyed()) return tab.view;
    return null;
  }

  /** Subscribe to terminal host disposal; ordinary tab switches keep children attached. */
  onHostDisposed(sender: Electron.WebContents, listener: () => void): (() => void) | null {
    const tabId = [...this.tabs].find(([, tab]) => tab.view.webContents === sender)?.[0];
    if (!tabId || sender.isDestroyed()) return null;
    let listeners = this.hostDisposalListeners.get(tabId);
    if (!listeners) this.hostDisposalListeners.set(tabId, listeners = new Set());
    listeners.add(listener);
    return () => {
      listeners?.delete(listener);
      if (!listeners?.size) this.hostDisposalListeners.delete(tabId);
    };
  }

  private notifyHostDisposed(tabId: string): void {
    const listeners = this.hostDisposalListeners.get(tabId);
    this.hostDisposalListeners.delete(tabId);
    for (const listener of listeners ?? []) listener();
  }

  markTransferring(tabId: string, transferring: boolean): void {
    const tab = this.tabs.get(tabId);
    if (tab) tab.transferring = transferring;
  }

  destroy(owner: Electron.BrowserWindow, tabId: string): void {
    const tab = this.tabs.get(tabId);
    if (!tab || tab.owner !== owner || tab.transferring) return;
    this.clearChatRunning(tabId, tab);
    try { owner.contentView.removeChildView(tab.view); } catch { /* already detached */ }
    this.notifyHostDisposed(tabId);
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    this.tabs.delete(tabId);
  }

  /** Release every tab-host renderer after the graceful shutdown phases finish. */
  destroyAll(): void {
    for (const [tabId, tab] of this.tabs) {
      try { tab.owner.contentView.removeChildView(tab.view); } catch { /* already detached */ }
      this.notifyHostDisposed(tabId);
      if (!tab.view.webContents.isDestroyed()) {
        try { tab.view.webContents.close({ waitForBeforeUnload: false }); } catch { /* already gone */ }
      }
      this.tabs.delete(tabId);
    }
  }

  private readonly owners = new Set<number>();
  private trackOwner(owner: Electron.BrowserWindow): void {
    if (this.owners.has(owner.id)) return;
    this.owners.add(owner.id);
    owner.once('closed', () => {
      this.owners.delete(owner.id);
      for (const [id, tab] of this.tabs) if (tab.owner === owner) this.destroy(owner, id);
    });
  }
}
