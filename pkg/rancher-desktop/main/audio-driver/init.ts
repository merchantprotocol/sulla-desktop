/**
 * @module audio-driver/init
 *
 * # Audio Driver — Main Entry Point
 *
 * This is the **canonical entry point** for all audio capture in Sulla Desktop.
 * Every microphone and speaker audio stream in the application MUST flow through
 * this driver rather than calling `getUserMedia` directly. Direct `getUserMedia`
 * bypasses VAD, noise filtering, gain control, and gateway streaming — it should
 * only ever be used for raw hardware diagnostics.
 *
 * ## What the audio driver provides
 *
 * - **Microphone capture** with software gain control and mute
 * - **Voice Activity Detection (VAD)** — real-time speaking/silence classification
 *   using amplitude, zero-crossing rate, temporal variance, pitch, and spectral
 *   centroid analyzers fed through hysteresis + frame-counter decision logic
 * - **Noise floor tracking** — adaptive floor that adjusts to ambient conditions
 * - **Feedback loop detection** — flags acoustic feedback before it becomes audible
 * - **Fan noise detection** — identifies steady-state mechanical noise and suppresses
 *   false VAD positives
 * - **Spectral analysis** — frequency-domain features available to any consumer
 * - **Mic socket streaming** — mic audio (WebM/Opus) streams over a Unix domain
 *   socket from the renderer to the main process, avoiding Electron IPC overhead
 * - **Speaker capture** — system audio captured via a BlackHole loopback virtual
 *   device and a CoreAudio Swift helper, streamed as raw s16le PCM
 * - **Gateway streaming** — both mic and speaker channels are multiplexed over a
 *   single WebSocket to the transcription gateway for real-time STT
 * - **Local transcription** — optional whisper.cpp-powered STT that runs entirely
 *   on-device without network access
 * - **Test recording** — a buffer mechanism that captures mic pipeline output so
 *   the user can play it back to verify the pipeline is working end-to-end
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
 *
 * ## Integration (IPC channels)
 *
 * All IPC channels are namespaced under `audio-driver:*`. Renderers interact
 * exclusively through `window.audioDriver` (set up by `bridge.js` in the tray
 * panel preload). Key channels:
 *
 * | Channel                          | Direction        | Purpose                              |
 * |----------------------------------|------------------|--------------------------------------|
 * | `audio-driver:get-state`         | renderer → main  | Query current capture state           |
 * | `audio-driver:start-capture`     | renderer → main  | Begin speaker + mic capture           |
 * | `audio-driver:stop-capture`      | renderer → main  | Stop all capture                      |
 * | `audio-driver:toggle`            | renderer → main  | Toggle capture on/off                 |
 * | `audio-driver:gateway-start`     | renderer → main  | Open a gateway transcription session  |
 * | `audio-driver:gateway-stop`      | renderer → main  | Close the gateway session             |
 * | `audio-driver:mic-vad`           | main → renderer  | Broadcast VAD state to all windows    |
 * | `audio-driver:speaker-level`     | main → renderer  | Real-time speaker RMS/peak levels     |
 * | `audio-driver:state`             | main → renderer  | Broadcast running/message state       |
 * | `audio-driver:auto-start`        | main → renderer  | Signal renderer to begin mic capture  |
 * | `audio-driver:test-record-start` | renderer → main  | Start buffering mic chunks for test   |
 * | `audio-driver:test-record-stop`  | renderer → main  | Stop buffering; returns audio blob    |
 * | `gateway-transcript`             | main → renderer  | Transcript events from gateway or local whisper |
 *
 * ## Why use this instead of direct getUserMedia
 *
 * Calling `getUserMedia` directly in any renderer:
 * 1. Bypasses gain control and mute — the user's volume slider has no effect
 * 2. Bypasses VAD — no speaking/silence events, no noise floor tracking
 * 3. Bypasses feedback and fan noise detection
 * 4. Does not stream to the gateway — no transcription
 * 5. Creates a duplicate mic claim that can conflict with the driver's stream
 *
 * The only legitimate use of raw `getUserMedia` is hardware enumeration and
 * one-off diagnostic recording in a settings/test panel.
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

/**
 * Send a message to every open BrowserWindow (tray panel, main window, etc.).
 * Windows that have already been destroyed are silently skipped.
 *
 * @param channel - The IPC channel name (e.g. `audio-driver:state`)
 * @param data    - Arbitrary payload; must be serializable by Electron's structured clone
 */
function broadcast(channel: string, data: any): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, data);
    }
  }
}

/**
 * Convenience wrapper that broadcasts the capture state on both the legacy
 * `tray-panel:audio-state` channel (for the tray panel UI) and the canonical
 * `audio-driver:state` channel (for all other windows).
 *
 * @param state - Object with `running` (capture active?) and `message` (human-readable status)
 */
function broadcastState(state: { running: boolean; message: string }): void {
  broadcast('tray-panel:audio-state', state);
  broadcast('audio-driver:state', state);
}

// ── Public API ────────────────────────────────────────────────────

let initialized = false;

