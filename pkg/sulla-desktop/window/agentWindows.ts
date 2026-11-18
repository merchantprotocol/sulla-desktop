// SPDX-License-Identifier: GPL-2.0-or-later
// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.

import { BrowserWindow } from 'electron';

export interface AgentWindowOptions {
  windowKey?: string;
  bounds?: { x: number; y: number; width: number; height: number };
  focus?: boolean;
}

/** Owns agent-window identity and most-recently-focused ordering. */
export class AgentWindowRegistry {
  private readonly keys = new Map<number, string>();
  private readonly focusOrder: number[] = [];
  private nextKey = 1;

  openAgentWindow(create: (name: string, windowKey: string, bounds?: AgentWindowOptions['bounds']) => BrowserWindow, options: AgentWindowOptions = {}): BrowserWindow {
    const windowKey = options.windowKey ?? `window-${ this.nextKey++ }`;
    const name = this.getAgentWindows().length === 0 ? 'main-agent' : `agent:${ windowKey }`;
    const window = create(name, windowKey, options.bounds);
    this.keys.set(window.id, windowKey);
    window.on('focus', () => this.noteFocus(window));
    window.on('closed', () => {
      this.keys.delete(window.id);
      const index = this.focusOrder.indexOf(window.id);
      if (index >= 0) this.focusOrder.splice(index, 1);
    });
    if (options.focus !== false) window.show();
    return window;
  }

  getAgentWindows(): BrowserWindow[] {
    return Array.from(this.keys.keys()).map(id => BrowserWindow.fromId(id)).filter((win): win is BrowserWindow => !!win && !win.isDestroyed());
  }

  getActiveAgentWindow(): BrowserWindow | null {
    const alive = this.getAgentWindows();
    return alive.find(win => win.isFocused()) ?? this.focusOrder.map(id => alive.find(win => win.id === id)).find((win): win is BrowserWindow => !!win) ?? alive[0] ?? null;
  }

  ensureAgentWindow(create: (name: string, windowKey: string, bounds?: AgentWindowOptions['bounds']) => BrowserWindow): BrowserWindow {
    const active = this.getActiveAgentWindow();
    if (active) { active.show(); active.focus(); return active; }
    return this.openAgentWindow(create);
  }

  windowKeyOf(window: BrowserWindow): string | null { return this.keys.get(window.id) ?? null; }

  agentWindowFor(contents: Electron.WebContents): BrowserWindow | null {
    const direct = BrowserWindow.fromWebContents(contents);
    if (direct && this.keys.has(direct.id)) return direct;
    return this.getAgentWindows().find(win => win.getContentView().children.some(view => view.webContents === contents)) ?? null;
  }

  isAgentWebContents(contents: Electron.WebContents): boolean { return this.agentWindowFor(contents) !== null; }

  private noteFocus(window: BrowserWindow): void {
    const old = this.focusOrder.indexOf(window.id);
    if (old >= 0) this.focusOrder.splice(old, 1);
    this.focusOrder.unshift(window.id);
  }
}

export const agentWindowRegistry = new AgentWindowRegistry();
