/**
 * Heartbeat Notification — desktop notification window.
 *
 * A small, frameless, always-on-top BrowserWindow in the top-right corner
 * that shows status updates from the heartbeat agent. Modeled on the
 * call-notification pattern from sulla/audio-driver.
 *
 * Click to expand — renders full markdown, cancels auto-hide, stays until dismissed.
 * Auto-dismisses after timeout if not expanded.
 */

import path from 'path';
import { BrowserWindow, ipcMain, screen, app } from 'electron';

import Logging from '@pkg/utils/logging';

const console = Logging.background;

let win: BrowserWindow | null = null;
let autoHideTimer: ReturnType<typeof setTimeout> | null = null;
let isExpanded = false;

const AUTO_HIDE_MS = 15_000;
const COLLAPSED_WIDTH = 360;
const COLLAPSED_HEIGHT = 120;
const MAX_EXPANDED_WIDTH = 600;
const MAX_EXPANDED_HEIGHT = 800;
const MARGIN = 16;

/**
 * Show a heartbeat notification.
 *
 * @param title  — notification title (e.g. "Sulla")
 * @param message — notification body text (markdown supported)
 */
export function showHeartbeatNotification(title: string, message: string): void {
  if (win && !win.isDestroyed()) {
    // Reuse existing window — update content and re-show
    win.webContents.send('heartbeat-notification-data', { title, message });
    if (!isExpanded) {
      win.showInactive();
      _resetAutoHide();
    }
    return;
  }

  isExpanded = false;

  // Position in top-right of the display the cursor is on
  const cursorPoint = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursorPoint);
  const { x: workX, y: workY } = display.workArea;
  const { width: screenW } = display.workAreaSize;

  win = new BrowserWindow({
    width:       COLLAPSED_WIDTH,
    height:      COLLAPSED_HEIGHT,
    x:           workX + screenW - COLLAPSED_WIDTH - MARGIN,
    y:           workY + MARGIN,
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

  // Load the notification HTML from assets — in dev, load from source tree;
  // in packaged builds, load from dist/app/assets/ (copied by build-utils.copyWindowAssets()).
  const appRoot = app.getAppPath();
  const htmlPath = app.isPackaged
    ? path.join(appRoot, 'dist', 'app', 'assets', 'heartbeat-notification.html')
    : path.join(appRoot, 'pkg', 'rancher-desktop', 'assets', 'heartbeat-notification.html');

  win.loadFile(htmlPath);

  win.once('ready-to-show', () => {
    if (!win || win.isDestroyed()) return;
    win.webContents.send('heartbeat-notification-data', { title, message });
    win.showInactive();
  });

  win.on('closed', () => {
    _clearAutoHide();
    _removeIpcListeners();
    win = null;
    isExpanded = false;
  });

  // IPC: dismiss
  const onDismiss = () => {
    closeHeartbeatNotification();
  };

  // IPC: expand — user clicked the notification, renderer sends content dimensions
  const onExpand = (_event: any, dims?: { width: number; height: number }) => {
    if (!win || win.isDestroyed() || isExpanded) return;

    isExpanded = true;
    _clearAutoHide(); // Stay open until manually dismissed

    // Use content dimensions, capped to max
    const expandW = Math.min(dims?.width || 420, MAX_EXPANDED_WIDTH);
    const expandH = Math.min(dims?.height || 300, MAX_EXPANDED_HEIGHT);

    // Reposition to keep top-right anchor
    const cursorNow = screen.getCursorScreenPoint();
    const displayNow = screen.getDisplayNearestPoint(cursorNow);
    const workArea = displayNow.workArea;
    const newX = workArea.x + workArea.width - expandW - MARGIN;
    const newY = workArea.y + MARGIN;

    win.setBounds({
      x:      newX,
      y:      newY,
      width:  expandW,
      height: expandH,
    }, true); // animate

    win.focus();

    console.log(`[HeartbeatNotification] Expanded to ${ expandW }x${ expandH }`);
  };

  ipcMain.on('heartbeat-notification-dismiss', onDismiss);
  ipcMain.on('heartbeat-notification-expand', onExpand);

  _resetAutoHide();

  console.log(`[HeartbeatNotification] Showing: "${ title }" — ${ message.slice(0, 80) }`);
}

/**
 * Close the notification window.
 */
export function closeHeartbeatNotification(): void {
  _clearAutoHide();
  _removeIpcListeners();
  if (win && !win.isDestroyed()) {
    win.close();
    win = null;
  }
  isExpanded = false;
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

function _removeIpcListeners(): void {
  ipcMain.removeAllListeners('heartbeat-notification-dismiss');
  ipcMain.removeAllListeners('heartbeat-notification-expand');
}
