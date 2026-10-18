/**
 * Tray Panel — popover BrowserWindow that behaves like a native menu bar dropdown.
 *
 * Architecture mirrors sulla/audio-driver: frameless, transparent window
 * positioned below the tray icon, dismissed on blur.
 */

import fs from 'node:fs';
import path from 'node:path';

import { BrowserWindow, ipcMain, app, clipboard, globalShortcut, screen, shell } from 'electron';

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

function isTrustedTrayRenderer(event:Electron.IpcMainEvent | Electron.IpcMainInvokeEvent):boolean {
  return [panelWindow, preferencesWindow, afterCaptureWindow]
    .some(window => window && !window.isDestroyed() && window.webContents.id === event.sender.id);
}

function requireTrayRenderer(event:Electron.IpcMainEvent | Electron.IpcMainInvokeEvent):void {
  if (!isTrustedTrayRenderer(event)) throw new Error('Files tray actions are only available to Sulla tray windows');
}

async function resolveFilesItem(candidate:string, relative:boolean):Promise<{ absolute: string; relativePath: string; size: number }> {
  if (typeof candidate !== 'string' || !candidate) throw new Error('A Files path is required');
  const root = await fs.promises.realpath(getSullaFilesWatcher().folder);
  const requested = relative ? path.resolve(root, candidate) : path.resolve(candidate);
  if (requested === root || !requested.startsWith(`${ root }${ path.sep }`)) throw new Error('The requested item is outside Sulla Files');
  const absolute = await fs.promises.realpath(requested);
  if (!absolute.startsWith(`${ root }${ path.sep }`)) throw new Error('The requested item resolves outside Sulla Files');
  const info = await fs.promises.stat(absolute);

  return { absolute, relativePath: path.relative(root, absolute).split(path.sep).join('/'), size: info.size };
}

