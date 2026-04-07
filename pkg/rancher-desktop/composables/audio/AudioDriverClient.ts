/**
 * @module composables/audio/AudioDriverClient
 *
 * # AudioDriverClient — Singleton API for Sulla Desktop's Audio Driver
 *
 * This is the **one class** every part of the app should use to interact with
 * the audio driver. It hides all IPC channel names, listener registration,
 * state synchronisation, and lifecycle details behind a clean typed API.
 *
 * ## Quick start
 *
 * ```ts
 * // In a Vue component — reactive refs, auto-cleanup
 * const { micRunning, speaking, micLevel, startMic, stopMic } = useAudioDriver();
 *
 * // In a plain controller — class API, manual cleanup
 * const client = AudioDriverClient.getInstance();
 * client.startMic();
 * client.on('vad', (data) => console.log(data.speaking));
 * // later: client.dispose()
 * ```
 *
 * ## Why singleton?
 *
 * IPC listeners are registered once and shared. Multiple Vue components
 * calling `useAudioDriver()` all read from the same client — no duplicate
 * listeners, no state drift.
 *
 * ## Mic vs Speaker independence
 *
 * The mic and speaker are **separate subsystems** with independent lifecycles:
 * - **Mic** (`startMic` / `stopMic`) — used constantly for voice chat,
 *   dictation, transcript listening. Lightweight.
 * - **Speaker** (`startSpeaker` / `stopSpeaker`) — only for secretary mode
 *   and multi-channel transcription. Activates BlackHole loopback + mirror.
 */

import type {
  AudioDriverEvents,
  AudioDriverState,
  GatewaySession,
  GatewayStartOpts,
  SpeakerLevelEvent,
  TranscribeOpts,
  TranscriptEntry,
  VadDetails,
  VadEvent,
  VolumeState,
  WhisperStatus,
} from './types';

// ── IPC access ──────────────────────────────────────────────────
// We import the typed ipcRenderer but cast to `any` for audio-driver
// channels that aren't in the typed interface yet.

let ipc: any;

function getIpc(): any {
  if (!ipc) {
    // Dynamic import to avoid issues in non-Electron contexts (tests, SSR)
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { ipcRenderer } = require('electron');
      ipc = ipcRenderer;
    } catch {
      // Fallback: no-op stubs for testing
      ipc = {
        on:             () => ipc,
        removeListener: () => ipc,
        send:           () => {},
        invoke:         () => Promise.resolve(null),
      };
    }
  }
  return ipc;
}

// ── Typed event emitter (minimal, no dependencies) ──────────────

type Listener<T = any> = (data: T) => void;

// ── Silence debounce for speech recognition ─────────────────────

const STT_SILENCE_DELAY_MS = 1500;

// ── Singleton ───────────────────────────────────────────────────

let instance: AudioDriverClient | null = null;

/**
 * The canonical API for interacting with Sulla Desktop's audio driver.
 *
 * Manages all IPC communication, state tracking, and optional built-in
 * browser SpeechRecognition driven by the audio driver's VAD.
 */
export class AudioDriverClient {
  // ── Logging ─────────────────────────────────────────────────
  // Every method call and significant event is logged so you can
  // confirm the full pipeline is working end-to-end in DevTools.

  private static readonly TAG = '[AudioDriver]';

  private _log(action: string, data?: Record<string, any>): void {
    const msg = data
      ? `${AudioDriverClient.TAG} ${action} ${JSON.stringify(data)}`
      : `${AudioDriverClient.TAG} ${action}`;
    console.log(msg);
    // Also send to main process logger for persistent log files
    try {
      getIpc().send('audio-driver:log', 'info', 'AudioDriverClient', action, data);
    } catch { /* ignore if IPC not available */ }
  }

  private _warn(action: string, data?: Record<string, any>): void {
    const msg = data
      ? `${AudioDriverClient.TAG} ⚠ ${action} ${JSON.stringify(data)}`
      : `${AudioDriverClient.TAG} ⚠ ${action}`;
    console.warn(msg);
    try {
      getIpc().send('audio-driver:log', 'warn', 'AudioDriverClient', action, data);
    } catch { /* ignore */ }
  }

