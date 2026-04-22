/**
 * Tray Panel — popover BrowserWindow that behaves like a native menu bar dropdown.
 *
 * Architecture mirrors sulla/audio-driver: frameless, transparent window
 * positioned below the tray icon, dismissed on blur.
 */

import path from 'path';

import { BrowserWindow, ipcMain, app } from 'electron';

import mainEvents from '@pkg/main/mainEvents';
import setupUpdate from '@pkg/main/update';
import Logging from '@pkg/utils/logging';
import { openMain, openDockerDashboard, getWindow, openUrlInApp } from '@pkg/window';
import { openDashboard } from '@pkg/window/dashboard';

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

  // Load panel via filesystem path (not app:// protocol) so that
  // require() in panel.js can resolve relative paths to renderer modules.
  // This matches how the standalone audio-driver loads its renderer.
  const appRoot = app.getAppPath();
  const trayPanelDir = path.join(appRoot, 'dist', 'app', 'trayPanel');
  panelWindow.loadFile(path.join(trayPanelDir, 'index.html'));

  // Open DevTools with Cmd+Shift+I (debug the tray panel renderer)
  panelWindow.webContents.on('before-input-event', (_event, input) => {
    if (input.meta && input.shift && input.key === 'i') {
      panelWindow?.webContents.openDevTools({ mode: 'detach' });
    }
  });

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
  docker?:     string;
  k8s?:        string;
  k8sContext?: string;
}): void {
  if (panelWindow && !panelWindow.isDestroyed()) {
    panelWindow.webContents.send('tray-panel:state-update', state);
  }
}

/**
 * Send audio capture state to the panel renderer.
 */
export function sendAudioState(state: { running: boolean; message?: string }): void {
  if (panelWindow && !panelWindow.isDestroyed()) {
    panelWindow.webContents.send('tray-panel:audio-state', state);
  }
}

/**
 * Send audio level data to the panel renderer for meter display.
 */
export function sendAudioMicLevel(level: number): void {
  if (panelWindow && !panelWindow.isDestroyed()) {
    panelWindow.webContents.send('tray-panel:audio-mic-level', level);
  }
}

export function sendAudioSpeakerLevel(level: number): void {
  if (panelWindow && !panelWindow.isDestroyed()) {
    panelWindow.webContents.send('tray-panel:audio-speaker-level', level);
  }
}

/**
 * Send available audio devices to the panel renderer.
 */
export function sendAudioDevices(data: {
  inputs:        { deviceId: string; label: string }[];
  outputs:       { deviceId: string; label: string }[];
  activeInput?:  string;
  activeOutput?: string;
}): void {
  if (panelWindow && !panelWindow.isDestroyed()) {
    panelWindow.webContents.send('tray-panel:audio-devices', data);
  }
}

/**
 * Send audio detection state (VAD, noise, feedback) to the panel renderer.
 */
export function sendAudioDetection(data: {
  statusDotClass: string;
  statusText:     string;
  noisePct:       number;
  noiseLevel:     string;
  noiseLabel:     string;
  feedbackPct:    number;
  feedbackLabel:  string;
}): void {
  if (panelWindow && !panelWindow.isDestroyed()) {
    panelWindow.webContents.send('tray-panel:audio-detection', data);
  }
}

/**
 * Send authentication state to the panel renderer.
 */
export function sendAuthState(state: { loggedIn: boolean; vaultSetUp: boolean }): void {
  if (panelWindow && !panelWindow.isDestroyed()) {
    panelWindow.webContents.send('tray-panel:auth-state', state);
  }
}

/**
 * Send settings state (autoStart, startInBackground) to the panel renderer.
 */
export function sendSettingsState(state: { autoStart: boolean; startInBackground: boolean }): void {
  if (panelWindow && !panelWindow.isDestroyed()) {
    panelWindow.webContents.send('tray-panel:settings-state', state);
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

  ipcMain.on('tray-panel:quit', async() => {
    // 1. Hide the tray panel immediately for visual feedback
    panelWindow?.hide();

    // 2. Tell all renderer windows to stop capture / recording
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
        win.webContents.send('app:before-quit');
      }
    }

    // 3. Stop audio capture from the main process side
    try {
      const audioDriver = await import('@pkg/main/audio-driver/init');

      await audioDriver.shutdown();
    } catch (err) {
      console.error('[TrayPanel] Pre-quit audio shutdown error:', err);
    }

    // 4. Close all open windows (gives them a chance to run onBeforeUnmount)
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.close();
      }
    }

    // 5. Trigger the full shutdown sequence
    app.quit();
  });

  // ── Auth IPC handlers ─────────────────────────────────────────────────

  ipcMain.handle('tray-panel:check-auth', async() => {
    try {
      const { getVaultKeyService } = await import('@pkg/agent/services/VaultKeyService');
      const vaultKey = getVaultKeyService();

      return {
        loggedIn:   vaultKey.isUnlocked(),
        vaultSetUp: vaultKey.isSetUp(),
      };
    } catch {
      return { loggedIn: false, vaultSetUp: false };
    }
  });

  ipcMain.handle('tray-panel:login', async(_event: Electron.IpcMainInvokeEvent, data: { password: string }) => {
    try {
      const { getVaultKeyService } = await import('@pkg/agent/services/VaultKeyService');
      const vaultKey = getVaultKeyService();
      const success = await vaultKey.recoverFromMasterPassword(data.password);

      if (success) {
        const { setUserLoggedIn } = await import('@pkg/main/mainmenu');

        setUserLoggedIn(true);
      }

      return { success };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  // ── Settings toggle IPC handlers ──────────────────────────────────────

  ipcMain.handle('tray-panel:get-settings', async() => {
    try {
      const cfg = await mainEvents.invoke('settings-fetch');

      return {
        autoStart:         cfg.application.autoStart,
        startInBackground: cfg.application.startInBackground,
      };
    } catch {
      return { autoStart: false, startInBackground: false };
    }
  });

  ipcMain.on('tray-panel:set-setting', (_event: Electron.IpcMainEvent, data: { key: string; value: boolean }) => {
    if (data.key === 'autoStart') {
      mainEvents.emit('settings-write', { application: { autoStart: data.value } });
    } else if (data.key === 'startInBackground') {
      mainEvents.emit('settings-write', { application: { startInBackground: data.value } });
    }
  });

  // ── Audio panel IPC handlers ──────────────────────────────────────────
  // These are handled by audio-driver/init.js which registers its own
  // ipcMain.on('tray-panel:audio-*') handlers. The audio-driver init
  // module is loaded in background.ts and registers all handlers there.
  // No duplicate registration needed here.
}
