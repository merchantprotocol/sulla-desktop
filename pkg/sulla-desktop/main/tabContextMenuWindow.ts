// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import path from 'path';

import { BrowserWindow, ipcMain, app, screen } from 'electron';

import { TabHoverWindow } from './tabHoverWindow';

import { SullaSettingsModel } from '@pkg/agent/database/models/SullaSettingsModel';
import { DEFAULT_THEME_ID } from '@pkg/config/theme';
import type { TabContextMenuRequest } from '@pkg/shared/TabStripPopup';
import { agentWindowFromSender } from '@pkg/window/agentWindowTrust';
import { releaseWhenHidden } from '@pkg/window/releaseHiddenWindow';

interface MenuRequest {
  opener:  BrowserWindow;
  payload: TabContextMenuRequest;
}

class TabContextMenuWindow {
  private popup?:   BrowserWindow;
  private loaded?:  Promise<void>;
  private pending?: MenuRequest;
  private rendered?: MenuRequest;
  private detachOpener?: () => void;

  async show(opener: BrowserWindow, payload: TabContextMenuRequest): Promise<void> {
    if (!this.liveContents(opener)) return;
    if (typeof payload.requestId !== 'string' || !payload.requestId || !Array.isArray(payload.items) || !payload.items.length) return;
    if (payload.update && (!payload.attention || this.pending?.opener !== opener || this.pending.payload.requestId !== payload.requestId)) return;
    const request = { opener, payload };

    const previous = this.pending;

    this.detachOpener?.();
    this.pending = request;
    this.detachOpener = this.watchOpener(request);
    if (previous && (previous.opener !== opener || previous.payload.requestId !== payload.requestId)) {
      this.notifyClosed(previous);
    }
    const popup = this.popup ?? this.create();
    let themeId: string = DEFAULT_THEME_ID;

    try {
      await this.loaded;
    } catch {
      if (!popup.isDestroyed()) popup.destroy();
      return;
    }
    if (!payload.attention) {
      try {
        themeId = await SullaSettingsModel.get('theme', DEFAULT_THEME_ID) as string;
      } catch { /* keep the default theme */ }
    }
    if (this.pending !== request || popup.isDestroyed()) return;
    if (!this.liveContents(opener)) {
      this.close(undefined, false);
      return;
    }
    const bounds = this.bounds(opener, payload);

    if (!bounds) {
      this.close();
      return;
    }
    popup.setBounds(bounds);
    popup.webContents.send('tab-context-menu:data', {
      requestId: payload.requestId, items: payload.items, theme: themeId.includes('-light') ? 'light' : 'dark', themeId, attention: payload.attention,
    });
    this.rendered = request;
    if (!popup.isVisible() || !payload.update) {
      popup.showInactive();
      setTimeout(() => {
        if (popup.isDestroyed() || this.pending?.opener !== opener) return;
        if (this.pending.payload.requestId !== payload.requestId) return;
        if (!opener.isDestroyed() && (opener.isFocused() || popup.isFocused())) popup.focus();
        else this.close();
      }, 50);
    }
  }

  hide(opener: BrowserWindow, id: string): void {
    if (this.pending?.opener === opener && this.pending.payload.requestId === id) this.close();
  }

  act(sender: Electron.WebContents, id: string, action: string): void {
    const request = this.rendered;

    if (sender !== this.popup?.webContents || !request || request !== this.pending || request.payload.requestId !== id) return;
    const allowed = request.payload.items.some(item => typeof item === 'string' ? item !== '---' && item === action : `attention:${ item?.id }` === action);

    if (allowed) this.close(action);
  }

  dismiss(sender: Electron.WebContents, id: string): void {
    if (sender === this.popup?.webContents && this.rendered === this.pending && this.pending?.payload.requestId === id) this.close();
  }

  private close(action?: string, notify = true): void {
    const closed = this.pending;

    this.pending = undefined;
    this.rendered = undefined;
    this.detachOpener?.();
    this.detachOpener = undefined;
    if (this.popup && !this.popup.isDestroyed()) this.popup.hide();
    if (!closed || !notify) return;
    if (action === undefined) this.notifyClosed(closed);
    else this.liveContents(closed.opener)?.send('tab-context-menu:selected', closed.payload.requestId, action);
  }

  private notifyClosed(closed: MenuRequest): void {
    this.liveContents(closed.opener)?.send('tab-context-menu:closed', closed.payload.requestId);
  }