  // ── Internal state ──────────────────────────────────────────

  private _micRunning = false;
  private _speakerRunning = false;
  private _micLevel = 0;
  private _speakerLevel = 0;
  private _speaking = false;
  private _fanNoise = false;
  private _noiseFloor = 0;
  private _vadDetails: VadDetails = { zcr: 0, variance: 0, pitch: null, centroid: 0 };
  private _listening = false;

  // ── Event listeners ─────────────────────────────────────────

  private _listeners = new Map<string, Set<Listener>>();

  // ── IPC handler references (for cleanup) ────────────────────

  private _ipcHandlers: Array<{ channel: string; handler: (...args: any[]) => void }> = [];

  // ── Speech recognition state ────────────────────────────────

  private _sttRecognition: any = null;
  private _sttRunning = false;
  private _sttSilenceTimer: ReturnType<typeof setTimeout> | null = null;
  private _sttLang = 'en-US';

  // ── Constructor (private — use getInstance) ─────────────────

  private constructor() {
    this._log('Initializing singleton');
    this._registerIpcListeners();
    this._log('Initialized — IPC listeners registered');
  }

  // ── Singleton access ────────────────────────────────────────

  /** Get the shared AudioDriverClient instance. Creates it on first call. */
  static getInstance(): AudioDriverClient {
    if (!instance) {
      instance = new AudioDriverClient();
    }
    return instance;
  }

  // ── Read-only state properties ──────────────────────────────

  /** Whether the mic capture pipeline is active. */
  get micRunning(): boolean { return this._micRunning; }

  /** Whether the speaker capture pipeline is active (BlackHole mirror). */
  get speakerRunning(): boolean { return this._speakerRunning; }

  /** Mic RMS level (0–1). Updated at ~60 fps when mic is running. */
  get micLevel(): number { return this._micLevel; }

  /** Mic level in dB. */
  get micDb(): number { return AudioDriverClient.levelToDb(this._micLevel); }

  /** Speaker RMS level (0–1). Updated at capture helper's native rate. */
  get speakerLevel(): number { return this._speakerLevel; }

  /** Speaker level in dB. */
  get speakerDb(): number { return AudioDriverClient.levelToDb(this._speakerLevel); }

  /** Whether the VAD currently classifies the audio as speech. */
  get speaking(): boolean { return this._speaking; }

  /** Whether fan/mechanical noise is detected. */
  get fanNoise(): boolean { return this._fanNoise; }

  /** Adaptive noise floor RMS. */
  get noiseFloor(): number { return this._noiseFloor; }

  /** Detailed VAD analysis metrics: ZCR, variance, pitch, centroid. */
  get vadDetails(): VadDetails { return { ...this._vadDetails }; }

  /** Whether VAD-driven speech recognition is active. */
  get listening(): boolean { return this._listening; }

  // ── Microphone Lifecycle ────────────────────────────────────

  /**
   * Start the mic capture pipeline.
   * Activates getUserMedia → GainNode → AnalyserNode → VAD in the tray panel.
   * VAD events (`vad`) begin broadcasting immediately.
   */
  async startMic(): Promise<void> {
    this._log('startMic()');
    await getIpc().invoke('audio-driver:start-mic');
    this._micRunning = true;
    this._log('startMic() complete', { micRunning: true });
    this._emit('stateChange', this._buildState());
  }

  /**
   * Stop the mic capture pipeline.
   * The mic stream, VAD, and all analysis stop. Level drops to 0.
   */
  async stopMic(): Promise<void> {
    this._log('stopMic()');
    await getIpc().invoke('audio-driver:stop-mic');
    this._micRunning = false;
    this._micLevel = 0;
    this._speaking = false;
    this._fanNoise = false;
    this._log('stopMic() complete', { micRunning: false });
    this._emit('stateChange', this._buildState());
  }

  /** Toggle mic on/off based on current state. */
  toggleMic(): void {
    if (this._micRunning) {
      this.stopMic();
    } else {
      this.startMic();
    }
  }

  // ── Speaker Lifecycle ───────────────────────────────────────

