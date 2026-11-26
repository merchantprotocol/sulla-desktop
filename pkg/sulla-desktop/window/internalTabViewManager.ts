// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import Electron, { WebContentsView } from 'electron';

import { agentWindowUrl } from './agentWindowUrl';
import { isChatTabActivitySnapshot, type ChatTabActivitySnapshot } from '../shared/ChatTabActivity';
import { DURABLE_FILE_ID_PATTERN } from '../shared/filesReferences';

import { STARTUP_BACKGROUND } from '@pkg/config/theme';
import { AppStartupTelemetry } from '@pkg/main/startup/AppStartupTelemetry';
import type { WorkspaceTabRequest } from '@pkg/shared/workspaceTabRequest';

type HostLayoutListener = (bounds: Electron.Rectangle | null, raised: boolean) => void;

interface InternalTabView { view: WebContentsView; owner: Electron.BrowserWindow; bounds: Electron.Rectangle; visible: boolean; crashed: boolean; transferring: boolean; running?: boolean; activity?: ChatTabActivitySnapshot; activityForwarded: boolean; descriptor?: unknown }

/** Owns one isolated Electron renderer for each mounted internal tab. */
export class InternalTabViewManager {
  private static instance: InternalTabViewManager;
  private readonly tabs = new Map<string, InternalTabView>();
  private readonly hostLayoutListeners = new Map<InternalTabView, Set<HostLayoutListener>>();
  private readonly hostDisposalListeners = new Map<string, Set<() => void>>();
  private readonly chromeReadyOwners = new Set<number>();
  private shuttingDown = false;
  private readonly chromeReadyTimers = new Map<number, ReturnType<typeof setTimeout>>();

  static getInstance(): InternalTabViewManager {
    this.instance ??= new InternalTabViewManager();
    return this.instance;
  }

