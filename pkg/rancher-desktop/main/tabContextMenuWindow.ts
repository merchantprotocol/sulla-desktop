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
import { getWindow } from '@pkg/window';

const console = Logging.background;

let win: BrowserWindow | null = null;

/** Tab data forwarded back to the renderer with the selected action. */
let pendingTabData: Record<string, unknown> | null = null;

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

function onShow(
  _event: Electron.IpcMainEvent,
  payload: { screenX: number; screenY: number; items: string[]; tabData: Record<string, unknown> },
): void {
  const { screenX, screenY, items, tabData } = payload;

  pendingTabData = tabData;

  // Estimate height from item count
  const itemCount = items.filter(i => i !== '---').length;
  const separatorCount = items.filter(i => i === '---').length;
  const estimatedHeight = (itemCount * MENU_ITEM_HEIGHT) + (separatorCount * SEPARATOR_HEIGHT) + MENU_PADDING;

  if (win && !win.isDestroyed()) {
    win.setBounds({
      x: screenX, y: screenY, width: MENU_WIDTH, height: estimatedHeight,
    });
    win.webContents.send('tab-context-menu:data', { items });
    win.showInactive();
    // Focus after a tick so the window can receive keyboard events
    setTimeout(() => {
      if (win && !win.isDestroyed()) {
        win.focus();
      }
    }, 50);
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
    : path.join(appRoot, 'pkg', 'rancher-desktop', 'assets', 'tab-context-menu.html');

  win.loadFile(htmlPath);

  win.once('ready-to-show', () => {
    if (!win || win.isDestroyed()) return;
    win.webContents.send('tab-context-menu:data', { items });
    win.showInactive();
    setTimeout(() => {
      if (win && !win.isDestroyed()) {
        win.focus();
      }
    }, 50);
  });

  // Dismiss when the window loses focus (user clicked elsewhere)
  win.on('blur', () => {
    _close();
  });

  win.on('closed', () => {
    win = null;
    pendingTabData = null;
  });

  console.log('[TabContextMenu] Opened popup');
}

function onAction(_event: Electron.IpcMainEvent, action: string): void {
  console.log(`[TabContextMenu] Action: ${ action }`);

  // Forward the selected action + original tab data back to the renderer
  const mainWindow = getWindow('main-agent') ?? getWindow('main');

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
}