  /**
   * Start the speaker capture pipeline.
   * Activates BlackHole loopback → aggregate mirror → CoreAudio Swift helper.
   * Speaker level events (`speakerLevel`) begin broadcasting.
   */
  async startSpeaker(): Promise<void> {
    this._log('startSpeaker()');
    await getIpc().invoke('audio-driver:start-speaker');
    this._speakerRunning = true;
    this._log('startSpeaker() complete', { speakerRunning: true });
    this._emit('stateChange', this._buildState());
  }

  /**
   * Stop the speaker capture pipeline.
   * Tears down the mirror device and stops the CoreAudio helper.
   */
  async stopSpeaker(): Promise<void> {
    this._log('stopSpeaker()');
    await getIpc().invoke('audio-driver:stop-speaker');
    this._speakerRunning = false;
    this._speakerLevel = 0;
    this._log('stopSpeaker() complete', { speakerRunning: false });
    this._emit('stateChange', this._buildState());
  }

  /** Toggle speaker on/off based on current state. */
  toggleSpeaker(): void {
    if (this._speakerRunning) {
      this.stopSpeaker();
    } else {
      this.startSpeaker();
    }
  }

  // ── Combined convenience ────────────────────────────────────

  /** Start both mic and speaker capture. */
  async startAll(): Promise<void> {
    await Promise.all([this.startMic(), this.startSpeaker()]);
  }

  /** Stop both mic and speaker capture. */
  async stopAll(): Promise<void> {
    await Promise.all([this.stopMic(), this.stopSpeaker()]);
  }

  /** Query the full state from the main process. */
  async getState(): Promise<AudioDriverState> {
    const state = await getIpc().invoke('audio-driver:get-state');
    if (state) {
      this._micRunning = !!state.micRunning || !!state.running;
      this._speakerRunning = !!state.speakerRunning;
    }
    return state;
  }

  // ── Mic Volume/Gain ─────────────────────────────────────────

  /** Set the mic input gain (0–1). Applied in the Web Audio GainNode. */
  setMicGain(value: number): void {
    this._log('setMicGain()', { value });
    getIpc().send('audio-driver:mic-gain', value);
  }

  /** Mute/unmute the mic without stopping the stream. */
  setMicMuted(muted: boolean): void {
    this._log('setMicMuted()', { muted });
    getIpc().send('audio-driver:mic-mute', muted);
  }

  // ── Speaker Volume ──────────────────────────────────────────

  /** Increase system speaker volume. */
  async speakerVolumeUp(): Promise<VolumeState> {
    return await getIpc().invoke('audio-driver:speaker-volume-up');
  }

  /** Decrease system speaker volume. */
  async speakerVolumeDown(): Promise<VolumeState> {
    return await getIpc().invoke('audio-driver:speaker-volume-down');
  }

  /** Toggle system speaker mute. */
  async speakerMuteToggle(): Promise<VolumeState> {
    return await getIpc().invoke('audio-driver:speaker-mute-toggle');
  }

  /** Get current system speaker volume and mute state. */
  async speakerVolumeGet(): Promise<VolumeState> {
    return await getIpc().invoke('audio-driver:speaker-volume-get');
  }

  // ── Device Selection ────────────────────────────────────────

  /** Change the active microphone input device. */
  async setMicDevice(deviceName: string): Promise<void> {
    await getIpc().invoke('audio-driver:set-system-input', deviceName);
  }

  /** Change the active speaker output device. */
  async setSpeakerDevice(deviceName: string): Promise<void> {
    await getIpc().invoke('audio-driver:set-system-output', deviceName);
  }

  // ── Gateway (Transcription Streaming) ───────────────────────

  /**
   * Start a gateway transcription session.
   * Opens WebSocket connections for audio streaming and transcript reception.
   */
  async gatewayStart(opts?: GatewayStartOpts): Promise<GatewaySession> {
    this._log('gatewayStart()', { userName: opts?.userName, channels: opts?.channels ? Object.keys(opts.channels) : undefined });
    const result = await getIpc().invoke('audio-driver:gateway-start', opts);
    this._log('gatewayStart() complete', { sessionId: result?.sessionId, callId: result?.callId });
    return result;
  }

