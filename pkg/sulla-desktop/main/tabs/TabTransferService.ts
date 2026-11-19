// SPDX-License-Identifier: GPL-2.0-or-later
// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.

import type { App, BrowserWindow, BrowserWindowConstructorOptions, IpcMain, IpcMainEvent, Screen } from 'electron';

import type { BrowserTabViewManager } from '@pkg/window/browserTabViewManager';
import { InternalTabViewManager } from '@pkg/window/internalTabViewManager';
import type { AgentWindowOptions } from '@pkg/window/agentWindows';

interface TransferPayload {
  tabId: string;
  descriptor: Record<string, unknown>;
  transient?: Record<string, unknown>;
  tabCount?: number;
  title?: string;
  favicon?: string;
  screenX?: number;
  screenY?: number;
  grabOffsetX?: number;
  grabOffsetY?: number;
}

interface DragState extends TransferPayload { source: BrowserWindow }

/** Coordinates tab ownership transfer while keeping the existing native views alive. */
export class TabTransferService {
  private readonly drags = new Map<number, DragState>();
  private readonly readyWindows = new Set<number>();
  private readonly watchedSenders = new Set<number>();
  private readonly watchedWindows = new Set<number>();
  private polling: ReturnType<typeof setInterval> | null = null;
  private lastPointer = { x: 0, y: 0 };
  private ghost: BrowserWindow | null = null;

  constructor(
    private readonly ipc: IpcMain,
    private readonly screen: Screen,
    private readonly agentWindowFor: (contents: Electron.WebContents) => BrowserWindow | null,
    private readonly getAgentWindowsByFocusOrder: () => BrowserWindow[],
    private readonly openAgentWindow: (options: AgentWindowOptions) => BrowserWindow,
    private readonly views: BrowserTabViewManager,
    private readonly createGhostWindow?: (options: BrowserWindowConstructorOptions) => BrowserWindow,
    private readonly isDarkTheme: () => boolean = () => false,
    private readonly app?: App,
  ) {}

  install(): void {
    this.app?.once('before-quit', () => this.destroyGhost());
    this.ipc.on('tabs:transfer-ready', (event) => {
      const owner = this.agentWindowFor(event.sender);
      if (owner) this.markWindowReady(owner);
    });
    this.ipc.on('tabs:drag-start', (event, payload: TransferPayload & { tabCount?: number }) => this.start(event, payload));
    this.ipc.on('tabs:drag-end', (event, payload: { tabId: string; screenX: number; screenY: number; transient?: Record<string, unknown> }) => {
      const state = this.drags.get(event.sender.id);
      if (state && state.tabId === payload.tabId) { this.destroyGhost(); void this.finish(state, payload.screenX, payload.screenY, payload.transient); }
    });
    this.ipc.on('tabs:move-to-new-window', (event, payload: TransferPayload) => {
      const source = this.agentWindowFor(event.sender);
      if (source) {
        const bounds = source.getBounds();
        void this.transfer({ ...payload, source }, this.openAgentWindow({ bounds: { ...bounds, x: bounds.x + 40, y: bounds.y + 40 }, initialTabs: 'adopt' }), bounds.x + Math.round(bounds.width / 2), bounds.y + Math.round(bounds.height / 2));
      }
    });
  }

  private markWindowReady(owner: BrowserWindow): void {
    if (this.readyWindows.has(owner.id)) return;
    this.readyWindows.add(owner.id);
    owner.once('closed', () => this.readyWindows.delete(owner.id));
  }

  private start(event: IpcMainEvent, payload: TransferPayload & { tabCount?: number }): void {
    const source = this.agentWindowFor(event.sender);
    if (!source || !payload.tabId || !payload.descriptor || payload.descriptor.id !== payload.tabId) return;
    if (payload.descriptor.mode === 'browser' && !this.views.ownsTab(payload.tabId, source)) return;
    this.drags.set(event.sender.id, { ...payload, source });
    this.lastPointer = { x: payload.screenX ?? 0, y: payload.screenY ?? 0 };
    this.createGhost(payload);
    this.startPointerPolling();
    if (!this.watchedWindows.has(source.id)) {
      this.watchedWindows.add(source.id);
      source.once('closed', () => { this.watchedWindows.delete(source.id); this.drags.delete(event.sender.id); this.destroyGhost(); });
    }
    this.watchSenderDestruction(event.sender);
  }

