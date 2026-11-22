// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Tab Context Menu — popup window for browser-tab context menus.
 *
 * A frameless, transparent, always-on-top BrowserWindow that displays
 * the tab context menu on top of WebContentsView layers (which sit above
 * normal DOM elements).  Follows the heartbeatNotification pattern.
 *
 * Flow:
 *   1. Renderer calls  ipcRenderer.send('tab-context-menu:show', { screenX, screenY, items, tabData })
 *   2. Main creates/positions the popup, sends menu items to it
 *   3. User clicks an item → popup sends  ipcMain.on('tab-context-menu:action', action)
 *   4. Main forwards the action to the renderer via  mainWindow.webContents.send('tab-context-menu:selected', action, tabData)
 *   5. Click outside / Escape → popup sends  'tab-context-menu:dismiss'  → main hides window
 */

import path from 'path';

import { BrowserWindow, ipcMain, app } from 'electron';

import Logging from '@pkg/utils/logging';
import { getActiveAgentWindow } from '@pkg/window/agentWindows';
import { agentWindowFromSender } from '@pkg/window/agentWindowTrust';
import { releaseWhenHidden } from '@pkg/window/releaseHiddenWindow';
import { SullaSettingsModel } from '@pkg/agent/database/models/SullaSettingsModel';
import { DEFAULT_THEME_ID } from '@pkg/config/theme';

const console = Logging.background;

let win: BrowserWindow | null = null;

/** Read the exact theme so the popup can apply scheme-specific classes. */
async function getTheme(): Promise<string> {
  try {
    return await SullaSettingsModel.get('theme', DEFAULT_THEME_ID) as string;
  } catch {
    return DEFAULT_THEME_ID;
  }
}

/** Tab data forwarded back to the renderer with the selected action. */
let pendingTabData: Record<string, unknown> | null = null;

/** The agent window that opened this popup; the selected action goes back to it. */
let openerWindow: BrowserWindow | null = null;
let openerContents: Electron.WebContents | null = null;

const MENU_WIDTH = 260;
const MENU_ITEM_HEIGHT = 31;   // 7px padding top+bottom + ~17px content
const SEPARATOR_HEIGHT = 9;    // 1px line + 4px margin each side
const MENU_PADDING = 12;       // 6px top + 6px bottom

/**
 * Register IPC handlers.  Call once from background.ts during startup.
 */
export function registerTabContextMenuIpc(): void {
  ipcMain.on('tab-context-menu:show', onShow);
  ipcMain.on('tab-context-menu:action', onAction);
  ipcMain.on('tab-context-menu:dismiss', onDismiss);
}

// ─── IPC handlers ───────────────────────────────────────────────

async function onShow(
  _event: Electron.IpcMainEvent,
  payload: { screenX: number; screenY: number; items: string[]; tabData: Record<string, unknown> },
): Promise<void> {
  const { screenX, screenY, items, tabData } = payload;

  const owner = agentWindowFromSender(_event.sender);
  if (!owner) return;

  pendingTabData = tabData;
  openerWindow = owner;
  openerContents = _event.sender;

  // Detect theme for proper styling
  const themeId = await getTheme();
  if (pendingTabData !== tabData) return;
  const theme = themeId.includes('-light') ? 'light' : 'dark';

  // Estimate height from item count
  const itemCount = items.filter(i => i !== '---').length;
  const separatorCount = items.filter(i => i === '---').length;
  const estimatedHeight = (itemCount * MENU_ITEM_HEIGHT) + (separatorCount * SEPARATOR_HEIGHT) + MENU_PADDING;

  if (win && !win.isDestroyed()) {
    win.setBounds({
      x: screenX, y: screenY, width: MENU_WIDTH, height: estimatedHeight,
    });
    win.webContents.send('tab-context-menu:data', { items, theme, themeId });
    showPopup(win);
    return;
  }

  // ── Create the window ──

  win = new BrowserWindow({
    width:          MENU_WIDTH,
    height:         estimatedHeight,
    x:              screenX,
    y:              screenY,
    show:           false,
    frame:          false,
    transparent:    true,
    resizable:      false,
    alwaysOnTop:    true,
    skipTaskbar:    true,
    hasShadow:      true,
    focusable:      true,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration:  true,
    },
  });

  const appRoot = app.getAppPath();
  const htmlPath = app.isPackaged
    ? path.join(appRoot, 'dist', 'app', 'assets', 'tab-context-menu.html')
    : path.join(appRoot, 'pkg', 'sulla-desktop', 'assets', 'tab-context-menu.html');

  win.loadFile(htmlPath);

  win.once('ready-to-show', () => {
    if (!win || win.isDestroyed()) return;
    win.webContents.send('tab-context-menu:data', { items, theme, themeId });
    showPopup(win);
  });

  // Dismiss when the window loses focus (user clicked elsewhere)
  win.on('blur', () => {
    _close();
  });

  // Let the renderer go once the menu has been hidden for a while.
  releaseWhenHidden(win);

  win.on('closed', () => {
    win = null;
    pendingTabData = null;
  });

  console.log('[TabContextMenu] Opened popup');
}

function showPopup(popup: BrowserWindow): void {
  popup.showInactive();
  // A quick selection can close the popup before its deferred focus runs.
  setTimeout(() => {
    if (!popup.isDestroyed() && popup.isVisible()) popup.focus();
  }, 50);
}

/** Window the popup should reply to: its opener if still alive, else the active agent window. */
function openerTarget(): BrowserWindow | null {
  if (openerWindow && !openerWindow.isDestroyed()) return openerWindow;
  return getActiveAgentWindow();
}

function onAction(event: Electron.IpcMainEvent, action: string): void {
  if (!win || win.isDestroyed() || event.sender !== win.webContents) return;
  console.log(`[TabContextMenu] Action: ${ action }`);

  if (action === 'rename') {
    const owner = openerWindow;
    const editor = openerContents;
    const tabData = pendingTabData;

    _close();
    // Hiding the popup can restore keyboard focus to the chat's native view.
    // Focus the renderer that owns the tab strip before it opens the editor.
    if (owner && !owner.isDestroyed() && editor && !editor.isDestroyed() && tabData) {
      owner.focus();
      editor.focus();
      editor.send('tab-context-menu:selected', action, tabData);
    }
    return;
  }

  const mainWindow = openerTarget();

  if (mainWindow && !mainWindow.isDestroyed() && pendingTabData) {
    mainWindow.webContents.send('tab-context-menu:selected', action, pendingTabData);
  }

  _close();
}

function onDismiss(): void {
  _close();
}

// ─── Internal ───────────────────────────────────────────────────

function _close(): void {
  if (win && !win.isDestroyed()) {
    win.hide();
  }
  pendingTabData = null;
  openerWindow = null;
  openerContents = null;
}