  /** Stop the current gateway session. */
  async gatewayStop(): Promise<void> {
    this._log('gatewayStop()');
    await getIpc().invoke('audio-driver:gateway-stop');
    this._log('gatewayStop() complete');
  }

  /** Send an audio chunk to the gateway on the specified channel. */
  async gatewaySend(audio: ArrayBuffer, channel: number): Promise<void> {
    await getIpc().invoke('audio-driver:gateway-send', { audio, channel });
  }

  // ── Test Recording ──────────────────────────────────────────

  /**
   * Start buffering mic audio chunks in the main process.
   * Captures audio from the audio driver pipeline (post-gain, post-VAD).
   */
  async testRecordStart(): Promise<void> {
    this._log('testRecordStart()');
    await getIpc().invoke('audio-driver:test-record-start');
  }

  /**
   * Stop buffering and return the recorded audio as a WebM/Opus ArrayBuffer.
   * Play it back with `new Audio(URL.createObjectURL(new Blob([result.audio])))`.
   */
  async testRecordStop(): Promise<{ audio: ArrayBuffer; chunkCount: number }> {
    this._log('testRecordStop()');
    const result = await getIpc().invoke('audio-driver:test-record-stop');
    this._log('testRecordStop() complete', { chunkCount: result?.chunkCount, bytes: result?.audio?.byteLength });
    return result;
  }

  // ── Speech Recognition (VAD-driven browser STT) ─────────────

  /**
   * Start listening for speech using browser SpeechRecognition,
   * controlled by the audio driver's VAD.
   *
   * When VAD detects speech → recognition starts.
   * When VAD detects silence → recognition stops after debounce,
   * and a `transcript` event is emitted with the recognized text.
   *
   * @param opts.lang - BCP-47 language code (default: 'en-US')
   */
  startListening(opts?: { lang?: string }): void {
    if (this._listening) return;
    this._sttLang = opts?.lang || 'en-US';
    this._listening = true;
    this._log('startListening()', { lang: this._sttLang });
  }

  /** Stop listening and tear down the SpeechRecognition instance. */
  stopListening(): void {
    this._log('stopListening()');
    this._listening = false;
    this._stopStt();
    if (this._sttSilenceTimer) {
      clearTimeout(this._sttSilenceTimer);
      this._sttSilenceTimer = null;
    }
  }

  // ── Socket Paths ────────────────────────────────────────────

  /** Get the Unix domain socket path for mic audio (WebM/Opus chunks). */
  async getMicSocketPath(): Promise<string | null> {
    return await getIpc().invoke('audio-driver:get-mic-socket-path');
  }

  /** Get the Unix domain socket path for speaker audio (s16le PCM). */
  async getSpeakerSocketPath(): Promise<string | null> {
    return await getIpc().invoke('audio-driver:get-speaker-socket-path');
  }

  // ── Whisper (Local STT) ─────────────────────────────────────

  /** Check if whisper.cpp is installed and which models are available. */
  async whisperDetect(): Promise<WhisperStatus> {
    return await getIpc().invoke('audio-driver:whisper-detect');
  }

  /** Install whisper.cpp via Homebrew. */
  async whisperInstall(): Promise<{ ok: boolean }> {
    return await getIpc().invoke('audio-driver:whisper-install');
  }

  /** Start local whisper transcription. Emits `transcript` events. */
  async transcribeStart(opts: TranscribeOpts): Promise<{ ok: boolean }> {
    return await getIpc().invoke('audio-driver:transcribe-start', opts);
  }

  /** Stop local whisper transcription. */
  async transcribeStop(): Promise<void> {
    await getIpc().invoke('audio-driver:transcribe-stop');
  }

  // ── Events ──────────────────────────────────────────────────

