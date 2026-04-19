/**
 * @module audio-driver/controller/MicrophoneDriverController
 *
 * # MicrophoneDriverController — Main-Process Owner of Mic State
 *
 * Owns the **full microphone state** including the audio driver's VAD
 * processing pipeline. The actual getUserMedia + Web Audio graph + VAD
 * analyzers run in the tray panel renderer (browser API requirement), but
 * this controller is the authoritative source for all mic state:
 *
 * - **Lifecycle**: running, holders (ref-counted)
 * - **Voice Activity**: speaking, fan noise, noise floor
 * - **Signal Analysis**: level, zero-crossing rate, temporal variance,
 *   pitch, spectral centroid
 * - **Feedback Detection**: (reported by renderer)
 *
 * ## How it works with the audio driver
 *
 * The tray panel renderer runs the audio driver's mic pipeline:
 *   getUserMedia → GainNode → AnalyserNode → VAD (amplitude, ZCR,
 *   temporal variance, pitch, spectral) → feedback detection
 *
 * Every analysis frame (~60fps), the renderer broadcasts mic-vad-update
 * to the main process. This controller intercepts that data, updates its
 * own state, and re-broadcasts to all windows. No other code path should
 * relay mic VAD data — this controller is the single point of truth.
 *
 * ## Reference-counted lifecycle
 *
 * Multiple services can hold the mic open simultaneously.
 * `start(serviceId)` / `stop(serviceId)` add/remove the service from a Set.
 * Hardware only starts when the set goes 0 → 1, stops when 1 → 0.
 *
 * Service IDs: `'audio-settings-test'`, `'call-session'`, `'secretary-mode'`,
 * `'dictation'`, `'whisper-test'`, etc.
 */

import { BrowserWindow, ipcMain, type WebContents } from 'electron';

import { AudioNoiseProcessor } from './AudioNoiseProcessor';
import * as audio from '../model/audio';
import { log } from '../model/logger';

// ── Singleton ───────────────────────────────────────────────────

let instance: MicrophoneDriverController | null = null;

export class MicrophoneDriverController {
  private static readonly TAG = 'MicDriverController';

  // ── Audio formats ──────────────────────────────────────────────
  static readonly FORMAT_WEBM_OPUS = 'webm-opus';
  /** PCM gated by VAD — only delivers audio when speaking is detected. */
  static readonly FORMAT_PCM_S16LE = 'pcm-s16le';
  /** Raw PCM — delivers all audio regardless of VAD state (ASMR, music, environment). */
  static readonly FORMAT_PCM_S16LE_RAW = 'pcm-s16le-raw';

  // ── Lifecycle state ───────────────────────────────────────────

  private _running = false;
  private _micName = '';
  private _pcmSampleRate = 48000;

  /** Maps serviceId → holder info (sender WebContents + requested formats). */
  private _holders = new Map<string, { sender: WebContents | null; formats: string[] }>();

  /** Cleanup listeners keyed by serviceId — removes holder when its WebContents is destroyed. */
  private _destroyListeners = new Map<string, () => void>();

  // ── VAD state (from audio driver pipeline) ────────────────────

  private _speaking = false;
  private _fanNoise = false;
  private _level = 0;
  private _noiseFloor = 0;

  // ── Signal analysis (from audio driver pipeline) ──────────────

  private _zcr = 0;
  private _variance = 0;
  private _pitch: number | null = null;
  private _centroid = 0;

  // ── Noise processor ────────────────────────────────────────────

  private _noiseProcessor: AudioNoiseProcessor | null = null;

  // ── ACK promise tracking ──────────────────────────────────────

  private _startedResolve: ((deviceInfo: any) => void) | null = null;
  private _stoppedResolve: (() => void) | null = null;
  private _vadIgnoreLogged = false;

  // ── Constructor ───────────────────────────────────────────────

  private constructor() {
    log.info(MicrophoneDriverController.TAG, 'Initializing singleton');
    this._registerAckListeners();
    this._registerVadListener();
    this._registerPcmListener();
  }

  static getInstance(): MicrophoneDriverController {
    if (!instance) {
      instance = new MicrophoneDriverController();
    }
    return instance;
  }