async function trustedCapture(input:CaptureResult):Promise<CaptureResult> {
  const item = await resolveFilesItem(input.relativePath, true);
  const indexed = await getSullaFilesWatcher().findFile(item.relativePath);
  const kind = ['screenshot', 'recording', 'upload'].includes(input.kind) ? input.kind : 'upload';

  return { path: item.absolute, relativePath: item.relativePath, name: path.basename(item.absolute), size: item.size, kind, fileId: indexed?.id };
}

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
  // 360px card from the mockup plus a 12px margin for its shadow, top-right like a capture toast.
  const workArea = screen.getPrimaryDisplay().workArea;
  afterCaptureWindow = new BrowserWindow({
    width: 384, height: 307, x: workArea.x + workArea.width - 384 - 8, y: workArea.y + 8,
    show: false, frame: false, transparent: true, hasShadow: false, resizable: false, alwaysOnTop: true, skipTaskbar: true,
    title: 'Sulla Files — Capture',
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
  // 410px wide like the mockup; on macOS the drawn 38px title bar hosts the real traffic lights.
  const mac = process.platform === 'darwin';
  preferencesWindow = new BrowserWindow({
    width: 410, height: mac ? 574 : 536, resizable: false, maximizable: false, fullscreenable: false, show: false,
    title: 'Sulla Files — Preferences', backgroundColor: '#fafbfc',
    ...(mac ? { titleBarStyle: 'hidden' as const, trafficLightPosition: { x: 14, y: 13 } } : {}),
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

/**
 * Fit the panel to the active view. Existing views keep the original 400x480;
 * the Files view sizes to its content. The panel stays centred under the tray.
 */
function resizePanelForView(view:string, size?:{ width:number; height:number }):void {
  if (!panelWindow || panelWindow.isDestroyed()) return;
  const bounds = panelWindow.getBounds();
  const workArea = screen.getDisplayMatching(bounds).workArea;
  const width = view === 'files' && size ? Math.round(size.width) : 400;
  const height = view === 'files' && size ? Math.min(Math.round(size.height), workArea.y + workArea.height - bounds.y) : 480;

  panelWindow.setBounds({ x: Math.round(bounds.x + (bounds.width - width) / 2), y: bounds.y, width, height }, false);
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

  ipcMain.handle('tray-panel:files-status', (event) => { requireTrayRenderer(event); return getSullaFilesWatcher().status() });
  ipcMain.handle('tray-panel:files-pause', (event, paused:boolean) => { requireTrayRenderer(event); return getSullaFilesWatcher().setPaused(paused === true) });
  ipcMain.handle('tray-panel:files-pause-hour', (event) => { requireTrayRenderer(event); return getSullaFilesWatcher().pauseFor(60 * 60_000) });
  ipcMain.on('tray-panel:view-change', (_event, view:string, size?:{ width:number; height:number }) => resizePanelForView(view, size));
  ipcMain.handle('tray-panel:files-open', async(event) => {
    requireTrayRenderer(event);
    await getSullaFilesWatcher().openFolder();
    panelWindow?.hide();
  });

  ipcMain.handle('tray-panel:files-dashboard', async(event) => {
    requireTrayRenderer(event);
    const [status, files, preferences] = await Promise.all([
      getSullaFilesWatcher().status(),
      getSullaFilesWatcher().recentFiles(4),
      capturePreferences(),
    ]);
    let shares:any[] = []; let sharingUnavailable = false;

    try { shares = await getSullaFilesLinkService().list() } catch (error) {
      if (error instanceof SharingUnavailableError) sharingUnavailable = true;
      else throw error;
    }

    return { status, files, preferences, shares, sharingUnavailable };
  });

  ipcMain.handle('tray-panel:capture-screenshot', async(event, mode:ScreenshotMode) => {
    requireTrayRenderer(event);
    if (!['area', 'window', 'full'].includes(mode)) throw new Error('Unknown screenshot mode');
    panelWindow?.hide();
    try {
      const capture = await getSullaFilesCaptureService().screenshot(mode);

      showCaptureResult(capture);
      return capture;
    } catch (error) {
      panelWindow?.show();
      throw error;
    }
  });
  ipcMain.handle('tray-panel:capture-record', async(event, input:{ mic:boolean; camera:boolean }) => {
    requireTrayRenderer(event);
    panelWindow?.hide();
    const result = await getSullaFilesCaptureService().toggleRecording(input);

    if (result.capture) showCaptureResult(result.capture);
    else if (!result.recording) panelWindow?.show();

    return result;
  });
  ipcMain.handle('tray-panel:capture-upload', async(event) => {
    requireTrayRenderer(event);
    panelWindow?.hide();
    try { return await getSullaFilesCaptureService().upload() } finally { panelWindow?.show() }
  });
  ipcMain.handle('tray-panel:share-capture', async(event, capture:CaptureResult, options:{ mode:ShareMode; keepAvailable:boolean }) => {
    requireTrayRenderer(event);
    if (!options || !['view', 'download'].includes(options.mode)) throw new Error('Unknown share mode');
    return getSullaFilesCaptureService().share(await trustedCapture(capture), { mode: options.mode, keepAvailable: options.keepAvailable === true });
  });
  ipcMain.on('files-after-capture:close', (event) => { if (!isTrustedTrayRenderer(event)) return; afterCaptureWindow?.close() });
  ipcMain.on('files-after-capture:resize', (event, height:number) => {
    if (!isTrustedTrayRenderer(event)) return;
    if (afterCaptureWindow && !afterCaptureWindow.isDestroyed() && height > 0) afterCaptureWindow.setContentSize(384, Math.min(Math.round(height), 600));
  });
  ipcMain.handle('tray-panel:copy-share', (event, url:string) => {
    requireTrayRenderer(event);
    const parsed = new URL(url);
    if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('Only web share links can be copied');
    clipboard.writeText(parsed.toString());
  });
  ipcMain.on('tray-panel:set-capture-toggle', (event, id:string, value:boolean) => {
    if (!isTrustedTrayRenderer(event)) return;
    const property = id === 'record-cam' ? preferenceKeys.recordCamera : preferenceKeys.recordMic;

    SullaSettingsModel.set(property.property, value, property.cast).catch(error => console.warn('[SullaFiles] capture preference failed:', error));
  });
  ipcMain.on('tray-panel:files-preferences', (event, tab?:string) => { if (!isTrustedTrayRenderer(event)) return; openFilesPreferences(tab) });
  ipcMain.on('tray-panel:open-files-screen', (event, section?:string) => { if (!isTrustedTrayRenderer(event)) return; openFilesScreen(section) });
  ipcMain.handle('tray-panel:resolve-file', async(event, relativePath:string) => {
    requireTrayRenderer(event);
    const item = await resolveFilesItem(relativePath, true);
    openFilesScreen(undefined, relativePath);
    shell.showItemInFolder(item.absolute);
  });
  ipcMain.handle('tray-panel:open-file', async(event, relativePath:string) => {
    requireTrayRenderer(event);
    const item = await resolveFilesItem(relativePath, true);
    const error = await shell.openPath(item.absolute);
    if (error) throw new Error(error);
    panelWindow?.hide();
  });
  ipcMain.handle('tray-panel:markup', async(event, filePath:string) => {
    requireTrayRenderer(event);
    const item = await resolveFilesItem(filePath, false);
    if (!item.absolute.toLowerCase().endsWith('.png')) throw new Error('Only PNG captures can be marked up');
    openScreenshotMarkup(item.absolute);
  });

  ipcMain.handle('tray-panel:files-preferences-get', (event) => { requireTrayRenderer(event); return capturePreferences() });
  ipcMain.handle('tray-panel:files-preferences-set', async(event, key:keyof typeof preferenceKeys, value:unknown) => {
    requireTrayRenderer(event);
    const setting = preferenceKeys[key];

    if (!setting) throw new Error(`Unknown Sulla Files preference: ${ key }`);
    await SullaSettingsModel.set(setting.property, value, setting.cast);

    return capturePreferences();
  });

  ipcMain.on('tray-panel:open-url', (event: Electron.IpcMainEvent, url: string) => {
    if (!isTrustedTrayRenderer(event)) return;
    let parsed:URL;
    try { parsed = new URL(url) } catch { return }
    if (!['https:', 'http:'].includes(parsed.protocol)) return;
    openUrlInApp(parsed.toString());
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
