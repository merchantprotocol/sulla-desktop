/**
 * Tray Panel — popover BrowserWindow that behaves like a native menu bar dropdown.
 *
 * Architecture mirrors sulla/audio-driver: frameless, transparent window
 * positioned below the tray icon, dismissed on blur.
 */

import fs from 'node:fs';
import path from 'node:path';

import { BrowserWindow, ipcMain, app, clipboard, globalShortcut, shell } from 'electron';

import { SullaSettingsModel } from '@pkg/agent/database/models/SullaSettingsModel';
import mainEvents from '@pkg/main/mainEvents';
import { getSullaFilesCaptureService, openScreenshotMarkup, type CaptureResult, type ScreenshotMode } from '@pkg/main/sullaFilesCapture';
import { getSullaFilesLinkService, SharingUnavailableError, type ShareMode } from '@pkg/main/sullaFilesLinkService';
import { getSullaFilesWatcher } from '@pkg/main/sullaFilesWatcher';
import { updateManager } from '@pkg/main/update/UpdateManager';
import Logging from '@pkg/utils/logging';
import { openMain, openDockerDashboard, getWindow, openUrlInApp } from '@pkg/window';
import { openDashboard } from '@pkg/window/dashboard';

const console = Logging.background;

let panelWindow: BrowserWindow | null = null;
let preferencesWindow: BrowserWindow | null = null;
let afterCaptureWindow: BrowserWindow | null = null;
const CAPTURE_SHORTCUTS = ['CommandOrControl+Shift+5', 'CommandOrControl+Shift+U', 'CommandOrControl+Shift+S'];

const preferenceDefaults = {
  defaultAction:             'share',
  keepCapturesAvailable:     true,
  expiryDays:                30,
  visitorMode:               'view',
  screenshotLocation:        'Screenshots',
  recordingLocation:         'Recordings',
  ordinaryKeepAvailable:     false,
  recordMic:                 true,
  recordCamera:              false,
} as const;

const preferenceKeys:Record<keyof typeof preferenceDefaults, { property:string; cast:'string'|'number'|'boolean' }> = {
  defaultAction:         { property: 'sullaFilesCaptureDefaultAction', cast: 'string' },
  keepCapturesAvailable: { property: 'sullaFilesKeepCapturesAvailable', cast: 'boolean' },
  expiryDays:            { property: 'sullaFilesCaptureExpiryDays', cast: 'number' },
  visitorMode:           { property: 'sullaFilesCaptureVisitorMode', cast: 'string' },
  screenshotLocation:    { property: 'sullaFilesScreenshotLocation', cast: 'string' },
  recordingLocation:     { property: 'sullaFilesRecordingLocation', cast: 'string' },
  ordinaryKeepAvailable: { property: 'sullaFilesOrdinaryKeepAvailable', cast: 'boolean' },
  recordMic:             { property: 'sullaFilesRecordMic', cast: 'boolean' },
  recordCamera:          { property: 'sullaFilesRecordCamera', cast: 'boolean' },
};

async function capturePreferences():Promise<Record<string, unknown>> {
  const entries = await Promise.all(Object.entries(preferenceKeys).map(async([key, value]) => [key, await SullaSettingsModel.get(value.property, preferenceDefaults[key as keyof typeof preferenceDefaults])]));

  return Object.fromEntries(entries);
}

function openFilesScreen(section?:string, filePath?:string):void {
  openMain();
  const agentWindow = getWindow('main-agent');
  if (!agentWindow) return;
  const send = () => agentWindow.webContents.send('agent-command', { command: 'open-tab', mode: 'files', section, path: filePath });

  if (agentWindow.webContents.isLoading()) agentWindow.webContents.once('did-finish-load', send);
  else send();
  panelWindow?.hide();
}

