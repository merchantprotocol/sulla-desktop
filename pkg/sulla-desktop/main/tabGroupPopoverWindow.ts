// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import path from 'path';

import { app, BrowserWindow, ipcMain, screen } from 'electron';

import { TAB_GROUP_COLOR_TOKENS } from '@pkg/shared/TabGroupColor';
import type { TabGroupPopoverChange, TabGroupPopoverRequest } from '@pkg/shared/TabStripPopup';

interface PopoverRequest {
  opener:  BrowserWindow;
  payload: TabGroupPopoverRequest;
}

/** Owns the focused name/color editor for one active tab-group action. */
export class TabGroupPopoverWindow {
  private popup?: BrowserWindow;
  private loaded?: Promise<void>;
  private pending?: PopoverRequest;
  private rendered?: PopoverRequest;
  private detachOpener?: () => void;

  async show(opener: BrowserWindow, payload: TabGroupPopoverRequest): Promise<void> {
    if (!this.liveContents(opener) || !this.validRequest(payload)) return;
    const request = { opener, payload };
    const previous = this.pending;

    this.detachOpener?.();
    this.pending = request;
    this.detachOpener = this.watchOpener(request);
    if (previous && (previous.opener !== opener || previous.payload.requestId !== payload.requestId)) this.notifyClosed(previous);
    const popup = this.popup ?? this.create(opener);

    try {
      await this.loaded;
    } catch {
      if (!popup.isDestroyed()) popup.destroy();
      return;
    }
    if (this.pending !== request || popup.isDestroyed() || !this.liveContents(opener)) return;

    const bounds = this.bounds(opener, payload);

    if (!bounds) {
      this.close();
      return;
    }
    popup.setBounds(bounds);
    popup.webContents.send('tab-group-popover:data', payload);
    this.rendered = request;
    popup.showInactive();
    setTimeout(() => {
      if (popup.isDestroyed() || this.pending !== request) return;
      if (opener.isFocused() || popup.isFocused()) popup.focus();
      else this.close();
    }, 50);
  }

  hide(opener: BrowserWindow, requestId: string): void {
    if (this.pending?.opener === opener && this.pending.payload.requestId === requestId) this.close();
  }

  change(sender: Electron.WebContents, requestId: string, change: TabGroupPopoverChange): void {
    const request = this.rendered;

    if (sender !== this.popup?.webContents || !request || request !== this.pending || request.payload.requestId !== requestId) return;
    if (!this.validChange(request.payload, change)) return;
    this.liveContents(request.opener)?.send('tab-group-popover:changed', requestId, change);
  }

  finish(sender: Electron.WebContents, requestId: string): void {
    if (sender === this.popup?.webContents && this.rendered === this.pending && this.pending?.payload.requestId === requestId) this.close();
  }

  private validRequest(payload: TabGroupPopoverRequest): boolean {
    if (!payload || typeof payload.requestId !== 'string' || !payload.requestId || payload.requestId.length > 128 ||
        typeof payload.groupId !== 'string' || !payload.groupId || payload.groupId.length > 128) return false;
    if (typeof payload.name !== 'string' || Array.from(payload.name).length > 60 || !['name', 'color'].includes(payload.focus)) return false;
    if (!payload.anchor || ![payload.anchor.x, payload.anchor.y, payload.anchor.aboveY].every(Number.isFinite)) return false;
    if (!payload.palette || typeof payload.palette !== 'object' || Array.isArray(payload.palette)) return false;
    const allowedPaletteTokens = ['bg-elevated', 'bg-surface-hover', 'border-default', 'elev-raised', 'text-primary', 'text-muted', 'status-warning', 'status-error'];
    if (Object.entries(payload.palette).some(([token, value]) => !allowedPaletteTokens.includes(token) || typeof value !== 'string' || value.length > 256 || /url\s*\(|[;{}]/i.test(value))) return false;
    if (!Array.isArray(payload.swatches) || payload.swatches.length !== 8) return false;
    const allowedTokens = new Set<string>(TAB_GROUP_COLOR_TOKENS);
    const tokens = new Set<string>();
    for (const swatch of payload.swatches) {
      if (!swatch || typeof swatch.token !== 'string' || !allowedTokens.has(swatch.token) || typeof swatch.label !== 'string' || swatch.label.length > 40 ||
          typeof swatch.color !== 'string' || swatch.color.length > 128 || /url\s*\(/i.test(swatch.color) || tokens.has(swatch.token)) return false;
      tokens.add(swatch.token);
    }
    return tokens.size === allowedTokens.size && tokens.has(payload.colorToken);
  }

  private validChange(payload: TabGroupPopoverRequest, change: TabGroupPopoverChange): boolean {
    if (!change || typeof change !== 'object') return false;
    const keys = Object.keys(change);

    if (keys.length !== 1) return false;
    if ('name' in change) return typeof change.name === 'string' && Array.from(change.name).length <= 60;
    if ('colorToken' in change) return payload.swatches.some(swatch => swatch.token === change.colorToken);
    return false;
  }

  private close(): void {
    const closed = this.pending;

    this.pending = undefined;
    this.rendered = undefined;
    this.detachOpener?.();
    this.detachOpener = undefined;
    if (this.popup && !this.popup.isDestroyed()) this.popup.hide();
    if (closed) this.notifyClosed(closed);
  }

  private notifyClosed(request: PopoverRequest): void {
    this.liveContents(request.opener)?.send('tab-group-popover:closed', request.payload.requestId);
  }

  private liveContents(opener: BrowserWindow): Electron.WebContents | undefined {
    if (opener.isDestroyed()) return undefined;
    const contents = opener.webContents;

    return !contents.isDestroyed() && !contents.isCrashed() ? contents : undefined;
  }

  private watchOpener(request: PopoverRequest): () => void {
    const { opener } = request;
    const contents = opener.webContents;
    const onGone = () => {
      if (this.pending === request) this.close();
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

  private bounds(opener: BrowserWindow, payload: TabGroupPopoverRequest): Electron.Rectangle | undefined {
    const origin = opener.getContentBounds();
    const zoom = opener.webContents.getZoomFactor();
    const point = { x: Math.round(origin.x + (payload.anchor.x * zoom)), y: Math.round(origin.y + (payload.anchor.y * zoom)) };
    const aboveY = Math.round(origin.y + (payload.anchor.aboveY * zoom));

    if (![point.x, point.y, aboveY].every(Number.isFinite)) return undefined;
    const { workArea } = screen.getDisplayNearestPoint(point);
    const width = Math.min(264, workArea.width);
    const height = Math.min(164, workArea.height);
    const bottom = workArea.y + workArea.height;
    const y = point.y + height <= bottom ? point.y : Math.max(workArea.y, Math.min(aboveY - height, bottom - height));

    return {
      x: Math.max(workArea.x, Math.min(point.x, workArea.x + workArea.width - width)),
      y,
      width,
      height,
    };
  }

  private create(opener: BrowserWindow): BrowserWindow {
    const popup = new BrowserWindow({
      parent:         opener,
      width:          264,
      height:         164,
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
    this.loaded = popup.loadFile(path.join(app.getAppPath(), ...assets, 'tab-group-popover.html'));
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
    return popup;
  }
}
