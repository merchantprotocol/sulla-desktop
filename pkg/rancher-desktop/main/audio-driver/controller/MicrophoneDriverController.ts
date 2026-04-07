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
import * as audio from '../model/audio';
import { log } from '../model/logger';

// ── Singleton ───────────────────────────────────────────────────

let instance: MicrophoneDriverController | null = null;

export class MicrophoneDriverController {
  private static readonly TAG = 'MicDriverController';

  // ── Lifecycle state ───────────────────────────────────────────

  private _running = false;
  private _micName = '';

  /** Maps serviceId → the WebContents that requested it (for targeted sends). */
  private _holders = new Map<string, WebContents>();

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

  // ── ACK promise tracking ──────────────────────────────────────

  private _startedResolve: ((deviceInfo: any) => void) | null = null;
  private _stoppedResolve: (() => void) | null = null;
  private _vadIgnoreLogged = false;

  // ── Constructor ───────────────────────────────────────────────

  private constructor() {
    log.info(MicrophoneDriverController.TAG, 'Initializing singleton');
    this._registerAckListeners();
    this._registerVadListener();
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
   */
  async start(serviceId: string, sender?: WebContents): Promise<void> {
    log.info(MicrophoneDriverController.TAG, 'start()', { serviceId, currentHolders: [...this._holders.keys()], running: this._running });

    if (sender && !sender.isDestroyed()) {
      this._holders.set(serviceId, sender);
      log.info(MicrophoneDriverController.TAG, 'Holder registered with WebContents', { serviceId });
    } else {
      this._holders.set(serviceId, null as any);
      log.warn(MicrophoneDriverController.TAG, 'Holder registered WITHOUT WebContents (no targeted sends)', { serviceId });
    }

    if (!this._running) {
      log.info(MicrophoneDriverController.TAG, 'First holder — sending renderer-start-mic command');
      const deviceInfo = await this._sendRendererStart();
      log.info(MicrophoneDriverController.TAG, 'Renderer ACK received', { deviceInfo });
      if (deviceInfo) {
        this._micName = deviceInfo.micName || '';
        audio.setDeviceNames(this._micName, deviceInfo.speakerName || '');
      } else {
        log.warn(MicrophoneDriverController.TAG, 'Renderer returned null deviceInfo — mic may not have started');
      }
      this._running = true;
      this._persist();
      log.info(MicrophoneDriverController.TAG, 'Mic pipeline started', { holders: [...this._holders.keys()], micName: this._micName });
    } else {
      log.info(MicrophoneDriverController.TAG, 'Mic already running — added holder only', { serviceId, totalHolders: this._holders.size });
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
    log.info(MicrophoneDriverController.TAG, 'Holder removed', { serviceId, wasHolder, remainingHolders: [...this._holders.keys()] });

    if (this._running && this._holders.size === 0) {
      log.info(MicrophoneDriverController.TAG, 'Last holder released — sending renderer-stop-mic command');
      await this._sendRendererStop();
      this._running = false;
      this._resetVadState();
      this._persist();
      log.info(MicrophoneDriverController.TAG, 'Mic pipeline stopped');
    } else if (this._holders.size > 0) {
      log.info(MicrophoneDriverController.TAG, 'Mic still held by other services', { remaining: [...this._holders.keys()] });
    } else if (!this._running) {
      log.warn(MicrophoneDriverController.TAG, 'stop() called but mic was not running', { serviceId });
    }
  }

  // ── Read-only state ───────────────────────────────────────────

  // Lifecycle
  get running(): boolean { return this._running; }
  get micName(): string { return this._micName; }
  get holders(): string[] { return [...this._holders.keys()]; }

  // VAD (from audio driver pipeline)
  get speaking(): boolean { return this._speaking; }
  get fanNoise(): boolean { return this._fanNoise; }
  get level(): number { return this._level; }
  get noiseFloor(): number { return this._noiseFloor; }

  // Signal analysis (from audio driver pipeline)
  get zcr(): number { return this._zcr; }
  get variance(): number { return this._variance; }
  get pitch(): number | null { return this._pitch; }
  get centroid(): number { return this._centroid; }

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
    this._speaking   = !!data.speaking;
    this._fanNoise   = !!data.fanNoise;
    this._level      = data.level ?? this._level;
    this._noiseFloor = data.noiseFloor ?? this._noiseFloor;
    this._zcr        = data.zcr ?? this._zcr;
    this._variance   = data.variance ?? this._variance;
    this._pitch      = data.pitch !== undefined ? data.pitch : this._pitch;
    this._centroid   = data.centroid ?? this._centroid;

    // Send VAD data only to windows that requested the mic
    this._sendToHolders('audio-driver:mic-vad', data);
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

  private _sendRendererStart(deviceId?: string): Promise<any> {
    return new Promise((resolve) => {
      this._startedResolve = resolve;

      log.info(MicrophoneDriverController.TAG, 'Broadcasting renderer-start-mic to all windows', { deviceId });
      const windowCount = this._countWindows();
      log.info(MicrophoneDriverController.TAG, `Sending to ${windowCount} window(s), waiting for ACK...`);

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

      this._broadcast('audio-driver:renderer-start-mic', { deviceId });
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

  /** Send only to windows that are holding the mic open. */
  private _sendToHolders(channel: string, data: any): void {
    let sent = 0;
    let skipped = 0;
    for (const [serviceId, sender] of this._holders) {
      if (sender && !sender.isDestroyed()) {
        sender.send(channel, data);
        sent++;
      } else {
        skipped++;
      }
    }
    // Log only occasionally to avoid flooding (every 300 frames ~5s at 60fps)
    if (!this._sendCount) this._sendCount = 0;
    this._sendCount++;
    if (this._sendCount <= 3 || this._sendCount % 300 === 0) {
      log.info(MicrophoneDriverController.TAG, '_sendToHolders', { channel, sent, skipped, totalHolders: this._holders.size, frame: this._sendCount });
    }
  }

  private _sendCount = 0;

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
}