  // ── Lifecycle ─────────────────────────────────────────────────

  /**
   * Request mic capture for a service. If first holder,
   * signals the tray panel renderer to start the audio driver's
   * mic pipeline (getUserMedia + VAD + feedback detection).
   *
   * @param serviceId - Identifies who is requesting the mic
   * @param sender - The WebContents of the requesting window (for targeted VAD sends)
   * @param opts.formats - Audio formats this service needs: 'webm-opus' (gateway), 'pcm-s16le' (whisper)
   */
  async start(serviceId: string, sender?: WebContents, opts?: { formats?: string[] }): Promise<void> {
    const formats = opts?.formats || [MicrophoneDriverController.FORMAT_WEBM_OPUS];
    log.info(MicrophoneDriverController.TAG, 'start()', { serviceId, formats, currentHolders: [...this._holders.keys()], running: this._running });

    // Remove any previous destroy listener for this serviceId (re-registration)
    this._removeDestroyListener(serviceId);

    const senderAlive = sender && !sender.isDestroyed();
    this._holders.set(serviceId, {
      sender: senderAlive ? sender : null,
      formats,
    });

    // Auto-remove holder when its renderer is destroyed (window closed, navigated away, crashed)
    if (senderAlive) {
      const onDestroyed = () => {
        log.info(MicrophoneDriverController.TAG, 'WebContents destroyed — auto-releasing holder', { serviceId });
        this.stop(serviceId).catch((e: any) => {
          log.error(MicrophoneDriverController.TAG, 'Auto-release stop() failed', { serviceId, error: e.message });
        });
      };
      sender.once('destroyed', onDestroyed);
      this._destroyListeners.set(serviceId, onDestroyed);
    }

    if (!this._running) {
      const neededFormats = this._getNeededFormats();
      log.info(MicrophoneDriverController.TAG, 'First holder — sending renderer-start-mic command', { neededFormats });
      const deviceInfo = await this._sendRendererStart(undefined, neededFormats);
      log.info(MicrophoneDriverController.TAG, 'Renderer ACK received', { deviceInfo });
      if (deviceInfo) {
        this._micName = deviceInfo.micName || '';
        this._pcmSampleRate = deviceInfo.pcmSampleRate || 48000;
        audio.setDeviceNames(this._micName, deviceInfo.speakerName || '');
        log.info(MicrophoneDriverController.TAG, 'PCM sample rate', { rate: this._pcmSampleRate });
      } else {
        log.warn(MicrophoneDriverController.TAG, 'Renderer returned null deviceInfo — mic may not have started');
      }
      this._running = true;
      this._persist();

      // Init noise processor for gated audio paths
      this._noiseProcessor = new AudioNoiseProcessor(this._pcmSampleRate);
      this._noiseProcessor.init().catch((e: any) => {
        log.warn(MicrophoneDriverController.TAG, 'Noise processor init failed (layers 2-3 may be degraded)', { error: e.message });
      });

      log.info(MicrophoneDriverController.TAG, 'Mic pipeline started', { holders: [...this._holders.keys()], formats: neededFormats, micName: this._micName });
    } else {
      // Check if the new holder needs a format that isn't currently running
      // TODO: could signal renderer to add a new format stream without restarting
      log.info(MicrophoneDriverController.TAG, 'Mic already running — added holder only', { serviceId, formats, totalHolders: this._holders.size });
    }
  }

