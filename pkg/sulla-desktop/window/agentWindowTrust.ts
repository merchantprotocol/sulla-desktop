// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import Electron from 'electron';

import { windowMapping } from '@pkg/window';

/** True only for a live renderer registered as an agent window. */
export function isAgentWindowSender(sender: Electron.WebContents): boolean {
  try {
    const window = Electron.BrowserWindow.fromWebContents(sender);
    if (!window || window.isDestroyed() || window.webContents !== sender) return false;
    return Object.entries(windowMapping).some(([name, id]) => id === window.id && (name === 'main-agent' || name.startsWith('agent:')));
  } catch { return false }
}

/** Resolve a trusted agent window from its renderer. */
export function agentWindowFromSender(sender: Electron.WebContents): Electron.BrowserWindow | null {
  if (!isAgentWindowSender(sender)) return null;
  try { return Electron.BrowserWindow.fromWebContents(sender) ?? null } catch { return null }
}