/**
 * ## Test Recording Buffer
 *
 * When a test recording is active, every mic audio chunk that arrives on the
 * Unix domain socket is copied into {@link testRecordingChunks}. The renderer
 * triggers start/stop via `audio-driver:test-record-start` and
 * `audio-driver:test-record-stop`. On stop, all buffered chunks are concatenated
 * into a single `ArrayBuffer` and returned so the UI can create an `<audio>`
 * element for playback.
 *
 * Auto-stops after {@link TEST_MAX_CHUNKS} chunks (~10 seconds) to prevent
 * unbounded memory growth.
 */
let testRecordingActive = false;
let testRecordingChunks: Buffer[] = [];
const TEST_MAX_CHUNKS = 400; // ~10s at 250ms intervals (40 chunks/s)

/**
 * Initialize the audio driver subsystem.
 *
 * This is called once during app startup (from the main process entry point).
 * It performs three things in order:
 *
 * 1. **Starts the mic Unix socket server** — listens for the renderer to connect
 *    and stream WebM/Opus chunks. Each incoming chunk is forwarded to
 *    `gateway.sendAudio(chunk, 0)` and optionally to the local whisper transcriber.
 * 2. **Registers gateway event listeners** — transcript and status events from the
 *    gateway WebSocket are broadcast to all renderer windows.
 * 3. **Registers all IPC handlers** — exposes the `audio-driver:*` channel API
 *    that renderers use via `window.audioDriver`.
 * 4. **Auto-starts capture** — speaker capture (BlackHole + CoreAudio) begins
 *    immediately; the renderer is signaled via `audio-driver:auto-start` to open
 *    its mic stream.
 *
 * Safe to call multiple times; subsequent calls are no-ops.
 */
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

      // Buffer chunks for test recording when active
      if (testRecordingActive) {
        testRecordingChunks.push(Buffer.from(chunk));
        if (testRecordingChunks.length >= TEST_MAX_CHUNKS) {
          testRecordingActive = false;
          log.info('Init', 'Test recording auto-stopped (max duration)');
          broadcast('audio-driver:test-recording-stopped', { chunkCount: testRecordingChunks.length });
        }
      }
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

  // Auto-start speaker capture on boot (always enabled by default)
  setImmediate(async() => {
    try {
      log.info('Init', 'Auto-starting audio capture on boot');
      await startCapture();
    } catch (e: any) {
      log.error('Init', 'Auto-start failed', { error: e.message });
    }
  });
}

/**
 * Gracefully shut down the audio driver.
 *
 * Tears down the speaker capture helper, disables the CoreAudio aggregate
 * mirror device, stops the mic socket server, and resets audio state.
 *
 * The BlackHole loopback driver itself is **not** removed on shutdown because
 * it lives in `/Library/Audio/Plug-Ins/HAL/` and requires `sudo` to delete,
 * which would prompt for a password the user never sees. The driver persists
 * between sessions and is harmless when idle.
 *
 * Called during `app.on('will-quit')`.
 */
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

