// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import path from 'path';

import { app, BrowserWindow, screen } from 'electron';

import type { TabHoverRequest } from '@pkg/shared/TabStripPopup';

interface HoverWindow {
  popup:      BrowserWindow;
  ready:      Promise<void>;
  requestId?: string;
}

/** A single, input-transparent hover surface reused over each agent window's native views. */
export class TabHoverWindow {
  private readonly windows = new Map<number, HoverWindow>();

  async show(owner: BrowserWindow, request: TabHoverRequest): Promise<void> {
    if (owner.isDestroyed() || !owner.isFocused() || !owner.isVisible() || !request.anchor || typeof request.id !== 'string') return;
    const { x, y } = owner.getContentBounds();
    const zoom = owner.webContents.getZoomFactor();
    const point = { x: Math.round(x + (request.anchor.x * zoom)), y: Math.round(y + (request.anchor.y * zoom)) };

    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
    const { workArea } = screen.getDisplayNearestPoint(point);
    const width = Math.min(326, workArea.width);
    const height = Math.min(238, workArea.y + workArea.height - point.y);

    if (height < 1) return;
    const hover = this.windows.get(owner.id) ?? this.create(owner);

    hover.requestId = request.id;
    try {
      await hover.ready;
    } catch {
      if (!hover.popup.isDestroyed()) hover.popup.destroy();
      return;
    }
    const { popup } = hover;

    if (popup.isDestroyed() || owner.isDestroyed() || !owner.isFocused() || hover.requestId !== request.id) return;
    popup.setBounds({
      x: Math.max(workArea.x, Math.min(point.x, workArea.x + workArea.width - width)),
      y: point.y,
      width,
      height,
    });
    popup.webContents.send('tab-hover:data', request);
    popup.showInactive();
  }

  hide(owner: BrowserWindow, requestId: string): void {
    const hover = this.windows.get(owner.id);

    if (hover?.requestId === requestId) this.clear(hover);
  }

  private clear(hover: HoverWindow): void {
    hover.requestId = undefined;
    if (!hover.popup.isDestroyed()) hover.popup.hide();
  }

  private create(owner: BrowserWindow): HoverWindow {
    const popup = new BrowserWindow({
      parent:         owner,
      show:           false,
      frame:          false,
      transparent:    true,
      focusable:      false,
      resizable:      false,
      skipTaskbar:    true,
      hasShadow:      false,
      webPreferences: { contextIsolation: false, nodeIntegration: true },
    });

    popup.setIgnoreMouseEvents(true);
    const assets = app.isPackaged ? ['dist', 'app', 'assets'] : ['pkg', 'sulla-desktop', 'assets'];
    const hover = { popup, ready: popup.loadFile(path.join(app.getAppPath(), ...assets, 'tab-hover.html')) };
    const dismiss = () => this.clear(hover);
    const teardown = () => {
      if (!popup.isDestroyed()) popup.destroy();
    };

    this.windows.set(owner.id, hover);
    for (const event of ['blur', 'hide', 'minimize', 'move', 'resize'] as const) owner.on(event as 'blur', dismiss);
    owner.once('closed', teardown);
    popup.once('closed', () => {
      this.windows.delete(owner.id);
      for (const event of ['blur', 'hide', 'minimize', 'move', 'resize'] as const) owner.removeListener(event as 'blur', dismiss);
      owner.removeListener('closed', teardown);
    });
    return hover;
  }
}
