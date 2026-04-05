/**
 * Audio Driver initialization for Sulla Desktop.
 *
 * Bridges the audio-driver lifecycle, IPC handlers, and gateway service
 * into sulla-desktop's main process.
 */

import { ipcMain, BrowserWindow } from 'electron';
import * as lifecycle from './controller/lifecycle';
import * as audio from './model/audio';
import * as mirror from './model/mirror';
import * as gateway from './service/gateway';
import * as micSocket from './service/mic-socket';
import { log, createLogger } from './model/logger';

const rendererLog = createLogger('renderer');

let mainWindow: BrowserWindow | null = null;
let speakerLevelInterval: ReturnType<typeof setInterval> | null = null;
let lastSpeakerData: any = { rms: 0, peak: 0, zcr: 0, variance: 0 };

// ── Broadcast to all windows ──────────────────────────────────────

function broadcastState(state: { running: boolean; message: string }): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('tray-panel:audio-state', state);
      win.webContents.send('audio-driver:state', state);
    }
  }
}

// ── Public API ────────────────────────────────────────────────────

export function initialize(win: BrowserWindow): void {
  mainWindow = win;
  log.info('Init', 'Audio driver initializing within Sulla Desktop');

  micSocket.start((chunk: Buffer) => {
    if (chunk.length > 0) {
      gateway.sendAudio(chunk, 0);
    }
  });

  gateway.onTranscriptEvent((msg: any) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('gateway-transcript', msg);
    }
  });

  gateway.onStatus((status: any) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('gateway-status', status);
    }
  });

  registerIpcHandlers();
  log.info('Init', 'Audio driver initialized');
}

export async function shutdown(): Promise<void> {
  log.info('Init', 'Shutting down audio driver');
  if (speakerLevelInterval) {
    clearInterval(speakerLevelInterval);
    speakerLevelInterval = null;
  }
  await lifecycle.deactivate({ removeDriver: true });
  micSocket.stop();
  log.info('Init', 'Audio driver shut down');
}

// ── IPC Handlers ──────────────────────────────────────────────────