/**
 * Register all `audio-driver:*` IPC handlers on `ipcMain`.
 *
 * This wires up the full renderer-facing API surface:
 *
 * - **State queries**: `get-state`, `get-session`, `get-mic-socket-path`,
 *   `get-speaker-socket-path`, `get-auto-launch`
 * - **Capture control**: `start-capture`, `stop-capture`, `toggle`,
 *   `set-device-names`, `set-system-output`, `set-system-input`
 * - **Gateway streaming**: `gateway-start`, `gateway-stop`, `gateway-send`
 * - **Volume control**: `speaker-volume-up`, `speaker-volume-down`,
 *   `speaker-mute-toggle`, `speaker-volume-get`
 * - **Whisper (local STT)**: `whisper-detect`, `whisper-install`,
 *   `whisper-remove`, `whisper-get-status`, `whisper-download-model`,
 *   `whisper-list-models`
 * - **Local transcription**: `transcribe-start`, `transcribe-stop`,
 *   `transcribe-status`
 * - **Test recording**: `test-record-start`, `test-record-stop`
 * - **Call management stubs**: `show-call-notification`,
 *   `open-transcription`, `minimize-transcription`, `restore-transcription`,
 *   `end-call-from-transcription`, `update-call-state`
 * - **Logging relay**: `log` — forwards renderer-side log messages into the
 *   main process logger
 *
 * Must be called exactly once (guarded by {@link initialized}).
 */
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

  // Relay mic VAD from tray panel to all windows (chat, secretary, etc.)
  ipcMain.on('audio-driver:mic-vad-update', (_event: Electron.IpcMainEvent, data: any) => {
    broadcast('audio-driver:mic-vad', data);
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
    log.info('IPC', 'start-capture (both mic + speaker)');
    return await startCapture();
  });

  ipcMain.handle('audio-driver:stop-capture', async() => {
    log.info('IPC', 'stop-capture (both mic + speaker)');
    return await stopCapture();
  });

  // ── Independent mic/speaker lifecycle ──────────────────────────
  //
  // The mic and speaker are separate subsystems. The mic is used
  // constantly (voice chat, dictation). The speaker (BlackHole loopback)
  // is only needed for secretary mode / multi-channel transcription.

  ipcMain.handle('audio-driver:start-mic', async() => {
    log.info('IPC', 'start-mic');
    // Mic capture runs in the tray panel renderer — signal it to start
    broadcast('audio-driver:auto-start', {});
    return { ok: true };
  });

  ipcMain.handle('audio-driver:stop-mic', async() => {
    log.info('IPC', 'stop-mic');
    // Signal the tray panel renderer to stop mic capture
    broadcast('audio-driver:stop-mic', {});
    return { ok: true };
  });

  ipcMain.handle('audio-driver:start-speaker', async() => {
    log.info('IPC', 'start-speaker');
    return await startSpeakerOnly();
  });

  ipcMain.handle('audio-driver:stop-speaker', async() => {
    log.info('IPC', 'stop-speaker');
    return await stopSpeakerOnly();
  });

  // Mic gain/mute forwarding to tray panel renderer
  ipcMain.on('audio-driver:mic-gain', (_event: Electron.IpcMainEvent, value: number) => {
    broadcast('audio-driver:mic-volume', value);
  });

  ipcMain.on('audio-driver:mic-mute', (_event: Electron.IpcMainEvent, muted: boolean) => {
    broadcast('audio-driver:mic-mute', muted);
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

  // ── Test recording (captures from the audio driver mic pipeline) ──

  ipcMain.handle('audio-driver:test-record-start', () => {
    log.info('IPC', 'test-record-start');
    testRecordingChunks = [];
    testRecordingActive = true;
    return { ok: true };
  });

  ipcMain.handle('audio-driver:test-record-stop', () => {
    log.info('IPC', 'test-record-stop', { chunks: testRecordingChunks.length });
    testRecordingActive = false;
    // Combine all chunks into a single WebM/Opus blob and return as ArrayBuffer
    const combined = Buffer.concat(testRecordingChunks);
    const result = { ok: true, audio: combined.buffer.slice(combined.byteOffset, combined.byteOffset + combined.byteLength), chunkCount: testRecordingChunks.length };
    testRecordingChunks = [];
    return result;
  });

  ipcMain.on('audio-driver:log', (_event: Electron.IpcMainEvent, level: string, tag: string, msg: string, data: any) => {
    (rendererLog as any)[level]?.(tag, msg, data);
  });
}

// ── Internal ──────────────────────────────────────────────────────

/**
 * Start the full audio capture pipeline (speaker + mic).
 *
 * Speaker side (main process):
 * 1. Ensures the BlackHole loopback driver is installed
 * 2. Creates or verifies the CoreAudio aggregate mirror device
 * 3. Starts the Swift capture helper, which streams raw s16le PCM via callback
 * 4. Registers macOS volume-key interceptors so volume keys control the
 *    physical speaker even though the system output is set to the aggregate
 *
 * Mic side (renderer):
 * After the speaker pipeline is up, broadcasts `audio-driver:auto-start` to
 * tell the tray panel renderer to call `getUserMedia`, wire up the Web Audio
 * graph (GainNode -> AnalyserNode -> VAD), start the MediaRecorder, and
 * connect to the mic Unix socket.
 *
 * @returns The current audio state object (running, message, device names)
 */
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
  // Tell the tray panel to start mic capture + VAD (if not already running)
  broadcast('audio-driver:auto-start', {});
  log.info('Init', 'Audio capture started', state);
  return state;
}

/**
 * Stop all audio capture (speaker + mic).
 *
 * Sends zero-level speaker data so UI meters reset immediately, then tears
 * down the speaker capture helper and mirror device. The renderer is notified
 * via the state broadcast and should stop its mic stream in response.
 *
 * The BlackHole driver is intentionally left installed (see {@link shutdown}).
 *
 * @returns The updated audio state object (running=false, message='Off')
 */
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

/**
 * Start only the speaker capture pipeline (BlackHole mirror + CoreAudio).
 * Does NOT start the mic — that's controlled independently via `start-mic`.
 */
async function startSpeakerOnly(): Promise<any> {
  log.info('Init', 'Starting speaker capture only');

  await lifecycle.activate({
    onLevel(data: any) {
      broadcast('audio-driver:speaker-level', data);
    },
    onRebuild({ name }: { name: string }) {
      broadcast('audio-driver:speaker-device-changed', name);
    },
  });

  broadcastState({ running: true, message: 'Speaker capturing' });
  log.info('Init', 'Speaker capture started');
  return { ok: true };
}

/**
 * Stop only the speaker capture pipeline.
 * Does NOT stop the mic — it continues running independently.
 */
async function stopSpeakerOnly(): Promise<any> {
  log.info('Init', 'Stopping speaker capture only');

  broadcast('audio-driver:speaker-level', { rms: 0, peak: 0, zcr: 0, variance: 0 });
  await lifecycle.deactivate({ removeDriver: false });

  broadcastState({ running: audio.getState().running, message: audio.getState().running ? 'Mic only' : 'Off' });
  log.info('Init', 'Speaker capture stopped');
  return { ok: true };
}
