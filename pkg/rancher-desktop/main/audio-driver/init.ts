/**
 * Audio Driver initialization for Sulla Desktop.
 *
 * Bridges the audio-driver lifecycle, IPC handlers, and gateway service
 * into sulla-desktop's main process. All communication uses IPC between
 * the main process and renderer windows (tray panel, main window, etc.)
 * via BrowserWindow.getAllWindows() — no specific window reference needed.
 */

import { ipcMain, BrowserWindow } from 'electron';
import * as lifecycle from './controller/lifecycle';
import * as audio from './model/audio';
import * as mirror from './model/mirror';
import * as whisper from './model/whisper';
import * as gateway from './service/gateway';
import * as speakerSocket from './service/speaker-socket';
import * as micSocket from './service/mic-socket';
import * as whisperTranscribe from './service/whisper-transcribe';
import { log, createLogger } from './model/logger';

const rendererLog = createLogger('renderer');


// ── Broadcast to all renderer windows ─────────────────────────────

function broadcast(channel: string, data: any): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, data);
    }
  }
}

function broadcastState(state: { running: boolean; message: string }): void {
  broadcast('tray-panel:audio-state', state);
  broadcast('audio-driver:state', state);
}

// ── Public API ────────────────────────────────────────────────────

let initialized = false;

export function initialize(): void {
  if (initialized) {
    log.warn('Init', 'Already initialized — skipping');
    return;
  }
  initialized = true;
  log.info('Init', 'Audio driver initializing within Sulla Desktop');

  micSocket.start((chunk: Buffer) => {
    if (chunk.length > 0) {
      gateway.sendAudio(chunk, 0);
      // Feed mic audio to local whisper transcription if active
      whisperTranscribe.feedMic(chunk);
    }
  });

  gateway.onTranscriptEvent((msg: any) => {
    broadcast('gateway-transcript', msg);
  });

  gateway.onStatus((status: any) => {
    broadcast('gateway-status', status);
  });

  registerIpcHandlers();
  log.info('Init', 'Audio driver initialized — IPC handlers registered');
  console.log('[Audio Driver] IPC handlers registered');
}

