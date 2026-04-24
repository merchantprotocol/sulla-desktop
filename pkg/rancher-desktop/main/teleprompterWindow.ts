/**
 * Floating teleprompter window — small, always-on-top, positioned near the webcam.
 *
 * The window sits just below the camera (top center of screen) so the user
 * appears to maintain eye contact while reading. Draggable left/right to
 * align with the specific camera position.
 *
 * Script content and scroll position are synced from the Capture Studio
 * via IPC. Voice tracking drives the position updates.
 */

import path from 'path';

import { BrowserWindow, ipcMain, screen, app } from 'electron';

import Logging from '@pkg/utils/logging';

const console = Logging.background;

let prompterWindow: BrowserWindow | null = null;

const WIN_WIDTH = 500;
const WIN_HEIGHT = 180;
const MARGIN = 16;

/**
 * Create or show the floating teleprompter window.
 * Uses the same pattern as heartbeatNotification — app.getAppPath() for
 * reliable HTML resolution in both dev and packaged builds.
 */
export function openTeleprompterWindow(): BrowserWindow {
  if (prompterWindow && !prompterWindow.isDestroyed()) {
    prompterWindow.show();
    prompterWindow.focus();
    return prompterWindow;
  }

  // Position: top center of the display the cursor is on
  const cursorPoint = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursorPoint);
  const { x: workX, y: workY, width: workW } = display.workArea;
  const x = workX + Math.round((workW - WIN_WIDTH) / 2);
  const y = workY;

  prompterWindow = new BrowserWindow({
    width:          WIN_WIDTH,
    height:         WIN_HEIGHT,
    x,
    y,
    show:           false,
    frame:          false,
    transparent:    true,
    alwaysOnTop:    true,
    hasShadow:      true,
    resizable:      true,
    minimizable:    false,
    maximizable:    false,
    fullscreenable: false,
    skipTaskbar:    true,
    focusable:      true,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration:  true,
    },
  });

  // Load HTML — in dev, load from source; in packaged builds, load from
  // dist/app/assets/ (copied by build-utils.copyWindowAssets()).
  const appRoot = app.getAppPath();
  const htmlPath = app.isPackaged
    ? path.join(appRoot, 'dist', 'app', 'assets', 'teleprompter-float.html')
    : path.join(appRoot, 'pkg', 'rancher-desktop', 'assets', 'teleprompter-float.html');

  console.log('[TeleprompterWindow] Loading HTML from:', htmlPath);

  // Exclude this window from screen capture so it doesn't appear in recordings
  prompterWindow.setContentProtection(true);

  prompterWindow.webContents.on('did-finish-load', () => {
    if (!prompterWindow || prompterWindow.isDestroyed()) return;
    prompterWindow.show();
    console.log('[TeleprompterWindow] Opened', { x, y, width: WIN_WIDTH, height: WIN_HEIGHT });
  });

  prompterWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    console.error('[TeleprompterWindow] Failed to load:', errorCode, errorDescription, htmlPath);
  });

  prompterWindow.loadFile(htmlPath).catch((err) => {
    console.error('[TeleprompterWindow] loadFile error:', err.message);
  });

  prompterWindow.on('closed', () => {
    prompterWindow = null;
  });

  return prompterWindow;
}

/**
 * Resolve when the teleprompter's webContents has finished loading (or
 * timed out). Callers that send IPC messages to the window immediately
 * after opening it must await this first, otherwise did-finish-load
 * hasn't fired yet and webContents.send() is dropped on the floor.
 */
export function whenTeleprompterReady(timeoutMs = 3_000): Promise<void> {
  if (!prompterWindow || prompterWindow.isDestroyed()) {
    return Promise.reject(new Error('Teleprompter is not open.'));
  }
  const wc = prompterWindow.webContents;
  if (!wc.isLoading() && wc.getURL()) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = () => resolve();
    wc.once('did-finish-load', done);
    wc.once('did-fail-load', done);
    setTimeout(done, timeoutMs);
  });
}

/**
 * Close the floating teleprompter window.
 */
export function closeTeleprompterWindow(): void {
  if (prompterWindow && !prompterWindow.isDestroyed()) {
    prompterWindow.close();
  }
  prompterWindow = null;
}

/**
 * Check if the teleprompter window is open.
 */
export function isTeleprompterOpen(): boolean {
  return !!prompterWindow && !prompterWindow.isDestroyed();
}

/**
 * Send script content to the floating teleprompter.
 */
export function sendScript(words: string[], currentIndex: number): void {
  if (prompterWindow && !prompterWindow.isDestroyed()) {
    prompterWindow.webContents.send('teleprompter:set-script', { words, currentIndex });
  }
}

/**
 * Update the scroll position (called on every word advance).
 */
export function sendPosition(currentIndex: number): void {
  if (prompterWindow && !prompterWindow.isDestroyed()) {
    prompterWindow.webContents.send('teleprompter:update-position', { currentIndex });
  }
}

/**
 * Update visual style (font size, highlight color).
 */
export function sendStyle(opts: { fontSize?: number; highlightColor?: string }): void {
  if (prompterWindow && !prompterWindow.isDestroyed()) {
    prompterWindow.webContents.send('teleprompter:set-style', opts);
  }
}

/**
 * Register IPC handlers for the teleprompter window.
 */
export function registerTeleprompterIpc(): void {
  ipcMain.handle('teleprompter:open', async() => {
    const win = openTeleprompterWindow();

    // Wait for the HTML to fully load before returning, so the renderer
    // can safely send script/style data immediately after this resolves.
    if (win && !win.isDestroyed() && !win.isVisible()) {
      await new Promise<void>((resolve) => {
        win.webContents.once('did-finish-load', () => resolve());
        win.webContents.once('did-fail-load', () => resolve());
        setTimeout(() => resolve(), 3000);
      });
    }

    return { ok: true };
  });

  ipcMain.handle('teleprompter:close', () => {
    closeTeleprompterWindow();
    return { ok: true };
  });

  ipcMain.handle('teleprompter:is-open', () => {
    return { open: isTeleprompterOpen() };
  });

  ipcMain.handle('teleprompter:set-script', (_event: unknown, data: { words: string[]; currentIndex: number }) => {
    sendScript(data.words, data.currentIndex);
    return { ok: true };
  });

  ipcMain.handle('teleprompter:update-position', (_event: unknown, data: { currentIndex: number }) => {
    sendPosition(data.currentIndex);
    return { ok: true };
  });

  ipcMain.handle('teleprompter:set-style', (_event: unknown, data: { fontSize?: number; highlightColor?: string }) => {
    sendStyle(data);
    return { ok: true };
  });

  // Forward jump-to from the floating window back to all renderer windows
  // AND update the main-process tracking module's position.
  ipcMain.handle('teleprompter:jump-to', async(_event: unknown, data: { currentIndex: number }) => {
    // Update the main-process tracker directly
    try {
      const tracking = await import('@pkg/main/teleprompterTracking');
      tracking.onJumpTo(data.currentIndex);
    } catch { /* tracking module not loaded yet — fine */ }

    // Broadcast to all windows except the floating prompter itself
    for (const win of BrowserWindow.getAllWindows()) {
      if (win !== prompterWindow && !win.isDestroyed()) {
        win.webContents.send('teleprompter:jump-to', data);
      }
    }
    return { ok: true };
  });
}
