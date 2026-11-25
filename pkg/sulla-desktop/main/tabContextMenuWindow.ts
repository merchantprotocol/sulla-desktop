// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import path from 'path';

import { BrowserWindow, ipcMain, app, screen } from 'electron';

import { SullaSettingsModel } from '@pkg/agent/database/models/SullaSettingsModel';
import { DEFAULT_THEME_ID } from '@pkg/config/theme';
import type { TabContextMenuRequest } from '@pkg/shared/TabStripPopup';
import { agentWindowFromSender } from '@pkg/window/agentWindowTrust';
import { releaseWhenHidden } from '@pkg/window/releaseHiddenWindow';

import { TabHoverWindow } from './tabHoverWindow';

interface MenuRequest {
  opener: BrowserWindow;
  payload: TabContextMenuRequest;
}

class TabContextMenuWindow {
  private popup?: BrowserWindow;
  private loaded?: Promise<void>;
  private pending?: MenuRequest;

  async show(opener: BrowserWindow, payload: TabContextMenuRequest): Promise<void> {
    if (!Array.isArray(payload.items) || !payload.items.length) return;
    if (payload.update && (!payload.attention || this.pending?.opener !== opener || this.pending.payload.attention?.id !== payload.attention.id)) return;
    const request = { opener, payload };

    this.pending = request;
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
    if (opener.isDestroyed()) {
      this.close();
      return;
    }
    const bounds = this.bounds(opener, payload);

    if (!bounds) {
      this.close();
      return;
    }
    popup.setBounds(bounds);
    popup.webContents.send('tab-context-menu:data', {
      items: payload.items, theme: themeId.includes('-light') ? 'light' : 'dark', themeId, attention: payload.attention,
    });
    if (!popup.isVisible() || !payload.update) {
      popup.showInactive();
      setTimeout(() => {
        if (!popup.isDestroyed() && this.pending?.opener === opener &&
            (this.pending === request || (payload.attention && this.pending?.payload.attention?.id === payload.attention.id))) popup.focus();
      }, 50);
    }
  }

  hideAttention(opener: BrowserWindow, id: string): void {
    if (this.pending?.opener === opener && this.pending.payload.attention?.id === id) this.close();
  }

  act(sender: Electron.WebContents, action: string): void {
    if (sender !== this.popup?.webContents || !this.pending) return;
    const { opener, payload } = this.pending;
    const allowed = payload.items.some(item => typeof item === 'string' ? item !== '---' && item === action : `attention:${ item.id }` === action);

    if (allowed && !opener.isDestroyed()) opener.webContents.send('tab-context-menu:selected', action, payload.tabData);
    this.close();
  }

  dismiss(sender: Electron.WebContents): void {
    if (sender === this.popup?.webContents) this.close();
  }

  private close(): void {
    const closed = this.pending;

    this.pending = undefined;
    if (this.popup && !this.popup.isDestroyed()) this.popup.hide();
    if (closed?.payload.attention && !closed.opener.isDestroyed()) {
      closed.opener.webContents.send('tab-context-menu:attention-closed', closed.payload.attention.id);
    }
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

export function registerTabContextMenuIpc(): void {
  const menu = new TabContextMenuWindow();
  const hover = new TabHoverWindow();

  ipcMain.on('tab-context-menu:show', (event, payload: TabContextMenuRequest) => {
    const opener = agentWindowFromSender(event.sender);

    if (opener && payload) void menu.show(opener, payload);
  });
  ipcMain.on('tab-context-menu:hide-attention', (event, id: string) => {
    const opener = agentWindowFromSender(event.sender);

    if (opener) menu.hideAttention(opener, id);
  });
  ipcMain.on('tab-context-menu:action', (event, action: string) => menu.act(event.sender, action));
  ipcMain.on('tab-context-menu:dismiss', event => menu.dismiss(event.sender));
  ipcMain.on('tab-hover:show', (event, payload) => {
    const owner = agentWindowFromSender(event.sender);

    if (owner?.webContents === event.sender && payload) void hover.show(owner, payload);
  });
  ipcMain.on('tab-hover:hide', (event, id: string) => {
    const owner = agentWindowFromSender(event.sender);

    if (owner?.webContents === event.sender) hover.hide(owner, id);
  });
}
