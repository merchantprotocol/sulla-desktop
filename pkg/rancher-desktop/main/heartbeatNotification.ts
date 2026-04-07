/**
 * Heartbeat Notification — desktop notification window.
 *
 * A small, frameless, always-on-top BrowserWindow in the top-right corner
 * that shows status updates from the heartbeat agent. Modeled on the
 * call-notification pattern from sulla/audio-driver.
 *
 * The window auto-dismisses after a timeout if not manually closed.
 */

import path from 'path';
import { BrowserWindow, ipcMain, screen, app } from 'electron';

import Logging from '@pkg/utils/logging';

const console = Logging.background;

let win: BrowserWindow | null = null;
let autoHideTimer: ReturnType<typeof setTimeout> | null = null;

const AUTO_HIDE_MS = 15_000;
const WINDOW_WIDTH = 360;
const WINDOW_HEIGHT = 120;
const MARGIN = 16;

/**
 * Show a heartbeat notification.
 *
 * @param title  — notification title (e.g. "Sulla")
 * @param message — notification body text
 */
export function showHeartbeatNotification(title: string, message: string): void {
  if (win && !win.isDestroyed()) {
    // Reuse existing window — update content and re-show
    win.webContents.send('heartbeat-notification-data', { title, message });
    win.showInactive();
    _resetAutoHide();
    return;
  }

  // Position in top-right of the display the cursor is on
  const cursorPoint = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursorPoint);
  const { x: workX, y: workY } = display.workArea;
  const { width: screenW } = display.workAreaSize;

  win = new BrowserWindow({
    width:       WINDOW_WIDTH,
    height:      WINDOW_HEIGHT,
    x:           workX + screenW - WINDOW_WIDTH - MARGIN,
    y:           workY + MARGIN,
    show:        false,
    frame:       false,
    transparent: true,
    resizable:   false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow:   true,
    focusable:   false,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration:  true,
    },
  });

  // Load the notification HTML from assets
  const appRoot = app.getAppPath();
  const htmlPath = app.isPackaged
    ? path.join(appRoot, 'assets', 'heartbeat-notification.html')
    : path.join(appRoot, 'pkg', 'rancher-desktop', 'assets', 'heartbeat-notification.html');

  win.loadFile(htmlPath);

  win.once('ready-to-show', () => {
    if (!win || win.isDestroyed()) return;
    win.webContents.send('heartbeat-notification-data', { title, message });
    win.showInactive();
  });

  win.on('closed', () => {
    _clearAutoHide();
    win = null;
  });

  // Dismiss button
  ipcMain.once('heartbeat-notification-dismiss', () => {
    closeHeartbeatNotification();
  });

  _resetAutoHide();

  console.log(`[HeartbeatNotification] Showing: "${ title }" — ${ message.slice(0, 80) }`);
}

/**
 * Close the notification window.
 */
export function closeHeartbeatNotification(): void {
  _clearAutoHide();
  if (win && !win.isDestroyed()) {
    ipcMain.removeAllListeners('heartbeat-notification-dismiss');
    win.close();
    win = null;
  }
}

/**
 * Whether the notification is currently showing.
 */
export function isHeartbeatNotificationOpen(): boolean {
  return win !== null && !win.isDestroyed();
}

// ─── Internal ───────────────────────────────────────────────────

function _resetAutoHide(): void {
  _clearAutoHide();
  autoHideTimer = setTimeout(() => {
    closeHeartbeatNotification();
  }, AUTO_HIDE_MS);
}

function _clearAutoHide(): void {
  if (autoHideTimer) {
    clearTimeout(autoHideTimer);
    autoHideTimer = null;
  }
}
