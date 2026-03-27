/**
 * VoiceRecorderService — owns the microphone stream and all recording logic.
 *
 * Survives component mount/unmount cycles. The MediaStream persists across
 * stop()/start() cycles; only dispose() releases it.
 *
 * Supports three transcription modes:
 *   - 'browser': Web Speech API (SpeechRecognition) — free, real-time interim results
 *   - 'elevenlabs': Batch recording with VAD silence detection → ElevenLabs API
 *   - 'gateway': Real-time WebSocket audio streaming — gateway handles STT server-side
 */

import { TypedEventEmitter } from './TypedEventEmitter';
import { logRecordingStart, logRecordingStop, logTranscription, logTranscriptionFiltered, logVoiceError, logVADSpeechStart, logVADSilenceStart, logVADSilenceConfirmed, timingSpeechStart, timingTranscription } from './VoiceLogger';

// ─── Types ──────────────────────────────────────────────────────

export interface TranscriptionFragment {
  text: string;
  speakerId?: string;
  timestamp: number;
}

export interface VoiceRecorderEvents {
  /** VAD or SpeechRecognition detected speech starting */
  speechStart: void;
  /** Silence detected after speech (VAD threshold exceeded) */
  silence: void;
  /** Transcription fragment ready */
  fragment: TranscriptionFragment;
  /** Audio level changed (0-100, emitted ~20x/sec for level meter) */
  levelChange: number;
  /** Error occurred (mic denied, transcription failed, etc.) */
  error: string;
  /** Recording session began */
  recordingStart: void;
  /** Recording session ended */
  recordingStop: void;
}

export interface VoiceRecorderConfig {
  /** IPC invoke function — injected for decoupling from Electron globals */
  ipcInvoke: (channel: string, ...args: any[]) => Promise<any>;
}

// ─── Service ────────────────────────────────────────────────────

export class VoiceRecorderService extends TypedEventEmitter<VoiceRecorderEvents> {
  private readonly ipcInvoke: VoiceRecorderConfig['ipcInvoke'];

  // ── Public state ──
  isRecording = false;
  audioLevel = 0;
  recordingDuration = '0:00';
  transcriptionMode: 'browser' | 'elevenlabs' | 'gateway' = 'browser';
  private transcriptionModel = 'scribe_v2';

  // ── Stream & recorder ──
  private mediaStream: MediaStream | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private audioChunks: Blob[] = [];
  private activeMimeType = 'audio/webm';

  // ── Browser SpeechRecognition ──
  private recognition: any = null;
  private recognitionText = '';
  private recognitionInterim = '';
  private stopping = false;

  // ── VAD (Voice Activity Detection) ──
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private vadInterval: ReturnType<typeof setInterval> | null = null;
  private vadSilenceThreshold = 20;
  private vadSilenceDuration = 800;
  private readonly vadInitialGrace = 400;
  private silenceStart: number | null = null;
  private segmentStart = 0;
  private hasSpeechInSegment = false;

  // ── Audio level monitor (shares AudioContext with VAD) ──
  private levelInterval: ReturnType<typeof setInterval> | null = null;

  // ── Recording timer ──
  private recordingStartTime = 0;
  private recordingTimer: ReturnType<typeof setInterval> | null = null;

  // ── Gateway audio streaming ──
  private gatewayStreamRecorder: MediaRecorder | null = null;
  /** Separate MediaRecorder for system audio (channel 1) when multi-channel is active */
  private gatewaySystemRecorder: MediaRecorder | null = null;
  /** System audio MediaStream provided via setSystemAudioStream() */
  private systemAudioStream: MediaStream | null = null;
  private gatewaySessionId: string | null = null;
  private gatewayStreamActive = false;

  // ── Settings ──
  private sttLanguage = 'en-US';
  private audioInputDeviceId = '';

  constructor(config: VoiceRecorderConfig) {
    super();
    this.ipcInvoke = config.ipcInvoke;
  }

  // ─── Public API ───────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.isRecording) return;

