// SPDX-License-Identifier: GPL-2.0-or-later
// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.

import type { BrowserWindow, IpcMain, IpcMainEvent, Screen } from 'electron';

import type { BrowserTabViewManager } from '@pkg/window/browserTabViewManager';
import type { AgentWindowOptions } from '@pkg/window/agentWindows';

interface TransferPayload {
  tabId: string;
  descriptor: Record<string, unknown>;
  transient?: Record<string, unknown>;
  tabCount?: number;
}

interface DragState extends TransferPayload { source: BrowserWindow }

/** Coordinates tab ownership transfer while keeping the existing native views alive. */
export class TabTransferService {
  private readonly drags = new Map<number, DragState>();
  private readonly readyWindows = new Set<number>();
  private polling: ReturnType<typeof setInterval> | null = null;
  private lastPointer = { x: 0, y: 0 };

  constructor(
    private readonly ipc: IpcMain,
    private readonly screen: Screen,
    private readonly agentWindowFor: (contents: Electron.WebContents) => BrowserWindow | null,
    private readonly getAgentWindowsByFocusOrder: () => BrowserWindow[],
    private readonly openAgentWindow: (options: AgentWindowOptions) => BrowserWindow,
    private readonly views: BrowserTabViewManager,
  ) {}

  install(): void {
    this.ipc.on('tabs:transfer-ready', (event) => {
      const owner = this.agentWindowFor(event.sender);
      if (owner) this.readyWindows.add(owner.id);
    });
    this.ipc.on('tabs:drag-start', (event, payload: TransferPayload & { tabCount?: number }) => this.start(event, payload));
    this.ipc.on('tabs:drag-end', (event, payload: { tabId: string; screenX: number; screenY: number; transient?: Record<string, unknown> }) => {
      const state = this.drags.get(event.sender.id);
      if (state && state.tabId === payload.tabId) void this.finish(state, payload.screenX, payload.screenY, payload.transient);
    });
    this.ipc.on('tabs:move-to-new-window', (event, payload: TransferPayload) => {
      const source = this.agentWindowFor(event.sender);
      if (source) {
        const bounds = source.getBounds();
        void this.transfer({ ...payload, source }, this.openAgentWindow({ bounds: { ...bounds, x: bounds.x + 40, y: bounds.y + 40 }, initialTabs: 'adopt' }), bounds.x + Math.round(bounds.width / 2), bounds.y + Math.round(bounds.height / 2));
      }
    });
  }

  private start(event: IpcMainEvent, payload: TransferPayload & { tabCount?: number }): void {
    const source = this.agentWindowFor(event.sender);
    if (!source || !payload.tabId || !payload.descriptor || payload.descriptor.id !== payload.tabId) return;
    if (payload.descriptor.mode === 'browser' && !this.views.ownsTab(payload.tabId, source)) return;
    this.drags.set(event.sender.id, { ...payload, source });
    this.startPointerPolling();
    event.sender.once('destroyed', () => {
      this.drags.delete(event.sender.id);
      if (this.drags.size === 0 && this.polling) { clearInterval(this.polling); this.polling = null; }
    });
  }

  private startPointerPolling(): void {
    if (this.polling) return;
    this.polling = setInterval(() => {
      this.lastPointer = this.screen.getCursorScreenPoint();
    }, 16);
  }

  private async finish(state: DragState, x: number, y: number, transient?: Record<string, unknown>): Promise<void> {
    this.lastPointer = { x, y };
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
    try {
      await this.sendAndWait('release', state.source, transferId, state.tabId);
      await this.waitForRendererReady(target);
      await this.sendAndWait('adopt', target, transferId, state.tabId, state.descriptor, state.transient, screenX, screenY);
      this.views.moveViewToWindow(state.tabId, target, { focus: true });
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
      this.views.markTransferring(state.tabId, false);
      console.error('[TabTransfer] Transfer failed', error);
    }
  }

  private waitForRendererReady(target: BrowserWindow): Promise<void> {
    if (this.readyWindows.has(target.id)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.ipc.removeListener('tabs:transfer-ready', listener); reject(new Error('target renderer did not become ready')); }, 10000);
      const listener = (event: IpcMainEvent) => {
        if (event.sender.id !== target.webContents.id) return;
        clearTimeout(timer);
        this.readyWindows.add(target.id);
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