  activate(owner: Electron.BrowserWindow, tabId: string, windowKey: string, bounds: Electron.Rectangle, descriptor?: unknown): void {
    let tab = this.tabs.get(tabId);
    if (!tab) {
      const view = new WebContentsView({ webPreferences: { devTools: !Electron.app.isPackaged, nodeIntegration: true, contextIsolation: false, webviewTag: true, webSecurity: false, backgroundThrottling: !(descriptor && typeof descriptor === 'object' && (descriptor as { mode?: unknown }).mode === 'capture-studio') } });
      view.setBackgroundColor(STARTUP_BACKGROUND);
      // The descriptor must be stored before the renderer loads: the host reads it synchronously at boot.
      tab = {
        view,
        owner,
        bounds,
        visible:           true,
        crashed:           false,
        transferring:      false,
        activityForwarded: false,
        descriptor,
      };
      this.tabs.set(tabId, tab);
      this.trackOwner(owner);
      this.armChromeReadyFallback(owner);
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
    if (this.chromeReadyOwners.has(owner.id)) {
      this.attach(tab);
      this.forwardChatActivity(tabId, tab);
    }
  }

  /** Called after the shell chrome has mounted and its first frame has painted. */
  markChromeReady(owner: Electron.BrowserWindow): void {
    if (owner.isDestroyed() || this.shuttingDown) return;
    this.chromeReadyOwners.add(owner.id);
    const timer = this.chromeReadyTimers.get(owner.id);
    if (timer) clearTimeout(timer);
    this.chromeReadyTimers.delete(owner.id);
    owner.webContents.send('internal-tab-view:chrome-ready');
    for (const [tabId, tab] of this.tabs) {
      if (tab.owner !== owner || tab.crashed) continue;
      if (tab.visible) this.attach(tab);
      this.forwardChatActivity(tabId, tab);
    }
  }

  private armChromeReadyFallback(owner: Electron.BrowserWindow): void {
    if (this.shuttingDown || this.chromeReadyOwners.has(owner.id) || this.chromeReadyTimers.has(owner.id)) return;
    const timer = setTimeout(() => {
      this.chromeReadyTimers.delete(owner.id);
      if (owner.isDestroyed() || this.chromeReadyOwners.has(owner.id)) return;
      console.warn(`[InternalTabViewManager] shell startup readiness timed out after 5 minutes for window ${ owner.id }; revealing tabs`);
      this.markChromeReady(owner);
    }, 5 * 60_000);
    (timer as any).unref?.();
    this.chromeReadyTimers.set(owner.id, timer);
  }

  private attach(tab: InternalTabView): void {
    if (this.shuttingDown || tab.owner.isDestroyed() || tab.crashed || !tab.visible) return;
    tab.owner.contentView.addChildView(tab.view);
    tab.view.setBounds(tab.bounds);
    this.notifyHostLayout(tab, true);
  }

  setBounds(owner: Electron.BrowserWindow, tabId: string, bounds: Electron.Rectangle): void {
    const tab = this.tabs.get(tabId);
    if (!tab || tab.owner !== owner) return;
    tab.bounds = bounds;
    if (tab.visible) tab.view.setBounds(bounds);
    this.notifyHostLayout(tab);
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
    if (request.mode === 'files' && request.filesNavigation === undefined && typeof request.title === 'string') {
      owner.webContents.send('internal-tab-view:open-workspace-tab', { mode: 'files', title: request.title });
      return;
    }
    const file = request.mode === 'paper' ? request.documentFile : request.mode === 'files' ? request.filesNavigation : null;
    if (file && typeof file.fileId === 'string' && file.fileId && typeof file.path === 'string' && file.path) {
      const { fileId, path, collectionId } = file;
      const identity = { fileId, path, collectionId: typeof collectionId === 'string' ? collectionId : undefined };
      if (request.mode === 'paper') {
        owner.webContents.send('internal-tab-view:open-workspace-tab', { mode: 'paper', documentFile: identity });
        return;
      }
      if (request.mode === 'files' && request.filesNavigation && typeof request.title === 'string') {
        const { section, versionId } = request.filesNavigation;
        if (!DURABLE_FILE_ID_PATTERN.test(fileId)
            || !['detail', 'versions', 'share-review'].includes(section)
            || (versionId !== undefined && (typeof versionId !== 'string' || !DURABLE_FILE_ID_PATTERN.test(versionId)))) {
          throw new Error('Invalid Files reference');
        }
        owner.webContents.send('internal-tab-view:open-workspace-tab', {
          mode: 'files', title: request.title, filesNavigation: { ...identity, section, ...(versionId === undefined ? {} : { versionId }) },
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

  notifyChatRunning(sender: Electron.WebContents, tabId: string, running: boolean, input?: unknown): void {
    const tab = this.tabs.get(tabId);
    if (tab?.view.webContents !== sender || tab.crashed || tab.owner.isDestroyed()) return;
    const activity = isChatTabActivitySnapshot(input) ? input : tab.activity;
    if (tab.running === running && sameActivity(tab.activity, activity) && tab.activityForwarded) return;
    tab.running = running;
    tab.activity = activity;
    this.forwardChatActivity(tabId, tab);
  }

  private clearChatRunning(tabId: string, tab: InternalTabView): void {
    const wasActive = tab.running || (tab.activity && !sameActivity(tab.activity, this.idleChatActivity()));
    tab.running = tab.running === undefined && !tab.activity ? undefined : false;
    tab.activity = undefined;
    if (wasActive) this.forwardChatActivity(tabId, tab);
  }

  private forwardChatActivity(tabId: string, tab: InternalTabView): void {
    if (tab.owner.isDestroyed()) return;
    if (tab.running === undefined && !tab.activity && !this.isChatTabDescriptor(tab.descriptor)) return;
    const activity = tab.activity ?? (tab.running
      ? { state: 'working' as const, detail: 'Sulla is working' }
      : this.idleChatActivity());

    tab.owner.webContents.send('internal-tab-view:chat-running', tabId, Boolean(tab.running), activity);
    tab.activityForwarded = true;
  }

  private idleChatActivity(): ChatTabActivitySnapshot {
    return { state: 'idle', detail: 'nothing running or scheduled' };
  }

  private isChatTabDescriptor(descriptor: unknown): boolean {
    if (!descriptor || typeof descriptor !== 'object') return false;
    const mode = (descriptor as { mode?: unknown }).mode;
    return mode === 'chat' || mode === 'conversations' || mode === 'secretary';
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
    if (visible) {
      if (this.chromeReadyOwners.has(owner.id)) this.attach(tab);
    } else {
      this.notifyHostLayout(tab);
      owner.contentView.removeChildView(tab.view);
    }
  }

  reload(owner: Electron.BrowserWindow, tabId: string): void {
    const tab = this.tabs.get(tabId);
    if (tab?.owner === owner && !tab.view.webContents.isDestroyed()) {
      this.clearChatRunning(tabId, tab);
      tab.crashed = false;
      tab.visible = true;
      if (this.chromeReadyOwners.has(owner.id)) this.attach(tab);
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
      const activity = tab.activity;
      this.clearChatRunning(tabId, tab);
      tab.owner = target;
      this.trackOwner(target);
      tab.activityForwarded = false;
      tab.running = running;
      tab.activity = activity;
      this.forwardChatActivity(tabId, tab);
    }
    this.armChromeReadyFallback(target);
    if (tab.visible && this.chromeReadyOwners.has(target.id)) this.attach(tab);
    return true;
  }

  /** Find the live host window for a tab descriptor matching the predicate. */
  ownerForDescriptor(predicate: (descriptor: unknown) => boolean): Electron.BrowserWindow | null {
    for (const tab of this.tabs.values()) {
      if (tab.descriptor !== undefined && predicate(tab.descriptor) && !tab.owner.isDestroyed()) return tab.owner;
    }
    return null;
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

  /** Report the tab's window-relative rectangle while its native view is attached. */
  observeHostLayout(sender: Electron.WebContents, listener: HostLayoutListener): () => void {
    const tab = [...this.tabs.values()].find(candidate => candidate.view.webContents === sender);
    if (!tab || sender.isDestroyed()) {
      listener(null, false);
      return () => {};
    }
    const listeners = this.hostLayoutListeners.get(tab) ?? new Set();
    listeners.add(listener);
    this.hostLayoutListeners.set(tab, listeners);
    listener(this.hostBounds(tab), false);

    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.hostLayoutListeners.delete(tab);
    };
  }

  private hostBounds(tab: InternalTabView): Electron.Rectangle | null {
    return !this.shuttingDown && tab.visible && !tab.crashed && this.chromeReadyOwners.has(tab.owner.id)
      ? tab.bounds
      : null;
  }

  private notifyHostLayout(tab: InternalTabView, raised = false): void {
    for (const listener of this.hostLayoutListeners.get(tab) ?? []) listener(this.hostBounds(tab), raised);
  }

  /** Subscribe to terminal host disposal without treating a tab switch as closure. */
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

  /** Detach native tab surfaces before the shutdown overlay paints, without destroying their renderers yet. */
  beginShutdown(): void {
    this.stopReadinessFallbacks();
    for (const tab of this.tabs.values()) {
      this.notifyHostLayout(tab);
      if (tab.owner.isDestroyed()) continue;
      try { tab.owner.contentView.removeChildView(tab.view); } catch { /* already detached */ }
    }
  }

  /** Release every tab-host renderer after the graceful shutdown phases finish. */
  destroyAll(): void {
    this.stopReadinessFallbacks();
    for (const [tabId, tab] of this.tabs) {
      try { tab.owner.contentView.removeChildView(tab.view); } catch { /* already detached */ }
      this.clearChatRunning(tabId, tab);
      this.notifyHostDisposed(tabId);
      if (!tab.view.webContents.isDestroyed()) {
        try { tab.view.webContents.close({ waitForBeforeUnload: false }); } catch { /* already gone */ }
      }
      this.tabs.delete(tabId);
    }
  }

  private stopReadinessFallbacks(): void {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    for (const timer of this.chromeReadyTimers.values()) clearTimeout(timer);
    this.chromeReadyTimers.clear();
  }

  private readonly owners = new Set<number>();
  private trackOwner(owner: Electron.BrowserWindow): void {
    if (this.owners.has(owner.id)) return;
    this.owners.add(owner.id);
    owner.once('closed', () => {
      this.owners.delete(owner.id);
      this.chromeReadyOwners.delete(owner.id);
      const timer = this.chromeReadyTimers.get(owner.id);
      if (timer) clearTimeout(timer);
      this.chromeReadyTimers.delete(owner.id);
      for (const [id, tab] of this.tabs) if (tab.owner === owner) this.destroy(owner, id);
    });
  }
}

function sameActivity(left?: ChatTabActivitySnapshot, right?: ChatTabActivitySnapshot): boolean {
  return left?.state === right?.state && left?.detail === right?.detail && left?.active === right?.active;
}