    try {
      await this.loadSettings();
      await this.acquireStream();

      this.isRecording = true;
      this.stopping = false;
      this.startRecordingTimer();
      this.startLevelMonitor();
      logRecordingStart(this.transcriptionMode);
      this.emit('recordingStart', undefined as any);

      if (this.transcriptionMode === 'browser') {
        this.startBrowserSTT();
      } else if (this.transcriptionMode === 'gateway') {
        // Gateway mode: stream audio via WebSocket — gateway handles STT server-side
        this.startGatewayAudioStream();
      } else {
        this.startBatchSegment();
        this.startVAD();
      }
    } catch (err) {
      logVoiceError(`Start failed: ${err}`);
      this.emit('error', 'Microphone access denied or unavailable');
      this.isRecording = false;
    }
  }

  async stop(): Promise<void> {
    if (!this.isRecording) return;

    this.stopping = true;
    this.isRecording = false;
    this.stopRecordingTimer();
    this.stopLevelMonitor();

    // Browser mode: stop recognition, emit remaining text
    if (this.recognition) {
      const text = this.recognitionText.trim();
      try { this.recognition.abort(); } catch { /* ignore */ }
      try { this.recognition.stop(); } catch { /* ignore */ }
      this.recognition = null;
      if (text) {
        this.emit('fragment', { text, timestamp: Date.now() });
      }
      this.recognitionText = '';
      this.recognitionInterim = '';
    }

    // ElevenLabs/gateway mode: flush last segment
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop(); // triggers onstop → transcribe if hasSpeechInSegment
    }

    // Gateway mode: stop audio streaming
    this.stopGatewayAudioStream();

    this.stopVAD();

    // Release the microphone so the OS indicator goes away
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(t => t.stop());
      this.mediaStream = null;
    }
    if (this.audioContext) {
      this.audioContext.close().catch(() => {});
      this.audioContext = null;
    }
    this.mediaRecorder = null;
    this.audioChunks = [];

    this.stopping = false;

    logRecordingStop(this.recordingDuration);
    this.emit('recordingStop', undefined as any);
    this.emit('silence', undefined as any);
  }

  async toggle(): Promise<void> {
    if (this.isRecording) {
      await this.stop();
    } else {
      await this.start();
    }
  }

  dispose(): void {
    if (this.isRecording) {
      this.stopping = true;
      this.isRecording = false;
    }
    this.stopRecordingTimer();
    this.stopLevelMonitor();
    this.stopVAD();

    if (this.recognition) {
      try { this.recognition.abort(); } catch { /* ignore */ }
      this.recognition = null;
    }
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      try { this.mediaRecorder.stop(); } catch { /* ignore */ }
    }
    this.mediaRecorder = null;
    this.audioChunks = [];

    // Gateway audio stream cleanup
    this.stopGatewayAudioStream();

    // Release the stream — this is the only place tracks are stopped
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(t => t.stop());
      this.mediaStream = null;
    }

    this.clearAllHandlers();
  }

  // ─── Settings ─────────────────────────────────────────────────

  private async loadSettings(): Promise<void> {
    this.transcriptionMode = await this.ipcInvoke('sulla-settings-get', 'audioTranscriptionMode', 'elevenlabs');
    this.transcriptionModel = await this.ipcInvoke('sulla-settings-get', 'audioTranscriptionModel', 'scribe_v2');
    this.vadSilenceThreshold = await this.ipcInvoke('sulla-settings-get', 'audioVadSilenceThreshold', 20);
    this.vadSilenceDuration = await this.ipcInvoke('sulla-settings-get', 'audioVadSilenceDuration', 800);
    this.sttLanguage = await this.ipcInvoke('sulla-settings-get', 'audioSttLanguage', 'en-US');
    this.audioInputDeviceId = await this.ipcInvoke('sulla-settings-get', 'audioInputDeviceId', '');
  }

  // ─── Stream Acquisition ───────────────────────────────────────

  private async acquireStream(): Promise<void> {
    // Reuse existing active stream
    if (this.mediaStream && this.mediaStream.active) {
      console.log('[VoiceRecorder] Reusing existing media stream');

      return;
    }

    // Clean up stale stream
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(t => t.stop());
      this.mediaStream = null;
    }

    const audioConstraints: boolean | MediaTrackConstraints = this.audioInputDeviceId
      ? { deviceId: { exact: this.audioInputDeviceId } }
      : true;

    const getMedia = navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices)
      || ((constraints: MediaStreamConstraints) => new Promise<MediaStream>((resolve, reject) => {
        const legacy = (navigator as any).getUserMedia
          || (navigator as any).webkitGetUserMedia
          || (navigator as any).mozGetUserMedia;
        if (!legacy) {
          reject(new Error('getUserMedia is not supported'));

          return;
        }
        legacy.call(navigator, constraints, resolve, reject);
      }));

    this.mediaStream = await getMedia({ audio: audioConstraints });
    this.activeMimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/webm';
  }

  // ─── Recording Timer ──────────────────────────────────────────

  private startRecordingTimer(): void {
    this.recordingStartTime = Date.now();
    this.recordingDuration = '0:00';
    this.recordingTimer = setInterval(() => {
      const elapsed = Math.floor((Date.now() - this.recordingStartTime) / 1000);
      const mins = Math.floor(elapsed / 60);
      const secs = elapsed % 60;
      this.recordingDuration = `${ mins }:${ secs.toString().padStart(2, '0') }`;
    }, 1000);
  }

  private stopRecordingTimer(): void {
    if (this.recordingTimer) {
      clearInterval(this.recordingTimer);
      this.recordingTimer = null;
    }
    this.recordingDuration = '0:00';
  }

  // ─── Audio Level Monitor ──────────────────────────────────────

  private startLevelMonitor(): void {
    if (!this.mediaStream) return;
    // If VAD already created an AudioContext + analyser, reuse it
    // Otherwise create a dedicated one
    if (!this.audioContext || this.audioContext.state === 'closed') {
      try {
        this.audioContext = new AudioContext();
        const src = this.audioContext.createMediaStreamSource(this.mediaStream);
        this.analyser = this.audioContext.createAnalyser();
        this.analyser.fftSize = 512;
        src.connect(this.analyser);
      } catch {
        return;
      }
    }

    const buf = new Uint8Array(this.analyser!.fftSize);
    this.levelInterval = setInterval(() => {
      if (!this.analyser || !this.isRecording) return;
      this.analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) {
        const s = (buf[i] - 128) / 128;
        sum += s * s;
      }
      const level = Math.min(100, Math.round(Math.sqrt(sum / buf.length) * 300));
      if (level !== this.audioLevel) {
        this.audioLevel = level;
        this.emit('levelChange', level);
      }
    }, 50);
  }

  private stopLevelMonitor(): void {
    if (this.levelInterval) {
      clearInterval(this.levelInterval);
      this.levelInterval = null;
    }
    this.audioLevel = 0;
    this.emit('levelChange', 0);
  }

  // ─── Browser SpeechRecognition ────────────────────────────────

  private startBrowserSTT(): void {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      console.warn('[VoiceRecorder] SpeechRecognition not available, falling back to ElevenLabs');
      this.transcriptionMode = 'elevenlabs';
      this.startBatchSegment();
      this.startVAD();

      return;
    }

    this.recognition = new SpeechRecognition();
    this.recognition.continuous = true;
    this.recognition.interimResults = true;
    this.recognition.lang = this.sttLanguage;
    this.recognitionText = '';
    this.recognitionInterim = '';

    this.recognition.onresult = (event: any) => {
      let interim = '';
      let finalText = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const alt = result[0];
        const transcript = alt.transcript;
        const confidence = alt.confidence ?? 1;

        // Skip low-confidence results (hallucinated speech, noise)
        if (confidence < 0.4) {
          logTranscription(`[REJECTED low confidence=${confidence.toFixed(2)}] ${transcript}`, undefined);
          continue;
        }

        // Skip results containing primarily non-Latin characters (wrong language detection)
        if (this.sttLanguage.startsWith('en') && /[\u3000-\u9FFF\uAC00-\uD7AF]{2,}/.test(transcript)) {
          logTranscription(`[REJECTED non-English] ${transcript}`, undefined);
          continue;
        }

        if (result.isFinal) {
          finalText += transcript;
        } else {
          interim += transcript;
        }
      }
      if (finalText) {
        this.recognitionText += finalText;
      }
      this.recognitionInterim = interim;

      const displayText = (this.recognitionText + ' ' + this.recognitionInterim).trim();
      if (displayText) {
        this.emit('speechStart', undefined as any);
        timingSpeechStart();
      }
    };

    this.recognition.onend = () => {
      if (this.stopping || !this.isRecording) return;
      const text = this.recognitionText.trim();
      if (text) {
        logTranscription(text, 'browser-stt');
        timingTranscription();
        this.emit('fragment', { text, timestamp: Date.now() });
      }
      this.recognitionText = '';
      this.recognitionInterim = '';
      this.emit('silence', undefined as any);

      // Restart for next utterance
      try { this.recognition?.start(); } catch { /* already started */ }
    };

    this.recognition.onerror = (event: any) => {
      console.warn('[VoiceRecorder] SpeechRecognition error:', event.error);
      if (this.stopping || !this.isRecording) return;

      if (event.error === 'no-speech') {
        try { this.recognition?.start(); } catch { /* already started */ }
      } else if (event.error === 'network' || event.error === 'service-not-allowed' || event.error === 'not-allowed') {
        console.warn('[VoiceRecorder] Browser speech unavailable, switching to ElevenLabs');
        try { this.recognition?.stop(); } catch { /* ignore */ }
        this.recognition = null;
        this.recognitionText = '';
        this.recognitionInterim = '';
        this.transcriptionMode = 'elevenlabs';
        if (this.mediaStream) {
          this.startBatchSegment();
          this.startVAD();
        }
      } else if (event.error === 'aborted') {
        // Intentional abort — do nothing
      } else {
        try { this.recognition?.start(); } catch { /* already started */ }
      }
    };

    this.recognition.start();
  }

  // ─── ElevenLabs Batch Mode ────────────────────────────────────

  private startBatchSegment(): void {
    if (!this.mediaStream) return;

    this.audioChunks = [];
    this.hasSpeechInSegment = false;
    this.segmentStart = Date.now();
    this.silenceStart = null;

    this.mediaRecorder = new MediaRecorder(this.mediaStream, { mimeType: this.activeMimeType });

    this.mediaRecorder.ondataavailable = (event: BlobEvent) => {
      if (event.data.size > 0) {
        this.audioChunks.push(event.data);
      }
    };

    this.mediaRecorder.onstop = () => {
      const audioBlob = new Blob(this.audioChunks, { type: this.activeMimeType });
      this.audioChunks = [];
      const hadSpeech = this.hasSpeechInSegment;

      // Start next segment IMMEDIATELY so no audio is lost during transcription
      if (this.isRecording && this.mediaStream) {
        this.startBatchSegment();
      }

      if (audioBlob.size > 0 && hadSpeech) {
        this.transcribe(audioBlob, this.activeMimeType);
      }
    };

    this.mediaRecorder.start();
  }

  private async transcribe(audioBlob: Blob, mimeType: string): Promise<void> {
    try {
      const arrayBuffer = await audioBlob.arrayBuffer();
      const result = await this.ipcInvoke('audio-transcribe', { audio: arrayBuffer, mimeType, diarize: true, model: this.transcriptionModel });
      if (result?.text?.trim()) {
        const raw = result.text.trim();
        // Scribe V2 labels non-speech as [background noise], [singing], [music], etc.
        // Strip all bracketed labels and check if any real speech remains.
        const speechOnly = raw.replace(/\[.*?\]/g, '').trim();
        if (!speechOnly) {
          logTranscriptionFiltered(raw);
          // Don't emit fragment — no real speech. Still emit silence so VAD resets.
          this.emit('silence', undefined as any);
          return;
        }

        const speakerId = this.extractPrimarySpeaker(result.words);
        logTranscription(speechOnly, speakerId);
        timingTranscription();
        this.emit('fragment', { text: speechOnly, speakerId, timestamp: Date.now() });
      }
      // Emit silence AFTER transcription so the pipeline flushes with
      // the text already in the buffer (not before it arrives).
      this.emit('silence', undefined as any);
    } catch (err) {
      logVoiceError(`Transcription failed: ${err}`);
      this.emit('error', 'Transcription failed — check your ElevenLabs API key');
      // Still emit silence on error so pipeline doesn't get stuck
      this.emit('silence', undefined as any);
    }
  }

  private extractPrimarySpeaker(words?: Array<{ text: string; speaker_id?: string }>): string | undefined {
    if (!words || words.length === 0) return undefined;
    const counts = new Map<string, number>();
    for (const w of words) {
      if (w.speaker_id) {
        counts.set(w.speaker_id, (counts.get(w.speaker_id) || 0) + 1);
      }
    }
    if (counts.size === 0) return undefined;
    let best = '';
    let bestCount = 0;
    for (const [id, count] of counts) {
      if (count > bestCount) {
        best = id;
        bestCount = count;
      }
    }

    return best;
  }

  // ─── VAD (Voice Activity Detection) ───────────────────────────

  private startVAD(): void {
    if (!this.mediaStream) return;

    try {
      // Reuse AudioContext from level monitor if available
      if (!this.audioContext || this.audioContext.state === 'closed') {
        this.audioContext = new AudioContext();
        const source = this.audioContext.createMediaStreamSource(this.mediaStream);
        this.analyser = this.audioContext.createAnalyser();
        this.analyser.fftSize = 512;
        source.connect(this.analyser);
      }

      const dataArray = new Uint8Array(this.analyser!.fftSize);

      this.vadInterval = setInterval(() => {
        if (!this.analyser || !this.isRecording) return;

        this.analyser.getByteTimeDomainData(dataArray);

        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
          const sample = (dataArray[i] - 128) / 128;
          sum += sample * sample;
        }
        const rms = Math.sqrt(sum / dataArray.length) * 100;

        const now = Date.now();
        const elapsed = now - this.segmentStart;

        if (rms >= this.vadSilenceThreshold) {
          this.silenceStart = null;
          if (!this.hasSpeechInSegment) {
            this.hasSpeechInSegment = true;
            logVADSpeechStart(rms, this.vadSilenceThreshold);
            // Notify that user started speaking — triggers barge-in if TTS is playing
            this.emit('speechStart', undefined as any);
            timingSpeechStart();
          }
        } else if (this.hasSpeechInSegment) {
          if (this.silenceStart === null) {
            this.silenceStart = now;
            logVADSilenceStart(rms, this.vadSilenceThreshold);
          } else if (elapsed > this.vadInitialGrace && (now - this.silenceStart) >= this.vadSilenceDuration) {
            logVADSilenceConfirmed(now - this.silenceStart);
            this.flushBatchSegment();
          }
        }
      }, 100);
    } catch (err) {
      console.warn('[VoiceRecorder] VAD setup failed:', err);
    }
  }

  private flushBatchSegment(): void {
    if (!this.mediaRecorder || this.mediaRecorder.state === 'inactive') return;
    console.log('[VoiceRecorder] VAD: silence detected, flushing segment');
    this.mediaRecorder.stop(); // triggers onstop → transcribe
    // NOTE: silence is NOT emitted here — it's emitted after transcription
    // completes in transcribe(), so the pipeline flushes AFTER the text
    // is in the buffer, not before.
  }

  private stopVAD(): void {
    if (this.vadInterval) {
      clearInterval(this.vadInterval);
      this.vadInterval = null;
    }
    if (this.audioContext) {
      this.audioContext.close().catch(() => {});
      this.audioContext = null;
    }
    this.analyser = null;
    this.silenceStart = null;
  }

  // ─── Gateway Audio Streaming ────────────────────────────────

  /**
   * Provide a system audio MediaStream for multi-channel gateway streaming.
   * Call this before startGatewayAudioStream() to enable dual-channel mode.
   * Channel 0 = mic (this.mediaStream), Channel 1 = system audio.
   *
   * When not set, falls back to single-channel mono (backward compatible).
   */
  setSystemAudioStream(stream: MediaStream | null): void {
    this.systemAudioStream = stream;
    console.log(`[VoiceRecorder] System audio stream ${stream ? 'set' : 'cleared'}`);
  }

  /**
   * Start streaming audio to the gateway.
   * Creates a session, opens the audio WebSocket, and starts MediaRecorder(s)
   * with a timeslice so chunks are sent continuously.
   *
   * When systemAudioStream is set, opens a multi-channel session:
   *   - Channel 0: mic audio (this.mediaStream)
   *   - Channel 1: system audio (this.systemAudioStream)
   * Otherwise, single-channel mono (original behavior).
   */
  private async startGatewayAudioStream(): Promise<void> {
    if (!this.mediaStream) return;

    const isMultiChannel = !!this.systemAudioStream;

    try {
      // Build channel map for multi-channel sessions
      const startPayload: { callerName: string; channels?: Record<string, { label: string; source: string }> } = {
        callerName: 'Sulla Desktop',
      };

      if (isMultiChannel) {
        startPayload.channels = {
          '0': { label: 'User', source: 'mic' },
          '1': { label: 'Caller', source: 'system_audio' },
        };
      }

      // Create session + open audio WebSocket on main process
      const result = await this.ipcInvoke('gateway-audio-start', startPayload);
      if (result?.error || !result?.sessionId) {
        console.warn('[VoiceRecorder] Gateway audio start failed:', result?.error);
        return;
      }

      this.gatewaySessionId = result.sessionId;
      this.gatewayStreamActive = true;
      console.log(`[VoiceRecorder] Gateway audio stream started, session: ${result.sessionId}, multiChannel: ${isMultiChannel}`);

      const streamMime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm';

      // Channel 0: mic audio
      this.gatewayStreamRecorder = new MediaRecorder(this.mediaStream, { mimeType: streamMime });
      this.gatewayStreamRecorder.ondataavailable = async(event: BlobEvent) => {
        if (event.data.size > 0 && this.gatewayStreamActive) {
          const arrayBuffer = await event.data.arrayBuffer();
          // Channel 0 — no tag needed (backward compatible)
          this.ipcInvoke('gateway-audio-send', { audio: arrayBuffer, channel: 0 }).catch(() => {});
        }
      };
      this.gatewayStreamRecorder.start(250);

      // Channel 1: system audio (only when multi-channel)
      if (isMultiChannel && this.systemAudioStream) {
        this.gatewaySystemRecorder = new MediaRecorder(this.systemAudioStream, { mimeType: streamMime });
        this.gatewaySystemRecorder.ondataavailable = async(event: BlobEvent) => {
          if (event.data.size > 0 && this.gatewayStreamActive) {
            const arrayBuffer = await event.data.arrayBuffer();
            this.ipcInvoke('gateway-audio-send', { audio: arrayBuffer, channel: 1 }).catch(() => {});
          }
        };
        this.gatewaySystemRecorder.start(250);
        console.log('[VoiceRecorder] System audio recorder started (channel 1)');
      }
    } catch (err) {
      console.error('[VoiceRecorder] Gateway audio stream error:', err);
      this.gatewayStreamActive = false;
    }
  }

  /**
   * Stop the gateway audio stream and clean up.
   */
  private stopGatewayAudioStream(): void {
    this.gatewayStreamActive = false;

    // Stop mic recorder (channel 0)
    if (this.gatewayStreamRecorder && this.gatewayStreamRecorder.state !== 'inactive') {
      try { this.gatewayStreamRecorder.stop(); } catch { /* ignore */ }
    }
    this.gatewayStreamRecorder = null;

    // Stop system audio recorder (channel 1)
    if (this.gatewaySystemRecorder && this.gatewaySystemRecorder.state !== 'inactive') {
      try { this.gatewaySystemRecorder.stop(); } catch { /* ignore */ }
    }
    this.gatewaySystemRecorder = null;

    if (this.gatewaySessionId) {
      this.ipcInvoke('gateway-audio-stop').catch(() => {});
      this.gatewaySessionId = null;
    }
  }
}