  /**
   * Release mic for a service. If no holders remain,
   * signals the tray panel renderer to stop the audio driver's
   * mic pipeline. All VAD state resets to defaults.
   */
  async stop(serviceId: string): Promise<void> {
    log.info(MicrophoneDriverController.TAG, 'stop()', { serviceId, currentHolders: [...this._holders.keys()], running: this._running });

    const wasHolder = this._holders.has(serviceId);
    this._holders.delete(serviceId);
    this._removeDestroyListener(serviceId);
    log.info(MicrophoneDriverController.TAG, 'Holder removed', { serviceId, wasHolder, remainingHolders: [...this._holders.keys()] });

    if (this._running && this._holders.size === 0) {
      log.info(MicrophoneDriverController.TAG, 'Last holder released — sending renderer-stop-mic command');
      await this._sendRendererStop();
      this._running = false;
      this._resetVadState();
      this._persist();

      // Dispose noise processor
      if (this._noiseProcessor) {
        this._noiseProcessor.dispose();
        this._noiseProcessor = null;
      }

      log.info(MicrophoneDriverController.TAG, 'Mic pipeline stopped');
    } else if (this._holders.size > 0) {
      log.info(MicrophoneDriverController.TAG, 'Mic still held by other services', { remaining: [...this._holders.keys()] });
    } else if (!this._running) {
      log.warn(MicrophoneDriverController.TAG, 'stop() called but mic was not running', { serviceId });
    }
  }

  // ── Read-only state ───────────────────────────────────────────

  // Lifecycle
  get running(): boolean { return this._running }
  get micName(): string { return this._micName }
  get pcmSampleRate(): number { return this._pcmSampleRate }
  get holders(): string[] { return [...this._holders.keys()] }

  // VAD (from audio driver pipeline)
  get speaking(): boolean { return this._speaking }
  get fanNoise(): boolean { return this._fanNoise }
  get level(): number { return this._level }
  get noiseFloor(): number { return this._noiseFloor }

  // Signal analysis (from audio driver pipeline)
  get zcr(): number { return this._zcr }
  get variance(): number { return this._variance }
  get pitch(): number | null { return this._pitch }
  get centroid(): number { return this._centroid }

  isHolder(serviceId: string): boolean {
    return this._holders.has(serviceId);
  }

  /**
   * Get the full mic state snapshot. Used by IPC handlers to return
   * state to the requesting renderer.
   */
  getState() {
    return {
      running:    this._running,
      micName:    this._micName,
      holders:    [...this._holders.keys()],
      speaking:   this._speaking,
      fanNoise:   this._fanNoise,
      level:      this._level,
      noiseFloor: this._noiseFloor,
      zcr:        this._zcr,
      variance:   this._variance,
      pitch:      this._pitch,
      centroid:   this._centroid,
    };
  }

  // ── Shutdown ──────────────────────────────────────────────────

  async shutdown(): Promise<void> {
    log.info(MicrophoneDriverController.TAG, 'Shutting down');
    if (this._running) {
      await this._sendRendererStop();
    }
    this._running = false;
    for (const sid of this._destroyListeners.keys()) {
      this._removeDestroyListener(sid);
    }
    this._holders.clear();
    this._resetVadState();
    instance = null;
  }

  // ── VAD data relay ────────────────────────────────────────────

  /**
   * Called when the renderer sends mic-vad-update. Updates internal
   * state and re-broadcasts to all windows as audio-driver:mic-vad.
   *
   * This is the ONLY code path that should relay mic VAD data.
   */
  private _vadFrameCount = 0;

  processVadUpdate(data: any): void {
    if (!data) return;
    if (!this._running) {
      // Log once if we're getting VAD data while not running
      if (!this._vadIgnoreLogged) {
        log.warn(MicrophoneDriverController.TAG, 'processVadUpdate called but mic not running — ignoring');
        this._vadIgnoreLogged = true;
      }
      return;
    }
    this._vadIgnoreLogged = false;
    this._vadFrameCount++;
    if (this._vadFrameCount <= 3 || this._vadFrameCount % 300 === 0) {
      log.info(MicrophoneDriverController.TAG, 'processVadUpdate', { frame: this._vadFrameCount, speaking: data.speaking, level: data.level?.toFixed(3), holders: [...this._holders.keys()] });
    }

    // Update internal state from the audio driver's VAD pipeline
    this._speaking = !!data.speaking;
    this._fanNoise = !!data.fanNoise;
    this._level = data.level ?? this._level;
    this._noiseFloor = data.noiseFloor ?? this._noiseFloor;
    this._zcr = data.zcr ?? this._zcr;
    this._variance = data.variance ?? this._variance;
    this._pitch = data.pitch !== undefined ? data.pitch : this._pitch;
    this._centroid = data.centroid ?? this._centroid;

    // Send VAD data only to windows that requested the mic
    this._sendToHolders('audio-driver:mic-vad', data);

    // Feed the main-process teleprompter tracker (no-ops if not tracking)
    this._feedTeleprompterTracking(data);
  }