  /** Registers the destroyed cleanup once per sender, so repeated drags don't stack listeners. */
  private watchSenderDestruction(sender: Electron.WebContents): void {
    if (this.watchedSenders.has(sender.id)) return;
    this.watchedSenders.add(sender.id);
    sender.once('destroyed', () => {
      this.watchedSenders.delete(sender.id);
      this.drags.delete(sender.id);
      this.destroyGhost();
      if (this.drags.size === 0 && this.polling) { clearInterval(this.polling); this.polling = null; }
    });
  }

  private startPointerPolling(): void {
    if (this.polling) return;
    this.polling = setInterval(() => {
      this.lastPointer = this.screen.getCursorScreenPoint();
      const state = this.drags.values().next().value as DragState | undefined;
      if (!state || !this.ghost || this.ghost.isDestroyed()) return;
      const offsetX = state.grabOffsetX ?? 16;
      const offsetY = state.grabOffsetY ?? 14;
      this.ghost.setPosition(Math.round(this.lastPointer.x - offsetX), Math.round(this.lastPointer.y - offsetY), false);
      const inTabStrip = this.getAgentWindowsByFocusOrder().some(win => {
        if (win.isDestroyed()) return false;
        const bounds = win.getBounds();
        return contains(bounds, this.lastPointer.x, this.lastPointer.y) && this.lastPointer.y < bounds.y + 78;
      });
      if (inTabStrip) this.ghost.hide(); else if (!this.ghost.isVisible()) this.ghost.showInactive();
    }, 16);
  }

