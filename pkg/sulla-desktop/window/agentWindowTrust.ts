// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import Electron from 'electron';

import { windowMapping } from '@pkg/window';
import { InternalTabViewManager } from './internalTabViewManager';

/** True only for a live renderer registered as an agent window. */
export function isAgentWindowSender(sender: Electron.WebContents): boolean {
  if (InternalTabViewManager.getInstance().resolveOwner(sender)) return true;
  try {
    const window = Electron.BrowserWindow.fromWebContents(sender);
    if (!window || window.isDestroyed() || window.webContents !== sender) return false;
    return Object.entries(windowMapping).some(([name, id]) => id === window.id && (name === 'main-agent' || name.startsWith('agent:')));
  } catch { return false }
}

/** Resolve a trusted agent window from its renderer. */
export function agentWindowFromSender(sender: Electron.WebContents): Electron.BrowserWindow | null {
  const tabOwner = InternalTabViewManager.getInstance().resolveOwner(sender);
  if (tabOwner) return tabOwner;
  if (!isAgentWindowSender(sender)) return null;
  try { return Electron.BrowserWindow.fromWebContents(sender) ?? null } catch { return null }
}

/** Validate a renderer for startup-only IPC, including internal tab hosts.
 * Browser-tab contents are never trusted, even if they navigate to app://.
 */
export function trustedStartupSender(sender: Electron.WebContents, windowKey: string | undefined, startupId: string | undefined, expectedStartupId: string): boolean {
  if (!windowKey || !/^[a-zA-Z0-9_:-]{1,100}$/.test(windowKey) || startupId !== expectedStartupId) return false;
  try {
    const senderUrl = new URL(sender.getURL());
    if (senderUrl.protocol !== 'app:' || senderUrl.hostname !== '.' || senderUrl.searchParams.get('windowKey') !== windowKey || senderUrl.searchParams.get('startupId') !== startupId) return false;
    if (sender.session === Electron.session.fromPartition('persist:sulla-browser')) return false;

    const tabHost = senderUrl.searchParams.get('tabHost') === '1';
    const owner = tabHost ? InternalTabViewManager.getInstance().resolveOwner(sender) : Electron.BrowserWindow.fromWebContents(sender);
    if (!owner || owner.isDestroyed() || !isAgentWindowSender(owner.webContents)) return false;

    const ownerUrl = new URL(owner.webContents.getURL());
    return ownerUrl.protocol === 'app:' && ownerUrl.hostname === '.' &&
      ownerUrl.searchParams.get('windowKey') === windowKey && ownerUrl.searchParams.get('startupId') === startupId &&
      (tabHost || owner.webContents === sender);
  } catch { return false }
}