function showCaptureResult(capture:CaptureResult):void {
  if (afterCaptureWindow && !afterCaptureWindow.isDestroyed()) afterCaptureWindow.destroy();
  afterCaptureWindow = new BrowserWindow({
    width: 430, height: 455, show: false, frame: false, resizable: false, alwaysOnTop: true,
    backgroundColor: '#101821', title: 'Sulla Files — Capture',
    webPreferences: { contextIsolation: false, nodeIntegration: true },
  });
  afterCaptureWindow.loadFile(path.join(app.getAppPath(), 'dist', 'app', 'trayPanel', 'afterCapture.html'));
  afterCaptureWindow.once('ready-to-show', () => {
    afterCaptureWindow?.show();
    afterCaptureWindow?.webContents.send('files-after-capture:show', capture);
  });
  afterCaptureWindow.on('closed', () => { afterCaptureWindow = null });
}

function openFilesPreferences(tab = 'capture'):void {
  if (preferencesWindow && !preferencesWindow.isDestroyed()) {
    preferencesWindow.show();
    preferencesWindow.webContents.send('files-preferences:select-tab', tab);
    return;
  }
  preferencesWindow = new BrowserWindow({
    width: 680, height: 610, minWidth: 620, minHeight: 560, show: false,
    title: 'Sulla Files — Preferences', backgroundColor: '#101821',
    webPreferences: { contextIsolation: false, nodeIntegration: true },
  });
  preferencesWindow.loadFile(path.join(app.getAppPath(), 'dist', 'app', 'trayPanel', 'preferences.html'), { query: { tab } });
  preferencesWindow.once('ready-to-show', () => preferencesWindow?.show());
  preferencesWindow.on('closed', () => { preferencesWindow = null });
  panelWindow?.hide();
}