  /**
   * Subscribe to an event. Returns an unsubscribe function.
   *
   * Events:
   * - `vad` — VAD analysis frame (speaking, level, noise, spectral features)
   * - `speakerLevel` — speaker RMS/peak data
   * - `stateChange` — mic/speaker running state changed
   * - `transcript` — speech-to-text result (from STT, gateway, or whisper)
   * - `volumeChange` — system volume changed
   * - `deviceChange` — speaker output device changed
   */
  on<K extends keyof AudioDriverEvents>(event: K, handler: Listener<AudioDriverEvents[K]>): () => void {
    if (!this._listeners.has(event)) {
      this._listeners.set(event, new Set());
    }
    this._listeners.get(event)!.add(handler);

    // Return unsubscribe function
    return () => {
      this._listeners.get(event)?.delete(handler);
    };
  }

  // ── Cleanup ─────────────────────────────────────────────────

  /** Remove all IPC listeners and reset state. Call on app shutdown. */
  dispose(): void {
    this._log('dispose() — removing all IPC listeners');
    const r = getIpc();
    for (const { channel, handler } of this._ipcHandlers) {
      r.removeListener(channel, handler);
    }
    this._ipcHandlers = [];
    this._listeners.clear();
    this.stopListening();
    instance = null;
  }

  // ── Static helpers ──────────────────────────────────────────

  /**
   * Convert an RMS level (0–1) to decibels.
   * Returns -Infinity for silence (level ≤ 0).
   */
  static levelToDb(level: number): number {
    if (level <= 0) return -Infinity;
    return 20 * Math.log10(level);
  }

  /**
   * Format a dB value for display.
   * Returns '-inf' for -Infinity, otherwise rounds to specified decimals.
   */
  static formatDb(db: number, decimals = 0): string {
    if (!isFinite(db)) return '-inf';
    return db.toFixed(decimals);
  }

  // ── Private: IPC listener registration ──────────────────────

  private _registerIpcListeners(): void {
    const r = getIpc();

    this._addIpcListener(r, 'audio-driver:state', (_e: any, state: any) => {
      if (!state) return;
      const prevMic = this._micRunning;
      const prevSpk = this._speakerRunning;
      this._micRunning = !!state.micRunning || !!state.running;
      this._speakerRunning = !!state.speakerRunning;
      if (this._micRunning !== prevMic || this._speakerRunning !== prevSpk) {
        this._log('IPC state changed', { micRunning: this._micRunning, speakerRunning: this._speakerRunning, message: state.message });
      }
      this._emit('stateChange', this._buildState());
    });

    this._addIpcListener(r, 'audio-driver:mic-vad', (_e: any, data: VadEvent) => {
      if (!data) return;
      const prevSpeaking = this._speaking;
      const prevFan = this._fanNoise;
      this._micLevel = data.level;
      this._speaking = data.speaking;
      this._fanNoise = data.fanNoise;
      // Log only on state transitions (not every frame)
      if (data.speaking !== prevSpeaking) {
        this._log(data.speaking ? 'VAD: speaking started' : 'VAD: speaking stopped', { level: data.level.toFixed(3), noiseFloor: data.noiseFloor?.toFixed(4) });
      }
      if (data.fanNoise !== prevFan) {
        this._log(data.fanNoise ? 'VAD: fan noise detected' : 'VAD: fan noise cleared');
      }
      if (data.noiseFloor !== undefined) this._noiseFloor = data.noiseFloor;
      this._vadDetails = {
        zcr:      data.zcr ?? this._vadDetails.zcr,
        variance: data.variance ?? this._vadDetails.variance,
        pitch:    data.pitch !== undefined ? data.pitch : this._vadDetails.pitch,
        centroid: data.centroid ?? this._vadDetails.centroid,
      };
      this._emit('vad', data);

      // Drive speech recognition if listening
      if (this._listening) {
        this._handleVadForStt(data);
      }
    });

    this._addIpcListener(r, 'audio-driver:speaker-level', (_e: any, data: SpeakerLevelEvent) => {
      if (!data) return;
      this._speakerLevel = typeof data === 'number' ? data : (data as any).rms;
      this._emit('speakerLevel', data);
    });

    this._addIpcListener(r, 'audio-driver:volume-changed', (_e: any, state: VolumeState) => {
      if (state) this._emit('volumeChange', state);
    });

    this._addIpcListener(r, 'audio-driver:speaker-device-changed', (_e: any, name: string) => {
      if (name) this._emit('deviceChange', name);
    });

    this._addIpcListener(r, 'audio-driver:auto-start', () => {
      this._micRunning = true;
      this._emit('stateChange', this._buildState());
    });

    this._addIpcListener(r, 'gateway-transcript', (_e: any, msg: any) => {
      if (!msg || !msg.text) return;
      const entry: TranscriptEntry = {
        speaker:   msg.channel_label || msg.speaker || 'Unknown',
        text:      msg.text,
        partial:   msg.event_type === 'transcript_partial',
        timestamp: Date.now(),
      };
      if (!entry.partial) {
        this._log('Gateway transcript', { speaker: entry.speaker, text: entry.text.substring(0, 80) });
      }
      this._emit('transcript', entry);
    });
  }

