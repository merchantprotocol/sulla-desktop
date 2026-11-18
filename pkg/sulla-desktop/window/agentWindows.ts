// SPDX-License-Identifier: GPL-2.0-or-later
// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.

import { BrowserWindow, WebContentsView } from 'electron';

export interface AgentWindowOptions {
  windowKey?: string;
  bounds?: { x: number; y: number; width: number; height: number };
  focus?: boolean;
  initialTabs?: 'restore' | 'fresh-chat' | 'adopt';
}

/** Query flag used to initialize a new secondary window without clearing restored tabs on reload. */
export function initialTabsQuery(initialTabs: AgentWindowOptions['initialTabs']): string {
  if (initialTabs === 'restore') return '';
  return initialTabs === 'adopt' ? '&adoptPending=1' : '&freshAgentTab=1';
}

/** Owns agent-window identity and most-recently-focused ordering. */
export class AgentWindowRegistry {
  private readonly keys = new Map<number, string>();
  private readonly focusOrder: number[] = [];
  openAgentWindow(create: (name: string, windowKey: string, bounds?: AgentWindowOptions['bounds'], initialTabs?: AgentWindowOptions['initialTabs']) => BrowserWindow, options: AgentWindowOptions = {}): BrowserWindow {
    const windowKey = options.windowKey ?? (this.getAgentWindows().length === 0 ? 'main' : `w_${ Math.random().toString(36).slice(2, 10) }`);
    const name = this.getAgentWindows().length === 0 ? 'main-agent' : `agent:${ windowKey }`;
    const window = create(name, windowKey, options.bounds, options.initialTabs ?? (name === 'main-agent' ? 'restore' : 'fresh-chat'));
    windowMappingRef()[name] = window.id;
    this.keys.set(window.id, windowKey);
    window.on('focus', () => this.noteFocus(window));
    window.on('closed', () => {
      this.keys.delete(window.id);
      const mappedName = Object.keys(windowMappingRef()).find(key => windowMappingRef()[key] === window.id);
      if (mappedName) delete windowMappingRef()[mappedName];
      if (mappedName === 'main-agent') {
        const fallback = this.focusOrder.map(id => this.getAgentWindows().find(candidate => candidate.id === id)).find((candidate): candidate is BrowserWindow => !!candidate) ?? this.getAgentWindows()[0];
        if (fallback) windowMappingRef()['main-agent'] = fallback.id;
      }
      const index = this.focusOrder.indexOf(window.id);
      if (index >= 0) this.focusOrder.splice(index, 1);
    });
    window.show();
    if (options.focus !== false) window.focus();
    return window;
  }

  getAgentWindows(): BrowserWindow[] {
    return Array.from(this.keys.keys()).map(id => BrowserWindow.fromId(id)).filter((win): win is BrowserWindow => !!win && !win.isDestroyed());
  }

  getAgentWindowsByFocusOrder(): BrowserWindow[] {
    const alive = this.getAgentWindows();
    return [...this.focusOrder.map(id => alive.find(win => win.id === id)).filter((win): win is BrowserWindow => !!win), ...alive.filter(win => !this.focusOrder.includes(win.id))];
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
    return this.getAgentWindows().find(win => win.getContentView().children.some(view => view instanceof WebContentsView && view.webContents === contents)) ?? null;
  }

  isAgentWebContents(contents: Electron.WebContents): boolean { return this.agentWindowFor(contents) !== null; }

  private noteFocus(window: BrowserWindow): void {
    const old = this.focusOrder.indexOf(window.id);
    if (old >= 0) this.focusOrder.splice(old, 1);
    this.focusOrder.unshift(window.id);
  }
}

export const agentWindowRegistry = new AgentWindowRegistry();

// Injected by window/index.ts at module initialization, avoiding an import cycle.
let mappings: Record<string, number> = {};
export function setAgentWindowMapping(mapping: Record<string, number>): void { mappings = mapping; }
function windowMappingRef(): Record<string, number> { return mappings; }

let createAgentWindow: ((name: string, windowKey: string, bounds?: AgentWindowOptions['bounds'], initialTabs?: AgentWindowOptions['initialTabs']) => BrowserWindow) | undefined;

/** Register the BrowserWindow factory without importing window/index.ts here. */
export function setAgentWindowCreator(creator: typeof createAgentWindow): void { createAgentWindow = creator; }

function requireCreator() {
  if (!createAgentWindow) throw new Error('Agent window creator has not been registered');
  return createAgentWindow;
}

export function openAgentWindow(options: AgentWindowOptions = {}): BrowserWindow {
  return agentWindowRegistry.openAgentWindow(requireCreator(), options);
}
export function ensureAgentWindow(): BrowserWindow { return agentWindowRegistry.ensureAgentWindow(requireCreator()); }
export function getActiveAgentWindow(): BrowserWindow | null { return agentWindowRegistry.getActiveAgentWindow(); }
export function getAgentWindows(): BrowserWindow[] { return agentWindowRegistry.getAgentWindows(); }
export function getAgentWindowsByFocusOrder(): BrowserWindow[] { return agentWindowRegistry.getAgentWindowsByFocusOrder(); }
export function isAgentWebContents(contents: Electron.WebContents): boolean { return agentWindowRegistry.isAgentWebContents(contents); }
export function agentWindowFor(contents: Electron.WebContents): BrowserWindow | null { return agentWindowRegistry.agentWindowFor(contents); }
export function windowKeyOf(window: BrowserWindow): string | null { return agentWindowRegistry.windowKeyOf(window); }
export function newAgentWindow(): BrowserWindow { return openAgentWindow({ initialTabs: 'fresh-chat' }); }