  private liveContents(opener: BrowserWindow): Electron.WebContents | undefined {
    if (opener.isDestroyed()) return undefined;
    const contents = opener.webContents;

    return !contents.isDestroyed() && !contents.isCrashed() ? contents : undefined;
  }

  private watchOpener(request: MenuRequest): () => void {
    const { opener } = request;
    const contents = opener.webContents;
    const onGone = () => {
      if (this.pending === request) this.close(undefined, false);
    };
    const onNavigate = (details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>, _url: string, _inPlace: boolean, mainFrame: boolean) => {
      if ((details.isMainFrame ?? mainFrame) && this.pending === request) this.close();
    };

    contents.on('did-start-navigation', onNavigate);
    contents.on('render-process-gone', onGone);
    opener.on('closed', onGone);
    return () => {
      contents.removeListener('did-start-navigation', onNavigate);
      contents.removeListener('render-process-gone', onGone);
      opener.removeListener('closed', onGone);
    };
  }

  private bounds(opener: BrowserWindow, payload: TabContextMenuRequest): Electron.Rectangle | undefined {
    if (!payload.attention) {
      const height = payload.items.reduce((sum, item) => sum + (item === '---' ? 9 : 31), 12);

      if (!Number.isFinite(payload.screenX) || !Number.isFinite(payload.screenY)) return undefined;
      return { x: payload.screenX, y: payload.screenY, width: 260, height };
    }

    const origin = opener.getContentBounds();
    const zoom = opener.webContents.getZoomFactor();
    const anchor = payload.attention.anchor;

    if (!anchor) return undefined;
    const point = { x: Math.round(origin.x + (anchor.x * zoom)), y: Math.round(origin.y + (anchor.y * zoom)) };

    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return undefined;
    const { workArea } = screen.getDisplayNearestPoint(point);
    const width = Math.min(340, workArea.width);
    const height = Math.min(360, workArea.height, 42 + (payload.items.length * 49));

    return {
      x: Math.max(workArea.x, Math.min(point.x, workArea.x + workArea.width - width)),
      y: Math.max(workArea.y, Math.min(point.y, workArea.y + workArea.height - height)),
      width,
      height,
    };
  }

  private create(): BrowserWindow {
    const popup = new BrowserWindow({
      width:          260,
      height:         80,
      show:           false,
      frame:          false,
      transparent:    true,
      resizable:      false,
      alwaysOnTop:    true,
      skipTaskbar:    true,
      hasShadow:      true,
      focusable:      true,
      webPreferences: { contextIsolation: false, nodeIntegration: true },
    });
    const assets = app.isPackaged ? ['dist', 'app', 'assets'] : ['pkg', 'sulla-desktop', 'assets'];

    this.popup = popup;
    this.loaded = popup.loadFile(path.join(app.getAppPath(), ...assets, 'tab-context-menu.html'));
    popup.on('blur', () => this.close());
    popup.on('closed', () => {
      this.popup = undefined;
      this.loaded = undefined;
      this.close();
    });
    releaseWhenHidden(popup);
    return popup;
  }
}

function logPopupError(error: unknown): void {
  console.error('[TabStripPopup] Could not show popup', error);
}

export function registerTabContextMenuIpc(): void {
  const menu = new TabContextMenuWindow();
  const hover = new TabHoverWindow();

  ipcMain.on('tab-context-menu:show', (event, payload: TabContextMenuRequest) => {
    const opener = agentWindowFromSender(event.sender);

    if (opener && payload) menu.show(opener, payload).catch(logPopupError);
  });
  ipcMain.on('tab-context-menu:hide', (event, id: string) => {
    const opener = agentWindowFromSender(event.sender);

    if (opener && typeof id === 'string') menu.hide(opener, id);
  });
  ipcMain.on('tab-context-menu:action', (event, id: string, action: string) => menu.act(event.sender, id, action));
  ipcMain.on('tab-context-menu:dismiss', (event, id: string) => menu.dismiss(event.sender, id));
  ipcMain.on('tab-hover:show', (event, payload) => {
    const owner = agentWindowFromSender(event.sender);

    if (owner?.webContents === event.sender && payload) hover.show(owner, payload).catch(logPopupError);
  });
  ipcMain.on('tab-hover:hide', (event, id: string) => {
    const owner = agentWindowFromSender(event.sender);

    if (owner?.webContents === event.sender && typeof id === 'string') hover.hide(owner, id);
  });
}