  private _addIpcListener(r: any, channel: string, handler: (...args: any[]) => void): void {
    r.on(channel, handler);
    this._ipcHandlers.push({ channel, handler });
  }

  // ── Private: Speech Recognition ─────────────────────────────

  private _handleVadForStt(data: VadEvent): void {
    if (data.speaking) {
      if (this._sttSilenceTimer) {
        clearTimeout(this._sttSilenceTimer);
        this._sttSilenceTimer = null;
      }
      this._startStt();
    } else {
      if (this._sttRunning && !this._sttSilenceTimer) {
        this._sttSilenceTimer = setTimeout(() => {
          this._sttSilenceTimer = null;
          this._stopStt();
        }, STT_SILENCE_DELAY_MS);
      }
    }
  }

  private _startStt(): void {
    if (this._sttRunning) return;
    if (!this._sttRecognition) {
      this._sttRecognition = this._createSttRecognition();
      if (!this._sttRecognition) {
        this._warn('SpeechRecognition not supported in this browser');
        return;
      }
    }
    try {
      this._sttRecognition.start();
      this._sttRunning = true;
      this._log('STT recognition started', { lang: this._sttLang });
    } catch {
      // Already started
    }
  }

  private _stopStt(): void {
    if (!this._sttRecognition) return;
    try {
      this._sttRecognition.stop();
    } catch {
      // Already stopped
    }
    this._sttRunning = false;
    this._log('STT recognition stopped');
  }

  private _createSttRecognition(): any {
    const SR = (globalThis as any).SpeechRecognition || (globalThis as any).webkitSpeechRecognition;
    if (!SR) return null;

    const rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = this._sttLang;

    rec.onresult = (event: any) => {
      let interim = '';
      let final = '';

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          final += result[0].transcript;
        } else {
          interim += result[0].transcript;
        }
      }

      const text = (final || interim).trim();
      if (text) {
        const entry: TranscriptEntry = {
          speaker:   'You',
          text,
          partial:   !final,
          timestamp: Date.now(),
        };
        if (final) {
          this._log('STT transcript final', { text: text.substring(0, 80) });
        }
        this._emit('transcript', entry);
      }
    };

    rec.onend = () => {
      this._sttRunning = false;
    };

    rec.onerror = (event: any) => {
      if (event.error === 'no-speech' || event.error === 'aborted') return;
      console.warn('[AudioDriverClient] SpeechRecognition error:', event.error);
      this._sttRunning = false;
    };

    return rec;
  }

  // ── Private: Event emission ─────────────────────────────────

  private _emit<K extends keyof AudioDriverEvents>(event: K, data: AudioDriverEvents[K]): void {
    const handlers = this._listeners.get(event);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(data);
        } catch (err) {
          console.error(`[AudioDriverClient] Error in ${event} handler:`, err);
        }
      }
    }
  }

  // ── Private: State builder ──────────────────────────────────

  private _buildState(): AudioDriverState {
    return {
      micRunning:     this._micRunning,
      speakerRunning: this._speakerRunning,
      running:        this._micRunning || this._speakerRunning,
      message:        this._micRunning || this._speakerRunning ? 'Capturing' : 'Off',
      mirrorActive:   this._speakerRunning,
      micName:        '',
      speakerName:    '',
    };
  }
}