  /**
   * Lazy-forward VAD to the teleprompter tracking module.
   * Uses a cached import to avoid overhead on every frame.
   */
  private _tpTrackingModule: { onVadUpdate: (data: any) => void } | null | undefined;

  private _feedTeleprompterTracking(data: any): void {
    if (this._tpTrackingModule === undefined) {
      // First call — lazy-import
      import('@pkg/main/teleprompterTracking')
        .then((mod) => { this._tpTrackingModule = mod; mod.onVadUpdate(data) })
        .catch(() => { this._tpTrackingModule = null });
      return;
    }
    this._tpTrackingModule?.onVadUpdate(data);
  }

  // ── ACK handlers ──────────────────────────────────────────────

  onStarted(deviceInfo: any): void {
    log.info(MicrophoneDriverController.TAG, 'ACK mic-started', deviceInfo);
    if (this._startedResolve) {
      this._startedResolve(deviceInfo);
      this._startedResolve = null;
    }
  }

  onStopped(): void {
    log.info(MicrophoneDriverController.TAG, 'ACK mic-stopped');
    if (this._stoppedResolve) {
      this._stoppedResolve();
      this._stoppedResolve = null;
    }
  }

  // ── Private: renderer communication ───────────────────────────

  /** Compute the union of all formats needed by current holders. */
  private _getNeededFormats(): string[] {
    const formats = new Set<string>();
    for (const holder of this._holders.values()) {
      for (const fmt of holder.formats) {
        formats.add(fmt);
      }
    }
    return [...formats];
  }

  private _sendRendererStart(deviceId?: string, formats?: string[]): Promise<any> {
    return new Promise((resolve) => {
      this._startedResolve = resolve;

      log.info(MicrophoneDriverController.TAG, 'Broadcasting renderer-start-mic to all windows', { deviceId });
      const windowCount = this._countWindows();
      log.info(MicrophoneDriverController.TAG, `Sending to ${ windowCount } window(s), waiting for ACK...`);

      const timeout = setTimeout(() => {
        if (this._startedResolve) {
          log.warn(MicrophoneDriverController.TAG, 'Start ACK timed out after 10s — renderer may not be loaded');
          this._startedResolve = null;
          resolve(null);
        }
      }, 10_000);

      const origResolve = this._startedResolve;
      this._startedResolve = (info: any) => {
        clearTimeout(timeout);
        log.info(MicrophoneDriverController.TAG, 'Start ACK received within timeout');
        origResolve(info);
      };

      this._broadcast('audio-driver:renderer-start-mic', { deviceId, formats: formats || ['webm-opus'] });
    });
  }

  private _sendRendererStop(): Promise<void> {
    return new Promise((resolve) => {
      this._stoppedResolve = resolve;

      log.info(MicrophoneDriverController.TAG, 'Broadcasting renderer-stop-mic to all windows');

      const timeout = setTimeout(() => {
        if (this._stoppedResolve) {
          log.warn(MicrophoneDriverController.TAG, 'Stop ACK timed out after 10s');
          this._stoppedResolve = null;
          resolve();
        }
      }, 10_000);

      const origResolve = this._stoppedResolve;
      this._stoppedResolve = () => {
        clearTimeout(timeout);
        log.info(MicrophoneDriverController.TAG, 'Stop ACK received within timeout');
        origResolve();
      };

      this._broadcast('audio-driver:renderer-stop-mic', {});
    });
  }