function registerCaptureShortcuts():void {
  const registrations:Array<[string, () => void]> = [
    [CAPTURE_SHORTCUTS[0], () => getSullaFilesCaptureService().screenshot('area').then(showCaptureResult).catch(error => { if (!(error as any)?.cancelled) console.warn('[SullaFiles] shortcut screenshot failed:', error) })],
    [CAPTURE_SHORTCUTS[1], () => {
      if (!panelWindow || panelWindow.isDestroyed()) createTrayPanel();
      panelWindow?.show();
      const send = () => { panelWindow?.webContents.send('tray-panel:select-view', 'files'); panelWindow?.webContents.send('tray-panel:shortcut-upload') };

      if (panelWindow?.webContents.isLoading()) panelWindow.webContents.once('did-finish-load', send);
      else send();
    }],
    [CAPTURE_SHORTCUTS[2], () => openMain()],
  ];

  for (const [accelerator, handler] of registrations) {
    if (!globalShortcut.isRegistered(accelerator) && !globalShortcut.register(accelerator, handler)) console.warn(`[SullaFiles] global shortcut ${ accelerator } is owned by macOS or another app`);
  }
}

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
  registerCaptureShortcuts();
  getSullaFilesWatcher().initialize().catch(error => console.warn('[SullaFiles] watcher initialization failed:', error));

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
  for (const accelerator of CAPTURE_SHORTCUTS) globalShortcut.unregister(accelerator);
  if (preferencesWindow && !preferencesWindow.isDestroyed()) preferencesWindow.destroy();
  if (afterCaptureWindow && !afterCaptureWindow.isDestroyed()) afterCaptureWindow.destroy();
  preferencesWindow = null;
  afterCaptureWindow = null;
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

  ipcMain.on('tray-panel:open-capture-studio', async() => {
    panelWindow?.hide();
    const { openCaptureStudio } = await import('@pkg/window');

    openCaptureStudio();
  });

  ipcMain.handle('tray-panel:files-status', () => getSullaFilesWatcher().status());
  ipcMain.handle('tray-panel:files-pause', (_event, paused:boolean) => getSullaFilesWatcher().setPaused(paused));
  ipcMain.handle('tray-panel:files-pause-hour', () => getSullaFilesWatcher().pauseFor(60 * 60_000));
  ipcMain.on('tray-panel:view-change', (_event, view:string) => panelWindow?.setSize(view === 'files' ? 410 : 400, view === 'files' ? 735 : 480, true));
  ipcMain.on('tray-panel:files-open', () => { getSullaFilesWatcher().openFolder().catch(error => console.warn('[SullaFiles] open folder failed:', error)); panelWindow?.hide() });

  ipcMain.handle('tray-panel:files-dashboard', async() => {
    const [status, files, preferences] = await Promise.all([
      getSullaFilesWatcher().status(),
      getSullaFilesWatcher().recentFiles(4).catch(() => []),
      capturePreferences(),
    ]);
    let shares:any[] = []; let sharingUnavailable = false;

    try { shares = await getSullaFilesLinkService().list() } catch (error) {
      if (error instanceof SharingUnavailableError) sharingUnavailable = true;
      else console.debug('[SullaFiles] recent shares unavailable:', error);
    }

    return { status, files, preferences, shares, sharingUnavailable };
  });

  ipcMain.handle('tray-panel:capture-screenshot', async(_event, mode:ScreenshotMode) => {
    panelWindow?.hide();
    const capture = await getSullaFilesCaptureService().screenshot(mode);

    showCaptureResult(capture);
    return capture;
  });
  ipcMain.handle('tray-panel:capture-record', async(_event, input:{ mic:boolean; camera:boolean }) => {
    panelWindow?.hide();
    const result = await getSullaFilesCaptureService().toggleRecording(input);

    if (result.capture) showCaptureResult(result.capture);
    else if (!result.recording) panelWindow?.show();

    return result;
  });
  ipcMain.handle('tray-panel:capture-upload', async() => {
    panelWindow?.hide();
    try { return await getSullaFilesCaptureService().upload() } finally { panelWindow?.show() }
  });
  ipcMain.handle('tray-panel:share-capture', (_event, capture:CaptureResult, options:{ mode:ShareMode; keepAvailable:boolean }) => getSullaFilesCaptureService().share(capture, options));
  ipcMain.on('files-after-capture:close', () => afterCaptureWindow?.close());
  ipcMain.handle('tray-panel:copy-share', (_event, url:string) => { clipboard.writeText(url) });
  ipcMain.on('tray-panel:set-capture-toggle', (_event, id:string, value:boolean) => {
    const property = id === 'record-cam' ? preferenceKeys.recordCamera : preferenceKeys.recordMic;

    SullaSettingsModel.set(property.property, value, property.cast).catch(error => console.warn('[SullaFiles] capture preference failed:', error));
  });
  ipcMain.on('tray-panel:files-preferences', (_event, tab?:string) => openFilesPreferences(tab));
  ipcMain.on('tray-panel:open-files-screen', (_event, section?:string) => openFilesScreen(section));
  ipcMain.on('tray-panel:resolve-file', (_event, relativePath:string) => {
    openFilesScreen(undefined, relativePath);
    const absolute = path.resolve(getSullaFilesWatcher().folder, relativePath);

    if (absolute.startsWith(`${ getSullaFilesWatcher().folder }${ path.sep }`) && fs.existsSync(absolute)) shell.showItemInFolder(absolute);
  });
  ipcMain.on('tray-panel:open-file', (_event, relativePath:string) => {
    const absolute = path.resolve(getSullaFilesWatcher().folder, relativePath);

    if (!absolute.startsWith(`${ getSullaFilesWatcher().folder }${ path.sep }`)) return;
    shell.openPath(absolute).catch(error => console.warn('[SullaFiles] open file failed:', error));
    panelWindow?.hide();
  });
  ipcMain.on('tray-panel:markup', (_event, filePath:string) => {
    const absolute = path.resolve(filePath);

    if (absolute.startsWith(`${ getSullaFilesWatcher().folder }${ path.sep }`) && absolute.toLowerCase().endsWith('.png')) openScreenshotMarkup(absolute);
  });

  ipcMain.handle('tray-panel:files-preferences-get', () => capturePreferences());
  ipcMain.handle('tray-panel:files-preferences-set', async(_event, key:keyof typeof preferenceKeys, value:unknown) => {
    const setting = preferenceKeys[key];

    if (!setting) throw new Error(`Unknown Sulla Files preference: ${ key }`);
    await SullaSettingsModel.set(setting.property, value, setting.cast);

    return capturePreferences();
  });

  ipcMain.on('tray-panel:open-url', (_event: Electron.IpcMainEvent, url: string) => {
    openUrlInApp(url);
    panelWindow?.hide();
  });

  ipcMain.handle('tray-panel:check-updates', async() => {
    panelWindow?.hide();
    await updateManager.checkForUpdates('manual');
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
