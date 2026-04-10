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
import { BrowserWindow, ipcMain, app, screen } from 'electron';

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
  payload: { screenX: number; screenY: number; buttonWidth?: number; buttonHeight?: number; theme?: string },
): void {
  const { screenX, screenY, theme = 'protocol-dark' } = payload;
  const isDark = !theme.includes('light');

  console.log('[MoreMenu] onShow', { screenX, screenY, existingWindow: !!win, theme });

  // Get the display where the click occurred and ensure menu stays on screen
  const display = screen.getDisplayNearestPoint({ x: screenX, y: screenY });
  const { workArea } = display;

  // Menu appears BELOW the button (screenY is already bottom of button)
  // Add a small gap of 4px between button and menu
  const GAP = 4;

  // Calculate adjusted position to keep menu within screen bounds
  let adjustedX = screenX;
  let adjustedY = screenY + GAP;

  // If menu would go off the right edge, align it to the right edge
  if (adjustedX + MENU_WIDTH > workArea.x + workArea.width) {
    adjustedX = workArea.x + workArea.width - MENU_WIDTH - 8; // 8px margin
  }

  // If menu would go off the bottom edge, show it above the button instead
  if (adjustedY + MENU_HEIGHT > workArea.y + workArea.height) {
    adjustedY = screenY - MENU_HEIGHT - GAP;
  }

  if (win && !win.isDestroyed()) {
    win.setBounds({ x: adjustedX, y: adjustedY, width: MENU_WIDTH, height: MENU_HEIGHT });
    win.webContents.send('more-menu:show', { theme });
    _showAndFocus();
    return;
  }

  win = new BrowserWindow({
    width:             MENU_WIDTH,
    height:            MENU_HEIGHT,
    x:                 adjustedX,
    y:                 adjustedY,
    show:              false,
    frame:             false,
    transparent:       true,
    resizable:         false,
    alwaysOnTop:       true,
    skipTaskbar:       true,
    hasShadow:         false,
    focusable:         true,
    backgroundColor:   '#00000000',
    webPreferences:    {
      contextIsolation: false,
      nodeIntegration:  true,
    },
  });

  const appRoot = app.getAppPath();
  const htmlPath = app.isPackaged
    ? path.join(appRoot, 'dist', 'app', 'assets', 'more-menu.html')
    : path.join(appRoot, 'pkg', 'rancher-desktop', 'assets', 'more-menu.html');

  // Pass theme as query param
  win.loadFile(htmlPath, { query: { theme } });

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

function onRequestHistory(
  _event: Electron.IpcMainEvent,
  data?: { currentWidth?: number },
): void {
  // Ask the renderer for history entries, then forward them to the popup
  const mainWindow = getWindow('main-agent') ?? getWindow('main');

  if (mainWindow && !mainWindow.isDestroyed()) {
    // Store current popup position for later repositioning
    if (win && !win.isDestroyed()) {
      const bounds = win.getBounds();
      const display = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y });
      const { workArea } = display;

      // Target width for history view
      const targetWidth = 280;
      const rightEdge = bounds.x + targetWidth;
      const screenRightEdge = workArea.x + workArea.width;

      // If expanding right would go off screen, shift left
      let newX = bounds.x;
      if (rightEdge > screenRightEdge - 8) { // 8px margin
        newX = screenRightEdge - targetWidth - 8;
        if (newX < workArea.x) {
          newX = workArea.x;
        }
        // Pre-emptively move window to new position
        win.setBounds({ x: newX, y: bounds.y, width: bounds.width, height: bounds.height });
      }

      // Store target width for when history data comes back
      (win as any).__historyTargetWidth = targetWidth;
    }

    mainWindow.webContents.send('more-menu:fetch-history');
  }
}

function onResize(
  _event: Electron.IpcMainEvent,
  dims: { width: number; height: number },
): void {
  if (!win || win.isDestroyed()) return;
  const bounds = win.getBounds();

  // If shrinking back to main menu (width 200), keep position
  // If expanding, check if we need to shift left (already done in onRequestHistory)
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
    // Get the target width we calculated earlier
    const targetWidth = (win as any).__historyTargetWidth || 280;
    win.webContents.send('more-menu:history-data', entries, targetWidth);
    // Clear stored value
    delete (win as any).__historyTargetWidth;
  }
}

// ─── Internal ───────────────────────────────────────────────────

function _close(): void {
  if (win && !win.isDestroyed()) {
    win.hide();
  }
}
