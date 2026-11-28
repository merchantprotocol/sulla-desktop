// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import path from 'path';

import { BrowserWindow, ipcMain, app, screen } from 'electron';

import { TabHoverWindow } from './tabHoverWindow';
import { TabGroupPopoverWindow } from './tabGroupPopoverWindow';

import { SullaSettingsModel } from '@pkg/agent/database/models/SullaSettingsModel';
import { DEFAULT_THEME_ID } from '@pkg/config/theme';
import type { TabAttentionContextMenuRequest, TabContextMenuRequest } from '@pkg/shared/TabStripPopup';
import { agentWindowFromSender } from '@pkg/window/agentWindowTrust';
import { releaseWhenHidden } from '@pkg/window/releaseHiddenWindow';

interface MenuRequest {
  opener:  BrowserWindow;
  payload: TabContextMenuRequest;
}

class TabContextMenuWindow {
  private popup?:        BrowserWindow;
  private loaded?:       Promise<void>;
  private pending?:      MenuRequest;
  private rendered?:     MenuRequest;
  private detachOpener?: () => void;

  async show(opener: BrowserWindow, payload: TabContextMenuRequest): Promise<void> {
    if (!this.liveContents(opener)) return;
    if (typeof payload.requestId !== 'string' || !payload.requestId || payload.requestId.length > 128 || !Array.isArray(payload.items) || !payload.items.length) return;
    if (this.isAttentionRequest(payload)) {
      if (!this.validAttentionRequest(payload)) return;
    } else {
      if (payload.items.some(item => typeof item !== 'string')) return;
      if (payload.groups && (!Array.isArray(payload.groups) || payload.groups.some(group =>
        !group || typeof group.id !== 'string' || !group.id || typeof group.name !== 'string' ||
        typeof group.colorToken !== 'string' || typeof group.color !== 'string'))) return;
      if (payload.activeGroupId !== undefined && typeof payload.activeGroupId !== 'string') return;
    }
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
    if (!this.isAttentionRequest(payload)) {
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
      requestId:  payload.requestId,
      items:      payload.items,
      groups:     this.isAttentionRequest(payload) ? [] : payload.groups ?? [],
      activeGroupId: this.isAttentionRequest(payload) ? undefined : payload.activeGroupId,
      theme: themeId.includes('-light') ? 'light' : 'dark',
      themeId,
      attention: this.isAttentionRequest(payload) ? payload.attention : undefined,
    });
    this.rendered = request;
    if (!popup.isVisible()) {
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

    if (typeof id !== 'string' || typeof action !== 'string' || sender !== this.popup?.webContents || !request ||
        request !== this.pending || request.payload.requestId !== id) return;
    const allowed = this.isAttentionRequest(request.payload)
      ? request.payload.items.some(item => `attention:${ item.id }` === action)
      : (action !== '---' && request.payload.items.includes(action)) ||
        (action.startsWith('joinGroup:') && request.payload.items.includes('addToGroup') &&
          request.payload.groups?.some(group => `joinGroup:${ group.id }` === action) === true);

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

  private bounds(_opener: BrowserWindow, payload: TabContextMenuRequest): Electron.Rectangle | undefined {
    if (this.isAttentionRequest(payload)) {
      const origin = _opener.getContentBounds();
      const zoom = _opener.webContents.getZoomFactor();
      const point = {
        x: Math.round(origin.x + (payload.attention.anchor.x * zoom)),
        y: Math.round(origin.y + (payload.attention.anchor.y * zoom)),
      };

      if (![point.x, point.y].every(Number.isFinite)) return undefined;
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

    if (!Number.isFinite(payload.screenX) || !Number.isFinite(payload.screenY)) return undefined;
    const point = { x: Math.round(payload.screenX), y: Math.round(payload.screenY) };
    const { workArea } = screen.getDisplayNearestPoint(point);
    const hasGroupSubmenu = payload.items.includes('addToGroup') && Boolean(payload.groups?.length);
    const width = Math.min(hasGroupSubmenu ? 456 : 260, workArea.width);
    const rowsHeight = payload.items.reduce((sum, item) => sum + (item === '---' ? 9 : 30), 10);
    const submenuHeight = hasGroupSubmenu ? 10 + Math.min(payload.groups!.length, 10) * 30 : 0;
    const height = Math.min(workArea.height, Math.max(rowsHeight, submenuHeight));

    return {
      x: Math.max(workArea.x, Math.min(point.x, workArea.x + workArea.width - width)),
      y: Math.max(workArea.y, Math.min(point.y, workArea.y + workArea.height - height)),
      width,
      height,
    };
  }

  private isAttentionRequest(payload: TabContextMenuRequest): payload is TabAttentionContextMenuRequest {
    return 'attention' in payload;
  }

  private validAttentionRequest(payload: TabAttentionContextMenuRequest): boolean {
    const allowedPaletteTokens = ['bg-elevated', 'bg-surface-hover', 'border-default', 'elev-raised', 'text-primary', 'text-muted', 'status-warning', 'status-error'];
    const { anchor, palette, title } = payload.attention;

    if (payload.update !== false || !anchor || ![anchor.x, anchor.y].every(Number.isFinite) || !palette || typeof palette !== 'object' || Array.isArray(palette)) return false;
    if (title !== undefined && (typeof title !== 'string' || title.length > 128)) return false;
    if (Object.entries(palette).some(([token, value]) => !allowedPaletteTokens.includes(token) || typeof value !== 'string' || value.length > 256 || /url\s*\(|[;{}]/i.test(value))) return false;
    const allowedStates = ['you', 'stalled', 'working', 'waiting', 'quiet', 'idle'];

    return payload.items.every(item => item && typeof item.id === 'string' && item.id.length > 0 && item.id.length <= 128 &&
      typeof item.title === 'string' && item.title.length <= 512 && typeof item.reason === 'string' && item.reason.length <= 512 &&
      allowedStates.includes(item.state) && (item.iconPath === undefined || (typeof item.iconPath === 'string' && item.iconPath.length <= 256)));
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
    popup.on('blur', () => {
      if (this.popup === popup) this.close();
    });
    popup.webContents.once('render-process-gone', () => {
      if (!popup.isDestroyed()) popup.destroy();
    });
    popup.once('closed', () => {
      if (this.popup !== popup) return;
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
  const groupPopover = new TabGroupPopoverWindow();

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
  ipcMain.on('tab-group-popover:show', (event, payload) => {
    const opener = agentWindowFromSender(event.sender);

    if (opener?.webContents === event.sender && payload) groupPopover.show(opener, payload).catch(logPopupError);
  });
  ipcMain.on('tab-group-popover:hide', (event, id: string) => {
    const opener = agentWindowFromSender(event.sender);

    if (opener?.webContents === event.sender && typeof id === 'string') groupPopover.hide(opener, id);
  });
  ipcMain.on('tab-group-popover:change', (event, id: string, change) => groupPopover.change(event.sender, id, change));
  ipcMain.on('tab-group-popover:done', (event, id: string) => groupPopover.finish(event.sender, id));
  ipcMain.on('tab-group-popover:dismiss', (event, id: string) => groupPopover.finish(event.sender, id));
}