  /** Send to all windows (used for renderer commands like start/stop mic). */
  private _broadcast(channel: string, data: any): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(channel, data);
      }
    }
  }

  /** Count non-destroyed windows. */
  private _countWindows(): number {
    return BrowserWindow.getAllWindows().filter(w => !w.isDestroyed()).length;
  }

  /** Remove the WebContents 'destroyed' listener for a serviceId, if one exists. */
  private _removeDestroyListener(serviceId: string): void {
    const listener = this._destroyListeners.get(serviceId);
    if (listener) {
      const holder = this._holders.get(serviceId);
      if (holder?.sender && !holder.sender.isDestroyed()) {
        holder.sender.removeListener('destroyed', listener);
      }
      this._destroyListeners.delete(serviceId);
    }
  }

  /** Send only to windows that are holding the mic open. */
  private _sendToHolders(channel: string, data: any): void {
    let sent = 0;
    let skipped = 0;
    for (const [, holder] of this._holders) {
      if (holder.sender && !holder.sender.isDestroyed()) {
        holder.sender.send(channel, data);
        sent++;
      } else {
        skipped++;
      }
    }
    if (!this._sendCount) this._sendCount = 0;
    this._sendCount++;
    if (this._sendCount <= 3 || this._sendCount % 300 === 0) {
      log.info(MicrophoneDriverController.TAG, '_sendToHolders', { channel, sent, skipped, totalHolders: this._holders.size, frame: this._sendCount });
    }
  }

  private _sendCount = 0;

  /**
   * Process a raw PCM chunk from the renderer.
   * Routes to gated callbacks (speech only) and raw callbacks (everything).
   */
  processPcmChunk(chunk: Buffer): void {
    if (!this._running) return;

    // Raw callbacks get everything (ASMR, music, environment recording)
    for (const cb of this._pcmRawCallbacks) {
      cb(chunk);
    }

    // Gated callbacks get noise-processed audio
    // Process through all 4 layers (high-pass, RNNoise, spectral sub, crossfade)
    const processed = this._noiseProcessor
      ? this._noiseProcessor.process(chunk, this._speaking)
      : (this._speaking ? chunk : Buffer.alloc(chunk.length));

    if (this._speaking) {
      for (const cb of this._pcmGatedCallbacks) {
        cb(processed);
      }
    }

    // Test recording buffers
    if (this._testRecordingMode) {
      const totalRaw = this._testRawChunks.reduce((s, b) => s + b.length, 0);
      if (totalRaw < this._testMaxBytes) {
        if (this._testRecordingMode === 'raw' || this._testRecordingMode === 'both') {
          this._testRawChunks.push(Buffer.from(chunk));
        }
        if (this._testRecordingMode === 'noise-reduction' || this._testRecordingMode === 'both') {
          // Use the noise-processed audio (with crossfade envelope for timeline)
          this._testGatedChunks.push(Buffer.from(processed));
        }
      } else if (this._testRecordingMode) {
        log.warn(MicrophoneDriverController.TAG, 'Test recording auto-stopped (30s max)');
        this._testRecordingMode = null;
      }
    }
  }

  // ── PCM subscriber callbacks ──────────────────────────────────

  /** VAD-gated PCM — only fires when speaking is detected. */
  private _pcmGatedCallbacks: ((chunk: Buffer) => void)[] = [];
  /** Raw PCM — fires for every chunk regardless of VAD. */
  private _pcmRawCallbacks:   ((chunk: Buffer) => void)[] = [];

  /** Register a callback for VAD-gated PCM (speech only). */
  onPcmData(cb: (chunk: Buffer) => void): () => void {
    this._pcmGatedCallbacks.push(cb);
    return () => {
      this._pcmGatedCallbacks = this._pcmGatedCallbacks.filter(c => c !== cb);
    };
  }

  /** Register a callback for raw PCM (all audio, no VAD gating). */
  onPcmRawData(cb: (chunk: Buffer) => void): () => void {
    this._pcmRawCallbacks.push(cb);
    return () => {
      this._pcmRawCallbacks = this._pcmRawCallbacks.filter(c => c !== cb);
    };
  }

  // ── Test Recording (PCM → WAV) ─────────────────────────────────

  private _testRecordingMode: 'raw' | 'noise-reduction' | 'both' | null = null;
  private _testRawChunks:     Buffer[] = [];
  private _testGatedChunks:   Buffer[] = [];
  private _testMaxBytes = 16000 * 2 * 30; // 30 seconds max

  /**
   * Start buffering PCM for test recording.
   * @param mode - 'raw' (all audio), 'noise-reduction' (speech only), 'both' (A/B comparison)
   */
  startTestRecording(mode: 'raw' | 'noise-reduction' | 'both' = 'raw'): void {
    log.info(MicrophoneDriverController.TAG, 'startTestRecording', { mode });
    this._testRecordingMode = mode;
    this._testRawChunks = [];
    this._testGatedChunks = [];
  }

  /**
   * Stop buffering, wrap PCM in WAV headers, return playable audio.
   */
  stopTestRecording(): { raw?: ArrayBuffer; noiseReduced?: ArrayBuffer } | null {
    const mode = this._testRecordingMode;
    this._testRecordingMode = null;
    log.info(MicrophoneDriverController.TAG, 'stopTestRecording', {
      mode,
      rawChunks:   this._testRawChunks.length,
      gatedChunks: this._testGatedChunks.length,
    });

    const result: { raw?: ArrayBuffer; noiseReduced?: ArrayBuffer } = {};

    if ((mode === 'raw' || mode === 'both') && this._testRawChunks.length > 0) {
      const wav = this._buildWav(Buffer.concat(this._testRawChunks));
      result.raw = new Uint8Array(wav).buffer;
    }

    if ((mode === 'noise-reduction' || mode === 'both') && this._testGatedChunks.length > 0) {
      const wav = this._buildWav(Buffer.concat(this._testGatedChunks));
      result.noiseReduced = new Uint8Array(wav).buffer;
    }

    this._testRawChunks = [];
    this._testGatedChunks = [];

    return Object.keys(result).length > 0 ? result : null;
  }

  get testRecording(): boolean {
    return this._testRecordingMode !== null;
  }

  /** Build a WAV file from raw PCM (s16le, mono, any sample rate). */
  private _buildWav(pcm: Buffer): Buffer {
    const header = Buffer.alloc(44);
    const dataSize = pcm.length;
    const sampleRate = this._pcmSampleRate;
    const byteRate = sampleRate * 2; // mono * 16-bit

    header.write('RIFF', 0);
    header.writeUInt32LE(36 + dataSize, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);       // fmt chunk size
    header.writeUInt16LE(1, 20);        // PCM format
    header.writeUInt16LE(1, 22);        // channels: mono
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(2, 32);        // block align
    header.writeUInt16LE(16, 34);       // bits per sample
    header.write('data', 36);
    header.writeUInt32LE(dataSize, 40);

    return Buffer.concat([header, pcm]);
  }

  // ── Private ───────────────────────────────────────────────────

  private _resetVadState(): void {
    this._speaking = false;
    this._fanNoise = false;
    this._level = 0;
    this._noiseFloor = 0;
    this._zcr = 0;
    this._variance = 0;
    this._pitch = null;
    this._centroid = 0;
  }

  private _persist(): void {
    audio.savePrefs({ ...audio.loadPrefs(), micEnabled: this._running });
  }

  private _registerAckListeners(): void {
    ipcMain.on('audio-driver:mic-started', (_event: Electron.IpcMainEvent, deviceInfo: any) => {
      this.onStarted(deviceInfo);
    });

    ipcMain.on('audio-driver:mic-stopped', () => {
      this.onStopped();
    });
  }

  /**
   * Intercept mic-vad-update from the renderer. Instead of init.ts
   * blindly relaying it, this controller processes and owns the data.
   */
  private _registerVadListener(): void {
    ipcMain.on('audio-driver:mic-vad-update', (_event: Electron.IpcMainEvent, data: any) => {
      this.processVadUpdate(data);
    });
  }

  /**
   * Receive raw PCM chunks from the renderer (s16le, 16kHz, mono).
   * Distributes to all registered PCM callbacks (e.g. whisper-transcribe).
   */
  private _registerPcmListener(): void {
    ipcMain.on('audio-driver:mic-pcm', (_event: Electron.IpcMainEvent, buffer: any) => {
      if (!this._running || !buffer) return;
      // processPcmChunk routes to gated (speech only) and raw (everything)
      this.processPcmChunk(Buffer.from(buffer));
    });
  }
}
