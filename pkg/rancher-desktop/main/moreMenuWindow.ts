/**
 * More Menu — popup window for the three-dot tab-bar menu.
 *
 * Same pattern as tabContextMenuWindow: a frameless, transparent,
 * always-on-top BrowserWindow that floats above WebContentsView layers.
 *
 * Supports a main view (New Tab, Integrations, etc.) and a History
 * submenu.  History entries are fetched on demand — the renderer asks
 * via 'more-menu:request-history', the main process resolves the data
 * and pushes it to the popup.
 */

import path from 'path';
import { BrowserWindow, ipcMain, app } from 'electron';

import Logging from '@pkg/utils/logging';
import { getWindow } from '@pkg/window';

const console = Logging.background;

let win: BrowserWindow | null = null;
let showGuard = false;  // prevents spurious blur during initial show

const MENU_WIDTH = 200;
const MENU_HEIGHT = 210;  // main view with 5 items + separator

/**
 * Register IPC handlers.  Call once from background.ts during startup.
 */
export function registerMoreMenuIpc(): void {
  ipcMain.on('more-menu:show', onShow);
  ipcMain.on('more-menu:action', onAction);
  ipcMain.on('more-menu:dismiss', onDismiss);
  ipcMain.on('more-menu:request-history', onRequestHistory);
  ipcMain.on('more-menu:resize', onResize);
  ipcMain.on('more-menu:push-history', onPushHistory);
}

// ─── IPC handlers ───────────────────────────────────────────────

function _showAndFocus(): void {
  if (!win || win.isDestroyed()) return;
  showGuard = true;
  win.show();        // show + focus in one step (avoids macOS blur race)
  win.focus();       // ensure focus even if show() didn't grant it
  setTimeout(() => { showGuard = false; }, 200);
}

function onShow(
  _event: Electron.IpcMainEvent,
  payload: { screenX: number; screenY: number },
): void {
  const { screenX, screenY } = payload;
  console.log('[MoreMenu] onShow', { screenX, screenY, existingWindow: !!win });

  if (win && !win.isDestroyed()) {
    win.setBounds({ x: screenX, y: screenY, width: MENU_WIDTH, height: MENU_HEIGHT });
    win.webContents.send('more-menu:show');
    _showAndFocus();
    return;
  }

  win = new BrowserWindow({
    width:       MENU_WIDTH,
    height:      MENU_HEIGHT,
    x:           screenX,
    y:           screenY,
    show:        false,
    frame:       false,
    transparent: true,
    resizable:   false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow:   true,
    focusable:   true,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration:  true,
    },
  });

  const appRoot = app.getAppPath();
  const htmlPath = app.isPackaged
    ? path.join(appRoot, 'dist', 'app', 'assets', 'more-menu.html')
    : path.join(appRoot, 'pkg', 'rancher-desktop', 'assets', 'more-menu.html');

  win.loadFile(htmlPath);

  win.once('ready-to-show', () => {
    _showAndFocus();
  });

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    console.error('[MoreMenu] Failed to load HTML:', errorCode, errorDescription, htmlPath);
  });

  win.on('blur', () => {
    if (!showGuard) _close();
  });

  win.on('closed', () => {
    win = null;
  });

  console.log('[MoreMenu] Created popup window, loading:', htmlPath);
}

function onAction(
  _event: Electron.IpcMainEvent,
  action: string,
  extra?: Record<string, unknown>,
): void {
  console.log(`[MoreMenu] Action: ${ action }`);

  const mainWindow = getWindow('main-agent') ?? getWindow('main');

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('more-menu:selected', action, extra ?? null);
  }

  _close();
}

function onRequestHistory(): void {
  // Ask the renderer for history entries, then forward them to the popup
  const mainWindow = getWindow('main-agent') ?? getWindow('main');

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('more-menu:fetch-history');
  }
}

function onResize(
  _event: Electron.IpcMainEvent,
  dims: { width: number; height: number },
): void {
  if (!win || win.isDestroyed()) return;
  const bounds = win.getBounds();

  win.setBounds({
    x:      bounds.x,
    y:      bounds.y,
    width:  dims.width,
    height: dims.height,
  });
}

function onDismiss(): void {
  _close();
}

/** Renderer pushed history entries back — forward them to the popup. */
function onPushHistory(_event: Electron.IpcMainEvent, entries: unknown[]): void {
  if (win && !win.isDestroyed()) {
    win.webContents.send('more-menu:history-data', entries);
  }
}

// ─── Internal ───────────────────────────────────────────────────

function _close(): void {
  if (win && !win.isDestroyed()) {
    win.hide();
  }
}
