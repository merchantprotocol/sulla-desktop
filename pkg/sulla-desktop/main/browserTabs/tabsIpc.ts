// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// tabsIpc.ts — Thin read-only IPC surface for the renderer UI.
//
// Flow: main owns the tab list (TabRegistry). UI asks "what tabs are open?"
// and subscribes to pushes. UI never tells main "add this tab" — user tab
// opens come through a single `tabs:open` handler, same path the agent uses.
//
// There is NO reactive two-way sync. Renderer mirrors main's state; that's it.

import type { TabRecord } from './TabRegistry';
import type { IpcController, IpcRegistrar } from '../ipc/IpcController';

const CHANGE_CHANNEL = 'tabs:change';

/** The TabRegistry surface this controller uses. */
export interface TabsIpcRegistry {
  list(): TabRecord[];
  getActiveAssetId(): string | null;
  open(input: { assetId: string; url: string; title?: string; origin: 'user' }): unknown;
  close(assetId: string): unknown;
  setActive(assetId: string): void;
  onChange(listener: (tabs: TabRecord[]) => void): unknown;
}

/** Electron surfaces the change broadcast needs. */
export interface TabsIpcBroadcastPort {
  allWebContents(): Electron.WebContents[];
  browserSession(): Electron.Session | null | undefined;
  send(wc: Electron.WebContents, channel: string, payload: unknown): void;
}

/** tabs:* — list/open/close/activate tabs, and push tab changes to Sulla renderers. */
export class TabsIpcController implements IpcController {
  constructor(private readonly ipc: IpcRegistrar, private readonly registry: TabsIpcRegistry, private readonly broadcast: TabsIpcBroadcastPort) {}

  register(): void {
    const registry = this.registry;
    this.ipc.handle('tabs:list', (): TabRecord[] => registry.list());
    this.ipc.handle('tabs:active', (): string | null => registry.getActiveAssetId());

    this.ipc.handle('tabs:open', (_event, payload: { assetId?: string; url: string; title?: string }) => {
      const assetId = payload.assetId || `user_${ Date.now().toString(36) }_${ Math.random().toString(36).slice(2, 8) }`;

      return registry.open({ assetId, url: payload.url, title: payload.title, origin: 'user' });
    });

    this.ipc.handle('tabs:close', (_event, assetId: string) => registry.close(assetId));

    this.ipc.handle('tabs:setActive', (_event, assetId: string) => {
      registry.setActive(assetId);
    });

    // Broadcast changes to Sulla's own renderers. Browser-tab guests (and their
    // popups) share the browser session and are skipped: they never listen on
    // this channel, and pushing every open tab's URL and title into arbitrary
    // web pages' processes is both wasted IPC and a privacy leak. Disposed
    // WebContents are dropped by safeSend.
    registry.onChange((tabs) => {
      const browserSession = this.broadcast.browserSession();

      for (const wc of this.broadcast.allWebContents()) {
        if (wc.session === browserSession) continue;
        this.broadcast.send(wc, CHANGE_CHANNEL, tabs);
      }
    });
  }
}
