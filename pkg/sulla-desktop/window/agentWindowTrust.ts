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