function registerIpcHandlers(): void {

  ipcMain.handle('audio-driver:get-state', async() => {
    const state = audio.getState();
    const mirrorStatus = await mirror.status();
    return { ...state, mirrorActive: mirrorStatus.exists, permissions: lifecycle.checkPermissions() };
  });

  ipcMain.on('audio-driver:toggle', async() => {
    const state = audio.getState();
    if (state.running) {
      broadcastState({ running: true, message: 'Disabling...' });
      await stopCapture();
    } else {
      broadcastState({ running: false, message: 'Enabling...' });
      await startCapture();
    }
  });

  ipcMain.on('tray-panel:audio-toggle', async(_event: Electron.IpcMainEvent, enabled: boolean) => {
    if (enabled) {
      broadcastState({ running: false, message: 'Enabling...' });
      await startCapture();
    } else {
      broadcastState({ running: true, message: 'Disabling...' });
      await stopCapture();
    }
  });

  ipcMain.on('tray-panel:audio-mic-device', async(_event: Electron.IpcMainEvent, deviceId: string) => {
    log.info('IPC', 'mic device changed', { deviceId });
    const platform = await import('./platform');
    await platform.devices.setInput(deviceId);
  });

  ipcMain.on('tray-panel:audio-speaker-device', async(_event: Electron.IpcMainEvent, deviceId: string) => {
    log.info('IPC', 'speaker device changed', { deviceId });
    const platform = await import('./platform');
    await platform.devices.setOutput(deviceId);
  });

  ipcMain.on('tray-panel:audio-mic-mute', (_event: Electron.IpcMainEvent, muted: boolean) => {
    log.info('IPC', 'mic mute', { muted });
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('audio-driver:mic-mute', muted);
    }
  });

  ipcMain.on('tray-panel:audio-mic-volume', (_event: Electron.IpcMainEvent, vol: number) => {
    log.info('IPC', 'mic volume', { vol });
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('audio-driver:mic-volume', vol);
    }
  });

  ipcMain.on('tray-panel:audio-speaker-mute', async(_event: Electron.IpcMainEvent, _muted: boolean) => {
    await lifecycle.speakerMuteToggle();
  });

  ipcMain.on('tray-panel:audio-speaker-volume', (_event: Electron.IpcMainEvent, _vol: number) => {
    // Volume controlled via physical device
  });

  ipcMain.handle('audio-driver:gateway-start', async(_event: unknown, callData: any) => {
    log.info('IPC', 'gateway-start-session', { callId: callData?.callId });
    try {
      const result = await gateway.startSession({
        callerName: callData?.userName || 'Sulla Desktop',
        channels:   callData?.channels || {
          '0': { label: callData?.userName || 'User', source: 'mic' },
          '1': { label: 'Caller', source: 'system_audio', audioFormat: { inputFormat: 's16le', inputRate: 16000, inputChannels: 1 } },
        },
      });
      return { ok: true, ...result };
    } catch (e: any) {
      log.error('IPC', 'gateway-start-session failed', { error: e.message });
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('audio-driver:gateway-stop', async() => {
    await gateway.stopSession();
    return { ok: true };
  });

  ipcMain.handle('audio-driver:gateway-send', async(_event: unknown, { audio: audioData, channel }: { audio: ArrayBuffer; channel: number }) => {
    if (audioData && audioData.byteLength > 0) {
      gateway.sendAudio(Buffer.from(audioData), channel || 0);
    }
    return { ok: true };
  });

  ipcMain.handle('gateway-transcript-subscribe', () => ({ ok: true }));

  ipcMain.handle('audio-driver:get-mic-socket-path', () => micSocket.getPath());

  ipcMain.handle('audio-driver:speaker-volume-up', () => lifecycle.speakerVolumeUp());
  ipcMain.handle('audio-driver:speaker-volume-down', () => lifecycle.speakerVolumeDown());
  ipcMain.handle('audio-driver:speaker-mute-toggle', () => lifecycle.speakerMuteToggle());
  ipcMain.handle('audio-driver:speaker-volume-get', () => lifecycle.speakerVolumeGet());

  lifecycle.setOnVolumeChanged((state: any) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('audio-driver:volume-changed', state);
    }
  });

  ipcMain.on('audio-driver:log', (_event: Electron.IpcMainEvent, level: string, tag: string, msg: string, data: any) => {
    (rendererLog as any)[level]?.(tag, msg, data);
  });
}

// ── Internal ──────────────────────────────────────────────────────

async function startCapture(): Promise<any> {
  log.info('Init', 'Starting audio capture');

  const result = await lifecycle.activate({
    onLevel: (data: any) => { lastSpeakerData = data; },
    onRebuild: ({ name }: { name: string }) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('audio-driver:speaker-device-changed', name);
      }
    },
  });

  if (speakerLevelInterval) clearInterval(speakerLevelInterval);
  speakerLevelInterval = setInterval(() => {
    const rms = lastSpeakerData.rms || 0;
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('tray-panel:audio-speaker-level', rms);
        win.webContents.send('audio-driver:speaker-level', lastSpeakerData);
      }
    }
  }, 33);

  const state = audio.start();
  broadcastState({ running: true, message: 'Capturing' });
  log.info('Init', 'Audio capture started', state);
  return state;
}

async function stopCapture(): Promise<any> {
  log.info('Init', 'Stopping audio capture');

  lastSpeakerData = { rms: 0, peak: 0, zcr: 0, variance: 0 };
  if (speakerLevelInterval) {
    clearInterval(speakerLevelInterval);
    speakerLevelInterval = null;
  }

  await lifecycle.deactivate({ removeDriver: false });
  const state = audio.stop();
  broadcastState({ running: false, message: 'Off' });
  log.info('Init', 'Audio capture stopped', state);
  return state;
}
