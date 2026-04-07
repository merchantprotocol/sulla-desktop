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
import { BrowserWindow, ipcMain, screen } from 'electron';
import Logging from '@pkg/utils/logging';

const console = Logging.background;

let prompterWindow: BrowserWindow | null = null;

/**
 * Create or show the floating teleprompter window.
 */
export function openTeleprompterWindow(): BrowserWindow {
  if (prompterWindow && !prompterWindow.isDestroyed()) {
    prompterWindow.show();
    prompterWindow.focus();
    return prompterWindow;
  }

  const display = screen.getPrimaryDisplay();
  const { width: screenWidth } = display.size;

  // Size: compact, just wide enough for a comfortable reading column
  const winWidth = 400;
  const winHeight = 160;

  // Position: top center, just below the webcam/notch area
  const x = Math.round((screenWidth - winWidth) / 2);
  const y = 8; // just below the top bezel/notch

  prompterWindow = new BrowserWindow({
    width:           winWidth,
    height:          winHeight,
    x,
    y,
    frame:           false,
    transparent:     true,
    alwaysOnTop:     true,
    hasShadow:       false,
    resizable:       true,
    minimizable:     false,
    maximizable:     false,
    fullscreenable:  false,
    skipTaskbar:     true,
    roundedCorners:  true,
    webPreferences: {
      nodeIntegration:  true,
      contextIsolation: false,
    },
  });

  // Load the teleprompter HTML
  const htmlPath = path.join(__dirname, '..', 'public', 'teleprompter-float.html');
  prompterWindow.loadFile(htmlPath).catch((err) => {
    // Fallback: try alternate path (dist builds)
    const altPath = path.join(__dirname, 'teleprompter-float.html');
    prompterWindow?.loadFile(altPath).catch((err2) => {
      console.error('[TeleprompterWindow] Failed to load HTML:', err.message, err2.message);
    });
  });

  prompterWindow.on('closed', () => {
    prompterWindow = null;
  });

  console.log('[TeleprompterWindow] Opened', { x, y, width: winWidth, height: winHeight });
  return prompterWindow;
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
  ipcMain.handle('teleprompter:open', () => {
    openTeleprompterWindow();
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
}
