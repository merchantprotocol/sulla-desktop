/**
 * @module audio-driver/init
 *
 * # Audio Driver — Main Entry Point
 *
 * Registers all `audio-driver:*` IPC handlers and delegates lifecycle
 * decisions to {@link MicrophoneDriverController} and {@link SpeakerDriverController}.
 * Each controller is the single source of truth for its subsystem's state
 * and uses reference-counted ownership so multiple services can hold a
 * resource open simultaneously.
 *
 * ## Audio flow
 *
 * ```
 * Mic flow (renderer → main → gateway):
 *   getUserMedia → GainNode → AnalyserNode → VAD pipeline
 *     → MediaRecorder (WebM/Opus, 250 ms chunks)
 *     → Unix domain socket (length-prefixed binary)
 *     → main process mic-socket server
 *     → gateway.sendAudio(chunk, channel=0)
 *
 * Speaker flow (CoreAudio → main → gateway):
 *   BlackHole loopback device → CoreAudio Swift capture helper
 *     → raw s16le PCM callback in main process
 *     → gateway.sendAudio(pcmData, channel=1)
 *     → speaker-socket (for external consumers / capture studio)
 * ```
 */

import { ipcMain, BrowserWindow } from 'electron';
import * as lifecycle from './controller/lifecycle';
import { MicrophoneDriverController } from './controller/MicrophoneDriverController';
import { SpeakerDriverController } from './controller/SpeakerDriverController';
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

// ── Public API ────────────────────────────────────────────────────

let initialized = false;

// Test recording is now handled by MicrophoneDriverController
// (PCM-based, supports raw + noise-reduction modes)

/**
 * Initialize the audio driver subsystem.
 * Called once during app startup.
 */