  private createGhost(payload: TransferPayload): void {
    if (!this.createGhostWindow) return;
    this.destroyGhost();
    const title = escapeHtml(payload.title || String(payload.descriptor.title || 'New Tab'));
    const favicon = payload.favicon || (typeof payload.descriptor.favicon === 'string' ? payload.descriptor.favicon : '');
    const safeFavicon = /^https?:\/\//i.test(favicon) || /^data:image\//i.test(favicon) ? escapeHtml(favicon) : '';
    const dark = this.isDarkTheme();
    const background = dark ? '#252833' : '#ffffff';
    const foreground = dark ? '#f3f4f6' : '#202124';
    const border = dark ? '#454957' : '#d7dbe2';
    const icon = safeFavicon ? `<img src="${ safeFavicon }">` : '<span class="fallback">▰</span>';
    const html = `<!doctype html><html><meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:0;background:transparent;font:13px -apple-system,BlinkMacSystemFont,sans-serif;color:${ foreground }}.pill{height:38px;width:248px;border:1px solid ${ border };border-radius:10px;background:${ background };box-shadow:0 5px 18px #0004;display:flex;align-items:center;padding:0 12px;gap:9px;white-space:nowrap;overflow:hidden}.pill img{width:16px;height:16px;object-fit:contain}.fallback{font-size:16px}.title{overflow:hidden;text-overflow:ellipsis}.hint{margin:6px 0 0 17px;color:${ dark ? '#c4c8d1' : '#555b66' };font-size:11px}</style><div class="pill">${ icon }<span class="title">${ title }</span></div><div class="hint">↗ Drop to open in a new window</div></html>`;
    this.ghost = this.createGhostWindow({ width: 270, height: 62, frame: false, transparent: true, focusable: false, skipTaskbar: true, alwaysOnTop: true, hasShadow: false, resizable: false, movable: false, show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
    this.ghost.setIgnoreMouseEvents(true);
    this.ghost.setPosition(Math.round((payload.screenX ?? this.lastPointer.x) - (payload.grabOffsetX ?? 16)), Math.round((payload.screenY ?? this.lastPointer.y) - (payload.grabOffsetY ?? 14)), false);
    this.ghost.loadURL(`data:text/html;charset=utf-8,${ encodeURIComponent(html) }`);
    this.ghost.showInactive();
    this.ghost.once('closed', () => { this.ghost = null; });
    this.ghost.once('ready-to-show', () => { if (this.ghost && this.drags.size) this.ghost.showInactive(); });
  }

  private destroyGhost(): void {
    const ghost = this.ghost;
    this.ghost = null;
    if (ghost && !ghost.isDestroyed()) ghost.destroy();
  }

  private async finish(state: DragState, x: number, y: number, transient?: Record<string, unknown>): Promise<void> {
    this.lastPointer = { x, y };
    this.destroyGhost();
    this.drags.delete(state.source.webContents.id);
    if (this.drags.size === 0 && this.polling) { clearInterval(this.polling); this.polling = null; }
    if (state.source.isDestroyed()) return;
    const target = this.getAgentWindowsByFocusOrder().find(win => !win.isDestroyed() && contains(win.getBounds(), x, y));
    if (target === state.source) return;
    if (target) { await this.transfer({ ...state, transient: transient ?? state.transient }, target, x, y); return; }
    if ((state.tabCount ?? 2) === 1) {
      const bounds = state.source.getBounds();
      state.source.setBounds({ ...bounds, x: Math.round(x - bounds.width / 2), y: Math.round(y - 24) });
      return;
    }
    const bounds = state.source.getBounds();
    const newWindow = this.openAgentWindow({ bounds: { ...bounds, x: Math.round(x - bounds.width / 2), y: Math.round(y - 24) }, initialTabs: 'adopt' });
    await this.transfer({ ...state, transient: transient ?? state.transient }, newWindow, x, y);
  }

  private async transfer(state: DragState, target: BrowserWindow, screenX: number, screenY: number): Promise<void> {
    if (state.source === target || target.isDestroyed() || state.source.isDestroyed()) return;
    if (state.descriptor.mode === 'browser' && !this.views.ownsTab(state.tabId, state.source)) return;
    const transferId = `${ Date.now() }-${ Math.random().toString(36).slice(2) }`;
    this.views.markTransferring(state.tabId, true);
    InternalTabViewManager.getInstance().markTransferring(state.tabId, true);
    try {
      await this.sendAndWait('release', state.source, transferId, state.tabId);
      await this.waitForRendererReady(target);
      await this.sendAndWait('adopt', target, transferId, state.tabId, state.descriptor, state.transient, screenX, screenY);
      this.views.moveViewToWindow(state.tabId, target, { focus: true });
      InternalTabViewManager.getInstance().moveToWindow(state.tabId, target);
      InternalTabViewManager.getInstance().markTransferring(state.tabId, false);
      this.views.markTransferring(state.tabId, false);
      target.webContents.send('tabs:activate', transferId, state.tabId);
      if (this.getAgentWindowsByFocusOrder().includes(state.source) && state.source.isVisible()) {
        // The source renderer closes itself after the last transferred tab is removed.
        state.source.webContents.send('tabs:release-finalize', transferId, state.tabId);
      }
    } catch (error) {
      if (!state.source.isDestroyed()) {
        try {
          const rollbackId = `${ transferId }-rollback`;
          await this.waitForRendererReady(state.source);
          await this.sendAndWait('adopt', state.source, rollbackId, state.tabId, state.descriptor, state.transient, screenX, screenY);
        } catch (rollbackError) {
          console.error('[TabTransfer] Could not restore tab to source window', rollbackError);
        }
      }
      InternalTabViewManager.getInstance().markTransferring(state.tabId, false);
      this.views.markTransferring(state.tabId, false);
      console.error('[TabTransfer] Transfer failed', error);
    }
  }

  private waitForRendererReady(target: BrowserWindow): Promise<void> {
    if (this.readyWindows.has(target.id)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.ipc.removeListener('tabs:transfer-ready', listener); reject(new Error('target renderer did not become ready')); }, 30000);
      const listener = (event: IpcMainEvent) => {
        if (event.sender.id !== target.webContents.id) return;
        clearTimeout(timer);
        this.markWindowReady(target);
        this.ipc.removeListener('tabs:transfer-ready', listener);
        resolve();
      };
      this.ipc.on('tabs:transfer-ready', listener);
    });
  }

  private sendAndWait(kind: 'release' | 'adopt', win: BrowserWindow, transferId: string, tabId: string, ...payload: unknown[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const channel = kind === 'release' ? 'tabs:transfer-released' : 'tabs:transfer-adopted';
      const listener = (_event: IpcMainEvent, receivedId: string, receivedTabId: string) => {
        if (_event.sender.id !== win.webContents.id || receivedId !== transferId || receivedTabId !== tabId) return;
        clearTimeout(timer);
        this.ipc.removeListener(channel, listener);
        resolve();
      };
      const timer = setTimeout(() => { this.ipc.removeListener(channel, listener); reject(new Error(`${ kind } timed out`)); }, 5000);
      this.ipc.on(channel, listener);
      win.webContents.send(kind === 'release' ? 'tabs:release' : 'tabs:adopt', transferId, ...(kind === 'release' ? [tabId] : payload));
    });
  }
}

function contains(bounds: Electron.Rectangle, x: number, y: number): boolean {
  return x >= bounds.x && x < bounds.x + bounds.width && y >= bounds.y && y < bounds.y + bounds.height;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] || character);
}
