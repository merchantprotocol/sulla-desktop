/**
 * Tray Panel — popover BrowserWindow that behaves like a native menu bar dropdown.
 *
 * Architecture mirrors sulla/audio-driver: frameless, transparent window
 * positioned below the tray icon, dismissed on blur.
 */

import { BrowserWindow, ipcMain, app } from 'electron';

import Logging from '@pkg/utils/logging';
import { openMain, openEditor, openDockerDashboard, getWindow, openUrlInApp } from '@pkg/window';
import { openDashboard } from '@pkg/window/dashboard';
import setupUpdate from '@pkg/main/update';

const console = Logging.background;

let panelWindow: BrowserWindow | null = null;

export function createTrayPanel(): BrowserWindow {
  if (panelWindow && !panelWindow.isDestroyed()) {
    return panelWindow;
  }

  panelWindow = new BrowserWindow({
    width:           400,
    height:          480,
    show:            false,
    frame:           false,
    transparent:     true,
    resizable:       false,
    skipTaskbar:     true,
    alwaysOnTop:     true,
    hasShadow:       false,
    webPreferences: {
      contextIsolation:     false,
      nodeIntegration:      true,
      backgroundThrottling: false,
    },
  });

  // Load panel via the app:// protocol (same as all other windows)
  panelWindow.loadURL('app://./trayPanel/index.html');

  // Hide on blur — click anywhere else to dismiss
  panelWindow.on('blur', () => {
    panelWindow?.hide();
  });

  // Don't destroy, just hide
  panelWindow.on('close', (e) => {
    e.preventDefault();
    panelWindow?.hide();
  });

  // ── IPC handlers (panel → main) ───────────────────────────────────────
  registerPanelIpc();

  return panelWindow;
}

/**
 * Toggle panel visibility, positioning it below the tray icon bounds.
 */
export function toggleTrayPanel(trayBounds: Electron.Rectangle): void {
  if (!panelWindow || panelWindow.isDestroyed()) {
    createTrayPanel();
  }

  if (panelWindow!.isVisible()) {
    panelWindow!.hide();
    return;
  }

  // Position below the tray icon, centered horizontally
  const { x, y, width } = trayBounds;
  const panelBounds = panelWindow!.getBounds();
  const px = Math.round(x + width / 2 - panelBounds.width / 2);
  const py = y + 4;

  panelWindow!.setPosition(px, py, false);
  panelWindow!.show();
}

/**
 * Send a state update to the panel renderer.
 */
export function sendPanelState(state: {
  docker?: string;
  k8s?: string;
  k8sContext?: string;
  extensions?: Array<{ id: string; label: string; url: string }>;
}): void {
  if (panelWindow && !panelWindow.isDestroyed()) {
    panelWindow.webContents.send('tray-panel:state-update', state);
  }
}

/**
 * Destroy the panel window (app quit).
 */
export function destroyTrayPanel(): void {
  if (panelWindow && !panelWindow.isDestroyed()) {
    panelWindow.removeAllListeners('close');
    panelWindow.destroy();
  }
  panelWindow = null;
}

// ── IPC registration (idempotent) ─────────────────────────────────────────

let ipcRegistered = false;

function registerPanelIpc(): void {
  if (ipcRegistered) return;
  ipcRegistered = true;

  ipcMain.on('tray-panel:open-main', () => {
    openMain();
    panelWindow?.hide();
  });

  ipcMain.on('tray-panel:open-editor', () => {
    openEditor();
    panelWindow?.hide();
  });

  ipcMain.on('tray-panel:open-docker', () => {
    openDockerDashboard();
    panelWindow?.hide();
  });

  ipcMain.on('tray-panel:open-dashboard', () => {
    openDashboard();
    panelWindow?.hide();
  });

  ipcMain.on('tray-panel:secretary-mode', () => {
    openMain();
    const agentWindow = getWindow('main-agent');

    if (agentWindow) {
      const sendCommand = () => agentWindow.webContents.send('agent-command', { command: 'new-secretary-tab' });

      if (agentWindow.webContents.isLoading()) {
        agentWindow.webContents.once('did-finish-load', sendCommand);
      } else {
        sendCommand();
      }
    }
    panelWindow?.hide();
  });

  ipcMain.on('tray-panel:open-url', (_event: Electron.IpcMainEvent, url: string) => {
    openUrlInApp(url);
    panelWindow?.hide();
  });

  ipcMain.handle('tray-panel:check-updates', async() => {
    panelWindow?.hide();
    await setupUpdate(true, false);
  });

  ipcMain.on('tray-panel:quit', () => {
    app.quit();
  });
}