export function initialize(): void {
  if (initialized) {
    log.warn('Init', 'Already initialized — skipping');
    return;
  }
  initialized = true;
  log.info('Init', 'Audio driver initializing within Sulla Desktop');

  // Wire speaker level/device-change callbacks — targeted to holder windows only
  const speaker = SpeakerDriverController.getInstance();
  speaker.setCallbacks({
    onLevel(data: any) {
      speaker.sendToHolders('audio-driver:speaker-level', data);
    },
    onRebuild({ name }: { name: string }) {
      speaker.sendToHolders('audio-driver:speaker-device-changed', name);
    },
  });

  // Subscribe whisper to PCM stream from MicrophoneDriverController
  // PCM chunks are VAD-gated and noise-processed.
  // Audio is at native rate (48kHz). Whisper needs 16kHz — downsample here.
  const mic = MicrophoneDriverController.getInstance();
  mic.onPcmData((pcm: Buffer) => {
    const ratio = Math.round(mic.pcmSampleRate / 16000);
    if (ratio <= 1) {
      whisperTranscribe.feedMic(pcm);
    } else {
      // Downsample by picking every Nth sample
      const inputSamples = pcm.length / 2;
      const outputSamples = Math.floor(inputSamples / ratio);
      const out = Buffer.alloc(outputSamples * 2);
      for (let i = 0; i < outputSamples; i++) {
        out.writeInt16LE(pcm.readInt16LE(i * ratio * 2), i * 2);
      }
      whisperTranscribe.feedMic(out);
    }
  });

  micSocket.start((chunk: Buffer) => {
    if (chunk.length > 0) {
      // WebM/Opus chunks go to gateway (it decodes server-side)
      gateway.sendAudio(chunk, 0);

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

/**
 * Gracefully shut down the audio driver.
 */
export async function shutdown(): Promise<void> {
  log.info('Init', 'Shutting down audio driver');
  await SpeakerDriverController.getInstance().shutdown();
  await MicrophoneDriverController.getInstance().shutdown();
  micSocket.stop();
  log.info('Init', 'Audio driver shut down');
}

// ── IPC Handlers ──────────────────────────────────────────────────

function registerIpcHandlers(): void {
  const mic = MicrophoneDriverController.getInstance();
  const speaker = SpeakerDriverController.getInstance();

  // ── State query ─────────────────────────────────────────────────

  ipcMain.handle('audio-driver:get-state', async() => {
    const mirrorStatus = await mirror.status();
    return {
      micRunning:     mic.running,
      speakerRunning: speaker.running,
      running:        mic.running || speaker.running,
      message:        mic.running || speaker.running ? 'Capturing' : 'Off',
      mirrorActive:   mirrorStatus.exists,
      micName:        mic.micName,
      speakerName:    speaker.speakerName,
      permissions:    lifecycle.checkPermissions(),
    };
  });

  // ── Mic lifecycle (ref-counted) ─────────────────────────────────

  ipcMain.handle('audio-driver:start-mic', async(event: Electron.IpcMainInvokeEvent, serviceId?: string, formats?: string[]) => {
    log.info('IPC', 'start-mic', { serviceId, formats });
    await mic.start(serviceId || 'unknown', event.sender, { formats });
    return { ok: true, micRunning: mic.running, speakerRunning: speaker.running, running: mic.running || speaker.running };
  });

  ipcMain.handle('audio-driver:stop-mic', async(_event: unknown, serviceId?: string) => {
    log.info('IPC', 'stop-mic', { serviceId });
    await mic.stop(serviceId || 'unknown');
    return { ok: true, micRunning: mic.running, speakerRunning: speaker.running, running: mic.running || speaker.running };
  });

  // ── Speaker lifecycle (ref-counted) ─────────────────────────────

  ipcMain.handle('audio-driver:start-speaker', async(event: Electron.IpcMainInvokeEvent, serviceId?: string) => {
    log.info('IPC', 'start-speaker', { serviceId });
    await speaker.start(serviceId || 'unknown', event.sender);
    return { ok: true, micRunning: mic.running, speakerRunning: speaker.running, running: mic.running || speaker.running };
  });

  ipcMain.handle('audio-driver:stop-speaker', async(_event: unknown, serviceId?: string) => {
    log.info('IPC', 'stop-speaker', { serviceId });
    await speaker.stop(serviceId || 'unknown');
    return { ok: true, micRunning: mic.running, speakerRunning: speaker.running, running: mic.running || speaker.running };
  });

  // Backward compat: start-capture = start both, stop-capture = stop both
  ipcMain.handle('audio-driver:start-capture', async(event: Electron.IpcMainInvokeEvent, serviceId?: string) => {
    log.info('IPC', 'start-capture (both mic + speaker)');
    const sid = serviceId || 'legacy-capture';
    await speaker.start(sid, event.sender);
    await mic.start(sid, event.sender);
    return { ok: true, micRunning: mic.running, speakerRunning: speaker.running, running: true };
  });

  ipcMain.handle('audio-driver:stop-capture', async(_event: unknown, serviceId?: string) => {
    log.info('IPC', 'stop-capture (both mic + speaker)');
    const sid = serviceId || 'legacy-capture';
    await mic.stop(sid);
    await speaker.stop(sid);
    return { ok: true, micRunning: mic.running, speakerRunning: speaker.running, running: mic.running || speaker.running };
  });

  ipcMain.on('audio-driver:toggle', async() => {
    log.info('IPC', 'audio-driver:toggle received');
    const running = mic.running || speaker.running;
    if (running) {
      await mic.stop('toggle');
      await speaker.stop('toggle');
    } else {
      await mic.start('toggle');
      await speaker.start('toggle');
    }
  });

  // VAD relay is handled by MicrophoneDriverController._registerVadListener()
  // — it intercepts mic-vad-update, updates its own state, and re-broadcasts.

  // ── Mic gain/mute forwarding to tray panel renderer ─────────────

  ipcMain.on('audio-driver:mic-gain', (_event: Electron.IpcMainEvent, value: number) => {
    broadcast('audio-driver:mic-volume', value);
  });

  ipcMain.on('audio-driver:mic-mute', (_event: Electron.IpcMainEvent, muted: boolean) => {
    broadcast('audio-driver:mic-mute', muted);
  });

  // ── Device selection ────────────────────────────────────────────

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

  // ── Volume control ──────────────────────────────────────────────

  ipcMain.handle('audio-driver:speaker-volume-up', () => speaker.volumeUp());
  ipcMain.handle('audio-driver:speaker-volume-down', () => speaker.volumeDown());
  ipcMain.handle('audio-driver:speaker-mute-toggle', () => speaker.muteToggle());
  ipcMain.handle('audio-driver:speaker-volume-get', () => speaker.volumeGet());

  speaker.setOnVolumeChanged((state: any) => {
    speaker.sendToHolders('audio-driver:volume-changed', state);
  });

  // ── Gateway streaming ───────────────────────────────────────────

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

  // ── Socket paths ────────────────────────────────────────────────

  ipcMain.handle('audio-driver:get-mic-socket-path', () => micSocket.getPath());
  ipcMain.handle('audio-driver:get-speaker-socket-path', () => speakerSocket.getPath());

  // ── Auto-launch ─────────────────────────────────────────────────

  ipcMain.handle('audio-driver:get-auto-launch', () => {
    const { app } = require('electron') as typeof import('electron');
    return app.getLoginItemSettings().openAtLogin;
  });

  ipcMain.handle('audio-driver:set-auto-launch', (_event: unknown, enabled: boolean) => {
    const { app } = require('electron') as typeof import('electron');
    app.setLoginItemSettings({ openAtLogin: enabled });
    return enabled;
  });

  // ── Session stub ────────────────────────────────────────────────

  ipcMain.handle('audio-driver:get-session', () => {
    return { loggedIn: true, user: { name: 'User' }, teams: [], activeTeamId: null };
  });

  // ── Call notification / transcription stubs ──────────────────────

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

  // ── Whisper.cpp (local STT engine) ──────────────────────────────

  ipcMain.handle('audio-driver:whisper-detect', async() => {
    log.info('IPC', 'whisper-detect');
    return await whisper.detect();
  });

  ipcMain.handle('audio-driver:whisper-install', async() => {
    log.info('IPC', 'whisper-install');
    broadcast('audio-driver:whisper-progress', { phase: 'install', status: 'Installing whisper.cpp via Homebrew...', pct: 0 });
    const ok = await whisper.install((line: string) => {
      broadcast('audio-driver:whisper-progress', { phase: 'install', status: line, pct: -1 });
    });
    if (ok) {
      const status = await whisper.detect();
      broadcast('audio-driver:whisper-status', status);
      broadcast('audio-driver:whisper-progress', { phase: 'install', status: 'Installed successfully', pct: 100 });
    } else {
      broadcast('audio-driver:whisper-progress', { phase: 'install', status: 'Installation failed', pct: -1, error: true });
    }
    return { ok };
  });

  ipcMain.handle('audio-driver:whisper-remove', async() => {
    log.info('IPC', 'whisper-remove');
    broadcast('audio-driver:whisper-progress', { phase: 'uninstall', status: 'Uninstalling whisper.cpp...', pct: 0 });
    await whisper.remove((line: string) => {
      broadcast('audio-driver:whisper-progress', { phase: 'uninstall', status: line, pct: -1 });
    });
    const status = await whisper.detect();
    broadcast('audio-driver:whisper-status', status);
    broadcast('audio-driver:whisper-progress', { phase: 'uninstall', status: 'Uninstalled', pct: 100 });
    return { ok: true };
  });

  ipcMain.handle('audio-driver:whisper-get-status', () => {
    return whisper.getStatus();
  });

  ipcMain.handle('audio-driver:whisper-download-model', async(_event: unknown, model: string) => {
    log.info('IPC', 'whisper-download-model', { model });
    broadcast('audio-driver:whisper-progress', { phase: 'download', status: `Downloading model: ${ model }...`, pct: 0, model });
    const ok = await whisper.downloadModel(model, (pct: number, status: string) => {
      broadcast('audio-driver:whisper-progress', { phase: 'download', status, pct, model });
    });
    if (ok) {
      const status = await whisper.detect();
      broadcast('audio-driver:whisper-status', status);
      broadcast('audio-driver:whisper-progress', { phase: 'download', status: 'Download complete', pct: 100, model });
    } else {
      broadcast('audio-driver:whisper-progress', { phase: 'download', status: 'Download failed', pct: -1, model, error: true });
    }
    return { ok };
  });

  ipcMain.handle('audio-driver:whisper-list-models', () => {
    return whisper.getModels();
  });

  // ── Local transcription (whisper.cpp powered) ───────────────────

  ipcMain.handle('audio-driver:transcribe-start', async(_event: unknown, opts: {
    mode: 'conversation' | 'secretary';
    language?: string;
    model?: string;
  }) => {
    log.info('IPC', 'transcribe-start', opts);

    if (!whisper.isAvailable()) {
      await whisper.detect();
    }

    const ok = whisperTranscribe.start({
      mode:         opts.mode,
      language:     opts.language,
      model:        opts.model,
      onTranscript: (event) => {
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
    return whisperTranscribe.getStats();
  });

  // ── Test recording ──────────────────────────────────────────────

  ipcMain.handle('audio-driver:test-record-start', (_event: unknown, mode?: string) => {
    log.info('IPC', 'test-record-start', { mode });
    mic.startTestRecording((mode as any) || 'raw');
    return { ok: true, mode: mode || 'raw' };
  });

  ipcMain.handle('audio-driver:test-record-stop', () => {
    log.info('IPC', 'test-record-stop');
    const result = mic.stopTestRecording();
    return { ok: true, ...result };
  });

  // ── Logging relay ───────────────────────────────────────────────

  ipcMain.on('audio-driver:log', (_event: Electron.IpcMainEvent, level: string, tag: string, msg: string, data: any) => {
    (rendererLog as any)[level]?.(tag, msg, data);
  });
}