export async function shutdown(): Promise<void> {
  log.info('Init', 'Shutting down audio driver');
  // Don't remove the loopback driver on shutdown — it lives in /Library/ and
  // requires sudo to delete, which would prompt for a password the user never
  // sees.  The driver stays installed between sessions; only the mirror and
  // capture are torn down.
  await lifecycle.deactivate({ removeDriver: false });
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
    log.info('IPC', 'audio-driver:toggle received');
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
    log.info('IPC', 'tray-panel:audio-toggle received', { enabled });
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
    broadcast('audio-driver:mic-mute', muted);
  });

  ipcMain.on('tray-panel:audio-mic-volume', (_event: Electron.IpcMainEvent, vol: number) => {
    log.info('IPC', 'mic volume', { vol });
    broadcast('audio-driver:mic-volume', vol);
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

  // gateway-transcript-subscribe is already registered in sullaEvents.ts

  ipcMain.handle('audio-driver:get-mic-socket-path', () => micSocket.getPath());
  ipcMain.handle('audio-driver:get-speaker-socket-path', () => speakerSocket.getPath());

  ipcMain.handle('audio-driver:speaker-volume-up', () => lifecycle.speakerVolumeUp());
  ipcMain.handle('audio-driver:speaker-volume-down', () => lifecycle.speakerVolumeDown());
  ipcMain.handle('audio-driver:speaker-mute-toggle', () => lifecycle.speakerMuteToggle());
  ipcMain.handle('audio-driver:speaker-volume-get', () => lifecycle.speakerVolumeGet());

  lifecycle.setOnVolumeChanged((state: any) => {
    broadcast('audio-driver:volume-changed', state);
  });

  // ── Handlers called by the renderer controller via bridge.js ──────

  ipcMain.handle('audio-driver:start-capture', async() => {
    log.info('IPC', 'start-capture');
    return await startCapture();
  });

  ipcMain.handle('audio-driver:stop-capture', async() => {
    log.info('IPC', 'stop-capture');
    return await stopCapture();
  });

  ipcMain.handle('audio-driver:set-device-names', (_event: unknown, mic: string, speaker: string) => {
    log.info('IPC', 'set-device-names', { mic, speaker });
    audio.setDeviceNames(mic, speaker);
  });

  ipcMain.handle('audio-driver:set-system-output', async(_event: unknown, deviceName: string) => {
    log.info('IPC', 'set-system-output', { deviceName });
    const platform = await import('./platform');
    return platform.devices.setOutput(deviceName);
  });

  ipcMain.handle('audio-driver:set-system-input', async(_event: unknown, deviceName: string) => {
    log.info('IPC', 'set-system-input', { deviceName });
    const platform = await import('./platform');
    return platform.devices.setInput(deviceName);
  });

  ipcMain.handle('audio-driver:get-auto-launch', () => {
    const { app } = require('electron') as typeof import('electron');
    return app.getLoginItemSettings().openAtLogin;
  });

  ipcMain.handle('audio-driver:set-auto-launch', (_event: unknown, enabled: boolean) => {
    const { app } = require('electron') as typeof import('electron');
    app.setLoginItemSettings({ openAtLogin: enabled });
    return enabled;
  });

  ipcMain.handle('audio-driver:get-session', () => {
    // sulla-desktop handles auth — always return logged in
    return { loggedIn: true, user: { name: 'User' }, teams: [], activeTeamId: null };
  });

  // Call notification / transcription stubs — full implementation in future phase
  ipcMain.handle('audio-driver:show-call-notification', () => {
    log.info('IPC', 'show-call-notification (stub)');
    return { ok: true };
  });

  ipcMain.handle('audio-driver:open-transcription', (_event: unknown, _sessionId: string) => {
    log.info('IPC', 'open-transcription (stub)');
    return { ok: true };
  });

  ipcMain.handle('audio-driver:minimize-transcription', () => ({ ok: true }));
  ipcMain.handle('audio-driver:restore-transcription', () => ({ ok: true }));

  ipcMain.on('audio-driver:end-call-from-transcription', () => {
    log.info('IPC', 'end-call-from-transcription');
    broadcast('audio-driver:end-call', {});
  });

  ipcMain.on('audio-driver:update-call-state', (_event: Electron.IpcMainEvent, state: any) => {
    broadcast('audio-driver:call-state', state);
  });

  // ── Whisper.cpp (local STT engine) ─────────────────────────────

  ipcMain.handle('audio-driver:whisper-detect', async() => {
    log.info('IPC', 'whisper-detect');
    return await whisper.detect();
  });

  ipcMain.handle('audio-driver:whisper-install', async() => {
    log.info('IPC', 'whisper-install');
    broadcastState({ running: audio.getState().running, message: 'Installing whisper.cpp...' });
    const ok = await whisper.install();
    if (ok) {
      const status = await whisper.detect();
      broadcast('audio-driver:whisper-status', status);
      broadcastState({ running: audio.getState().running, message: audio.getState().running ? 'Capturing' : 'Off' });
    } else {
      broadcastState({ running: audio.getState().running, message: 'whisper.cpp install failed' });
    }
    return { ok };
  });

  ipcMain.handle('audio-driver:whisper-remove', async() => {
    log.info('IPC', 'whisper-remove');
    await whisper.remove();
    const status = await whisper.detect();
    broadcast('audio-driver:whisper-status', status);
    return { ok: true };
  });

  ipcMain.handle('audio-driver:whisper-get-status', () => {
    return whisper.getStatus();
  });

  ipcMain.handle('audio-driver:whisper-download-model', async(_event: unknown, model: string) => {
    log.info('IPC', 'whisper-download-model', { model });
    broadcastState({ running: audio.getState().running, message: `Downloading model: ${ model }...` });
    const ok = await whisper.downloadModel(model);
    if (ok) {
      const status = await whisper.detect();
      broadcast('audio-driver:whisper-status', status);
    }
    broadcastState({ running: audio.getState().running, message: audio.getState().running ? 'Capturing' : 'Off' });
    return { ok };
  });

  ipcMain.handle('audio-driver:whisper-list-models', () => {
    return whisper.getModels();
  });

  // ── Local transcription (whisper.cpp powered) ─────────────────

  ipcMain.handle('audio-driver:transcribe-start', async(_event: unknown, opts: {
    mode: 'conversation' | 'secretary';
    language?: string;
    model?: string;
  }) => {
    log.info('IPC', 'transcribe-start', opts);

    // Detect whisper if not yet cached
    if (!whisper.isAvailable()) {
      await whisper.detect();
    }

    const ok = whisperTranscribe.start({
      mode:         opts.mode,
      language:     opts.language,
      model:        opts.model,
      onTranscript: (event) => {
        // Emit on the same channel the gateway uses so existing UI code works
        broadcast('gateway-transcript', event);
      },
    });

    return { ok };
  });

  ipcMain.handle('audio-driver:transcribe-stop', () => {
    log.info('IPC', 'transcribe-stop');
    whisperTranscribe.stop();
    return { ok: true };
  });

  ipcMain.handle('audio-driver:transcribe-status', () => {
    return {
      active: whisperTranscribe.isActive(),
      mode:   whisperTranscribe.getMode(),
    };
  });

  ipcMain.on('audio-driver:log', (_event: Electron.IpcMainEvent, level: string, tag: string, msg: string, data: any) => {
    (rendererLog as any)[level]?.(tag, msg, data);
  });
}

// ── Internal ──────────────────────────────────────────────────────

async function startCapture(): Promise<any> {
  log.info('Init', 'Starting audio capture');

  const result = await lifecycle.activate({
    onLevel: (data: any) => {
      // Send speaker data to renderers only when the capture helper produces new data.
      // No polling interval — this callback fires at the Swift helper's native rate.
      broadcast('audio-driver:speaker-level', data);
    },
    onRebuild: ({ name }: { name: string }) => {
      broadcast('audio-driver:speaker-device-changed', name);
    },
  });

  const state = audio.start();
  broadcastState({ running: true, message: 'Capturing' });
  log.info('Init', 'Audio capture started', state);
  return state;
}

async function stopCapture(): Promise<any> {
  log.info('Init', 'Stopping audio capture');

  // Send zero levels so meters reset immediately
  broadcast('audio-driver:speaker-level', { rms: 0, peak: 0, zcr: 0, variance: 0 });

  await lifecycle.deactivate({ removeDriver: false });
  const state = audio.stop();
  broadcastState({ running: false, message: 'Off' });
  log.info('Init', 'Audio capture stopped', state);
  return state;
}
