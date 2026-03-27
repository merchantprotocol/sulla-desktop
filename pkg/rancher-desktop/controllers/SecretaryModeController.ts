/**
 * SecretaryModeController — owns all decision-making for Secretary Mode.
 *
 * Runs in the renderer process. The Vue component (SecretaryMode.vue) delegates
 * to this controller for all business logic and only handles rendering + UI events.
 *
 * Responsibilities:
 *   - Session lifecycle (start/stop, mode selection)
 *   - Transcription mode routing (gateway / browser / elevenlabs)
 *   - Wake word detection state machine
 *   - Barge-in logic (audio level → cut TTS)
 *   - Audio level monitoring
 *   - Analysis loop orchestration
 *   - Gateway audio streaming (MediaRecorder → IPC)
 *
 * Does NOT own:
 *   - Vue reactive state (passed in via callbacks)
 *   - DOM rendering
 *   - IPC handler registration (that's sullaEvents.ts)
 */

import { ipcRenderer } from '@pkg/utils/ipcRenderer';

// ─── Types ──────────────────────────────────────────────────────

export interface TranscriptEntry {
  id: string;
  timestamp: Date;
  text: string;
  type: 'transcript' | 'wake-command' | 'agent-response';
  speaker?: string;
}

export interface InsightEntry {
  time: string;
  text: string;
}

export interface AgentMessage {
  id: string;
  time: string;
  text: string;
}

export interface SecretaryCallbacks {
  addEntry: (text: string, type?: TranscriptEntry['type'], speaker?: string) => void;
  setWakeWordActive: (active: boolean) => void;
  getWakeWordActive: () => boolean;
  setAudioLevel: (level: number) => void;
  setSessionDuration: (duration: string) => void;
  setIsListening: (listening: boolean) => void;
  getIsListening: () => boolean;
  setIsAnalyzing: (analyzing: boolean) => void;
  getIsMuted: () => boolean;
  getTranscript: () => TranscriptEntry[];
  addActionItem: (item: string) => void;
  getActionItems: () => string[];
  addDecision: (item: string) => void;
  getDecisions: () => string[];
  addInsight: (entry: InsightEntry) => void;
  addAgentMessage: (msg: AgentMessage) => void;
  scrollAnalysis: () => void;
  playTTS: (text: string) => Promise<void>;
  stopTTS: () => void;
  sendToChat: (prompt: string, inputSource: string) => Promise<string | null>;
}

// ─── Constants ──────────────────────────────────────────────────

const WAKE_PATTERNS = [/\bhey\s+(?:sulla|sula|soula|sola)\b/i];
const SEGMENT_DURATION = 15_000;
const ANALYSIS_INTERVAL = 30_000;
const BARGE_IN_THRESHOLD = 25;

const SECRETARY_SYSTEM_PROMPT = `You are Sulla, acting as a meeting secretary. You are listening to a live meeting transcript.

Your job:
1. IDENTIFY ACTION ITEMS — any task, to-do, or commitment someone makes. Format each on its own line prefixed with "ACTION: "
2. IDENTIFY DECISIONS — any agreement or conclusion reached. Format each on its own line prefixed with "DECISION: "
3. PROVIDE KEY INSIGHTS — brief observations about what's being discussed, context that might be useful, or things the participants should be aware of. Format each on its own line prefixed with "INSIGHT: "

Be concise. Don't repeat items you've already identified in previous analyses. Only surface NEW items from the latest transcript segment.

If there's nothing noteworthy in this segment, just say "LISTENING" and nothing else.

Do NOT respond conversationally. Do NOT summarize. Just extract the structured items.`;

// ─── Controller ─────────────────────────────────────────────────

export class SecretaryModeController {
  private cb: SecretaryCallbacks;

  // Audio state
  private mediaStream: MediaStream | null = null;
  private activeMimeType = 'audio/webm';
  private transcriptionMode = 'browser';
  private transcriptionModel = 'scribe_v2';
  private sttLanguage = 'en-US';

  // Browser STT
  private recognition: any = null;

  // ElevenLabs segmented recording
  private mediaRecorder: MediaRecorder | null = null;
  private audioChunks: Blob[] = [];
  private segmentInterval: ReturnType<typeof setInterval> | null = null;

  // Gateway streaming
  private gatewaySessionId: string | null = null;
  private gatewayStreamRecorder: MediaRecorder | null = null;
  private gatewayStreamActive = false;
  /** Whether the audio-driver is providing speaker audio */
  private audioDriverConnected = false;

  // Audio level monitoring
  private levelContext: AudioContext | null = null;
  private levelAnalyser: AnalyserNode | null = null;
  private levelInterval: ReturnType<typeof setInterval> | null = null;

  // Session timer
  private sessionStartTime = 0;
  private timerInterval: ReturnType<typeof setInterval> | null = null;

  // Analysis loop
  private analysisInterval: ReturnType<typeof setInterval> | null = null;
  private lastAnalyzedIndex = 0;
  private analysisMessageCount = 0;

  // Barge-in tracking (set by the view when TTS is active)
  private hasTTSActive = false;

  constructor(callbacks: SecretaryCallbacks) {
    this.cb = callbacks;
  }

  // ─── Session lifecycle ────────────────────────────────────────

  async startSession(): Promise<void> {
    this.transcriptionMode = await ipcRenderer.invoke('sulla-settings-get', 'audioTranscriptionMode', 'browser');
    this.transcriptionModel = await ipcRenderer.invoke('sulla-settings-get', 'audioTranscriptionModel', 'scribe_v2');
    this.sttLanguage = await ipcRenderer.invoke('sulla-settings-get', 'audioSttLanguage', 'en-US');
    const audioInputDeviceId: string = await ipcRenderer.invoke('sulla-settings-get', 'audioInputDeviceId', '');

    const audioConstraints: boolean | MediaTrackConstraints = audioInputDeviceId
      ? { deviceId: { exact: audioInputDeviceId } }
      : true;

    this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
    this.activeMimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/webm';

    this.lastAnalyzedIndex = 0;
    this.analysisMessageCount = 0;

    // For non-gateway modes, create a REST-only gateway session for GhostAgent monitoring
    if (this.transcriptionMode !== 'gateway') {
      try {
        const sessionResult = await ipcRenderer.invoke('desktop-session-start', { callerName: 'Sulla Secretary' });
        this.gatewaySessionId = sessionResult?.sessionId || null;
      } catch {
        this.gatewaySessionId = null;
      }
    }

    this.startSessionTimer();
    this.startAudioLevelMonitor();
    this.startAnalysisLoop();

    // Route to the correct transcription strategy
    if (this.transcriptionMode === 'gateway') {
      await this.startGatewayStreaming();
    } else if (this.transcriptionMode === 'browser') {
      this.startBrowserRecognition();
    } else {
      this.startElevenLabsContinuous();
    }
  }

  endSession(): void {
    this.cb.setWakeWordActive(false);
    this.cb.stopTTS();
    this.stopSessionTimer();
    this.stopAudioLevelMonitor();
    this.stopAnalysisLoop();
    this.analyzeNewTranscript();

    // Clean up agent audio playback
    this.stopAgentAudio();

    if (this.recognition) {
      try { this.recognition.abort(); } catch { /* ignore */ }
      try { this.recognition.stop(); } catch { /* ignore */ }
      this.recognition = null;
    }

    if (this.transcriptionMode === 'gateway') {
      this.stopGatewayStreaming();
    }

    if (this.segmentInterval) { clearInterval(this.segmentInterval); this.segmentInterval = null; }
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') this.mediaRecorder.stop();
    if (this.mediaStream) { this.mediaStream.getTracks().forEach(t => t.stop()); this.mediaStream = null; }
    this.mediaRecorder = null;
    this.audioChunks = [];

    // End the REST-only gateway session (non-gateway modes)
    if (this.gatewaySessionId && this.transcriptionMode !== 'gateway') {
      ipcRenderer.invoke('desktop-session-end', this.gatewaySessionId).catch((err) => {
        console.warn('[SecretaryMode] desktop-session-end failed:', err);
      });
      this.gatewaySessionId = null;
    }
  }

  dispose(): void {
    if (this.cb.getIsListening()) this.endSession();
  }

  // ─── Wake word detection ──────────────────────────────────────

  checkAndHandleWakeWord(text: string): void {
    if (this.cb.getIsMuted()) return;

    if (this.cb.getWakeWordActive()) {
      const command = text.trim();
      if (command) {
        this.cb.setWakeWordActive(false);
        this.cb.addEntry(command, 'wake-command', 'You');
        this.sendWakeCommand(command);
      }
      return;
    }

    for (const pattern of WAKE_PATTERNS) {
      const match = text.match(pattern);
      if (match) {
        const afterWake = text.slice(match.index! + match[0].length).trim();
        if (afterWake.length > 3) {
          this.cb.addEntry(afterWake, 'wake-command', 'You');
          this.sendWakeCommand(afterWake);
        } else {
          this.cb.setWakeWordActive(true);
          this.cb.addEntry('Yes?', 'agent-response', 'Sulla');
          this.cb.playTTS('Yes?');
        }
        return;
      }
    }
  }

  private async sendWakeCommand(command: string): Promise<void> {
    const prompt = `You are in secretary mode during a live meeting. The user said "Hey Sulla" and then spoke to you.

RULES:
- Reply in ONE short sentence max (under 15 words).
- If you don't understand, say exactly: "Sorry, could you say that again?"
- No narration, no elaboration, no follow-up questions.
- Be direct. Think walkie-talkie, not conversation.

User: ${command}`;

    const reply = await this.cb.sendToChat(prompt, 'secretary-command');
    if (reply) {
      this.cb.addEntry(reply, 'agent-response', 'Sulla');
      this.cb.playTTS(reply);
    }
  }

  // ─── Chat message (private text input) ────────────────────────

  async sendChatMessage(text: string): Promise<void> {
    if (!text.trim()) return;

    this.cb.addAgentMessage({
      id:   this.generateEntryId(),
      time: this.formatTimeNow(),
      text: `You: ${text}`,
    });
    this.cb.scrollAnalysis();

    const prompt = `You are in secretary mode during a live meeting. The user sent you a private text message (not spoken aloud).

RULES:
- Reply in ONE short sentence max (under 15 words).
- If you don't understand, ask them to clarify briefly.
- No narration, no elaboration.

User: ${text}`;

    const reply = await this.cb.sendToChat(prompt, 'secretary-chat');
    if (reply) {
      this.cb.addAgentMessage({
        id:   this.generateEntryId(),
        time: this.formatTimeNow(),
        text: reply,
      });
      this.cb.scrollAnalysis();
    }
  }

  // ─── Barge-in ─────────────────────────────────────────────────

  setTTSActive(active: boolean): void {
    this.hasTTSActive = active;
  }

  private checkBargeIn(level: number): void {
    if (level > BARGE_IN_THRESHOLD && this.hasTTSActive) {
      this.cb.stopTTS();
    }
  }

  // ─── Audio level monitoring ───────────────────────────────────

  private startAudioLevelMonitor(): void {
    if (!this.mediaStream) return;
    try {
      this.levelContext = new AudioContext();
      const src = this.levelContext.createMediaStreamSource(this.mediaStream);
      this.levelAnalyser = this.levelContext.createAnalyser();
      this.levelAnalyser.fftSize = 256;
      src.connect(this.levelAnalyser);
      const buf = new Uint8Array(this.levelAnalyser.fftSize);

      this.levelInterval = setInterval(() => {
        if (!this.levelAnalyser || !this.cb.getIsListening()) return;
        this.levelAnalyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
          const s = (buf[i] - 128) / 128;
          sum += s * s;
        }
        const level = Math.min(100, Math.round(Math.sqrt(sum / buf.length) * 300));
        this.cb.setAudioLevel(level);
        this.checkBargeIn(level);
      }, 50);
    } catch (err) {
      console.warn('[SecretaryMode] Audio level monitor failed to initialize:', err);
    }
  }

  private stopAudioLevelMonitor(): void {
    if (this.levelInterval) { clearInterval(this.levelInterval); this.levelInterval = null; }
    if (this.levelContext) { this.levelContext.close().catch(() => {}); this.levelContext = null; }
    this.levelAnalyser = null;
    this.cb.setAudioLevel(0);
  }

  // ─── Session timer ────────────────────────────────────────────

  private startSessionTimer(): void {
    this.sessionStartTime = Date.now();
    this.timerInterval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - this.sessionStartTime) / 1000);
      const mins = Math.floor(elapsed / 60);
      const secs = elapsed % 60;
      this.cb.setSessionDuration(`${mins}:${secs.toString().padStart(2, '0')}`);
    }, 1000);
  }

  private stopSessionTimer(): void {
    if (this.timerInterval) { clearInterval(this.timerInterval); this.timerInterval = null; }
  }

  // ─── Browser STT ─────────────────────────────────────────────

  private startBrowserRecognition(): void {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      this.transcriptionMode = 'elevenlabs';
      this.startElevenLabsContinuous();
      return;
    }

    this.recognition = new SpeechRecognition();
    this.recognition.continuous = true;
    this.recognition.interimResults = false;
    this.recognition.lang = this.sttLanguage;

    this.recognition.onresult = (event: any) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) {
          const text = event.results[i][0].transcript.trim();
          if (text) {
            this.cb.addEntry(text);
            this.checkAndHandleWakeWord(text);
          }
        }
      }
    };

    this.recognition.onend = () => {
      if (!this.cb.getIsListening()) return;
      try { this.recognition?.start(); } catch { /* already started */ }
    };

    this.recognition.onerror = (event: any) => {
      if (!this.cb.getIsListening()) return;
      if (event.error === 'no-speech') {
        try { this.recognition?.start(); } catch { /* ignore */ }
      } else if (event.error === 'network' || event.error === 'service-not-allowed' || event.error === 'not-allowed') {
        try { this.recognition?.stop(); } catch { /* ignore */ }
        this.recognition = null;
        this.transcriptionMode = 'elevenlabs';
        if (this.mediaStream) this.startElevenLabsContinuous();
      } else if (event.error !== 'aborted') {
        try { this.recognition?.start(); } catch { /* ignore */ }
      }
    };

    this.recognition.start();
  }

  // ─── ElevenLabs continuous mode ───────────────────────────────

  private startElevenLabsContinuous(): void {
    this.startElevenLabsSegment();
    this.segmentInterval = setInterval(() => {
      if (!this.cb.getIsListening()) return;
      this.flushAndRestartSegment();
    }, SEGMENT_DURATION);
  }

  private startElevenLabsSegment(): void {
    if (!this.mediaStream) return;
    this.audioChunks = [];
    this.mediaRecorder = new MediaRecorder(this.mediaStream, { mimeType: this.activeMimeType });
    this.mediaRecorder.ondataavailable = (event: BlobEvent) => {
      if (event.data.size > 0) this.audioChunks.push(event.data);
    };
    this.mediaRecorder.onstop = () => {
      const audioBlob = new Blob(this.audioChunks, { type: this.activeMimeType });
      this.audioChunks = [];
      if (audioBlob.size > 0) this.transcribeSegment(audioBlob, this.activeMimeType);
    };
    this.mediaRecorder.start();
  }

  private flushAndRestartSegment(): void {
    if (!this.mediaRecorder || this.mediaRecorder.state === 'inactive') return;
    this.mediaRecorder.stop();
    if (this.cb.getIsListening() && this.mediaStream) this.startElevenLabsSegment();
  }

  private async transcribeSegment(audioBlob: Blob, mimeType: string): Promise<void> {
    try {
      const arrayBuffer = await audioBlob.arrayBuffer();
      const result = await ipcRenderer.invoke('audio-transcribe', {
        audio: arrayBuffer, mimeType, diarize: true, model: this.transcriptionModel,
        ...(this.gatewaySessionId ? { sessionId: this.gatewaySessionId } : {}),
      });
      if (result?.text?.trim()) {
        const text = result.text.trim();
        this.cb.addEntry(text);
        this.checkAndHandleWakeWord(text);
      }
    } catch (err) {
      console.error('[SecretaryMode] Transcription failed:', err);
    }
  }

  // ─── Gateway WebSocket streaming ──────────────────────────────

  private onGatewayTranscriptBound = this.onGatewayTranscript.bind(this);

  private onGatewayTranscript(_event: any, event: { event_type: string; text?: string; speaker?: string; audio?: string; format?: string }): void {
    if (!this.cb.getIsListening()) {
      console.warn('[SecretaryMode] Received transcript but not listening — dropped');
      return;
    }

    if (event.event_type === 'transcript_turn' && event.text?.trim()) {
      const text = event.text.trim();
      const speaker = event.speaker || 'Speaker';
      console.log(`[SecretaryMode] Transcript received (${speaker}): "${text.slice(0, 80)}"`);
      this.cb.addEntry(text, 'transcript', speaker);
      this.checkAndHandleWakeWord(text);
    } else if (event.event_type === 'transcript_partial' && event.text?.trim()) {
      // Partial transcripts — could show as interim text in future
      console.log(`[SecretaryMode] Partial transcript: "${event.text.trim().slice(0, 80)}"`);
    } else if (event.event_type === 'agent_audio' && event.audio) {
      // Agent speech audio — PCM 16kHz 16-bit mono, base64-encoded
      if (!this.cb.getIsMuted()) {
        this.playAgentAudioChunk(event.audio);
      }
    } else {
      console.log(`[SecretaryMode] Unhandled gateway event: ${event.event_type}`);
    }
  }

  // ─── Agent audio playback (PCM 16kHz via Web Audio API) ────────

  private agentAudioContext: AudioContext | null = null;
  private agentAudioNextTime = 0;
  /** Track active buffer sources so we can stop them immediately on mute */
  private agentAudioSources: AudioBufferSourceNode[] = [];

  /**
   * Immediately silence all scheduled agent audio by stopping every
   * queued BufferSource and closing the AudioContext.
   */
  stopAgentAudio(): void {
    for (const src of this.agentAudioSources) {
      try { src.stop(); } catch { /* already stopped */ }
    }
    this.agentAudioSources = [];

    if (this.agentAudioContext) {
      this.agentAudioContext.close().catch(() => {});
      this.agentAudioContext = null;
      this.agentAudioNextTime = 0;
    }
  }

  private playAgentAudioChunk(base64Pcm: string): void {
    try {
      // Decode base64 → raw PCM bytes
      const raw = Uint8Array.from(atob(base64Pcm), c => c.charCodeAt(0));
      const pcm16 = new Int16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);

      // Convert Int16 PCM to Float32 for Web Audio API
      const float32 = new Float32Array(pcm16.length);
      for (let i = 0; i < pcm16.length; i++) {
        float32[i] = pcm16[i] / 32768;
      }

      // Create or reuse AudioContext
      if (!this.agentAudioContext) {
        this.agentAudioContext = new AudioContext({ sampleRate: 16000 });
        this.agentAudioNextTime = 0;
      }

      const ctx = this.agentAudioContext;
      const buffer = ctx.createBuffer(1, float32.length, 16000);
      buffer.copyToChannel(float32, 0);

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);

      // Schedule chunks back-to-back for gapless playback
      const now = ctx.currentTime;
      if (this.agentAudioNextTime < now) {
        this.agentAudioNextTime = now;
      }
      source.start(this.agentAudioNextTime);
      this.agentAudioNextTime += buffer.duration;

      // Track source for immediate stop on mute
      this.agentAudioSources.push(source);
      source.onended = () => {
        const idx = this.agentAudioSources.indexOf(source);
        if (idx !== -1) this.agentAudioSources.splice(idx, 1);
      };
    } catch (err) {
      console.warn('[SecretaryMode] Agent audio playback error:', err);
    }
  }

  private async startGatewayStreaming(): Promise<void> {
    if (!this.mediaStream) {
      throw new Error('No media stream available for gateway streaming');
    }

    // ── Connect to audio-driver for system/speaker audio ────────
    // The audio-driver captures system audio via WASAPI (Windows) or
    // CoreAudio+BlackHole (macOS) and streams labeled chunks over a
    // local Unix socket. Speaker chunks (channel 1) are forwarded
    // to the gateway automatically by the main process.
    try {
      const driverResult = await ipcRenderer.invoke('audio-driver-connect');
      this.audioDriverConnected = driverResult?.ok ?? false;
      if (this.audioDriverConnected) {
        console.log('[SecretaryMode] Connected to audio-driver for system audio (channel 1)');
      } else {
        console.log('[SecretaryMode] Audio-driver not available — speaker audio will not be captured');
      }
    } catch (err) {
      console.log('[SecretaryMode] Audio-driver connection failed:', (err as Error).message);
      this.audioDriverConnected = false;
    }

    const isMultiChannel = this.audioDriverConnected;
    console.log(`[SecretaryMode] Multi-channel mode: ${isMultiChannel}`);

    // ── Subscribe to transcript events ──────────────────────────
    await ipcRenderer.invoke('gateway-transcript-subscribe');
    ipcRenderer.on('gateway-transcript', this.onGatewayTranscriptBound);

    // ── Create gateway session ──────────────────────────────────
    const startPayload: { callerName: string; channels?: Record<string, { label: string; source: string; audioFormat?: { inputFormat: string; inputRate?: number; inputChannels?: number } }> } = {
      callerName: 'Sulla Secretary',
    };
    if (isMultiChannel) {
      startPayload.channels = {
        '0': { label: 'User', source: 'mic' },
        '1': {
          label:       'Caller',
          source:      'system_audio',
          audioFormat: { inputFormat: 's16le', inputRate: 16000, inputChannels: 1 },
        },
      };
    }

    const result = await ipcRenderer.invoke('gateway-audio-start', startPayload);
    if (result?.error || !result?.sessionId) {
      const reason = result?.error || 'no session ID returned';
      this.cb.addEntry(`Gateway audio connection failed: ${reason}`, 'transcript');
      throw new Error(`Gateway audio start failed: ${reason}`);
    }

    this.gatewaySessionId = result.sessionId;
    this.gatewayStreamActive = true;
    console.log(`[SecretaryMode] Gateway session started: ${result.sessionId}`);

    // ── Channel 0: mic audio (captured here via getUserMedia) ───
    const streamMime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/webm';

    this.gatewayStreamRecorder = new MediaRecorder(this.mediaStream, { mimeType: streamMime });
    let micChunkCount = 0;
    this.gatewayStreamRecorder.ondataavailable = async(event: BlobEvent) => {
      if (event.data.size > 0 && this.gatewayStreamActive) {
        micChunkCount++;
        if (micChunkCount <= 3 || micChunkCount % 100 === 0) {
          console.log(`[SecretaryMode] Mic chunk #${micChunkCount} (${event.data.size} bytes)`);
        }
        const arrayBuffer = await event.data.arrayBuffer();
        ipcRenderer.invoke('gateway-audio-send', { audio: arrayBuffer, channel: 0 }).catch((err) => {
          console.error('[SecretaryMode] Failed to send mic chunk:', err);
        });
      }
    };
    this.gatewayStreamRecorder.onerror = (e: Event) => {
      console.error('[SecretaryMode] Mic recorder error:', (e as any).error?.message || e);
    };
    this.gatewayStreamRecorder.start(250);
    console.log(`[SecretaryMode] Mic recorder started — mime: ${this.gatewayStreamRecorder.mimeType}`);

    // ── Channel 1: speaker audio ────────────────────────────────
    // Handled by the audio-driver → AudioDriverClient → gateway pipeline.
    // No MediaRecorder needed here — the main process forwards chunks
    // from the audio-driver socket directly to the gateway WebSocket.
    if (isMultiChannel) {
      console.log('[SecretaryMode] Speaker audio (channel 1) provided by audio-driver');
    }
  }

  private stopGatewayStreaming(): void {
    this.gatewayStreamActive = false;

    ipcRenderer.removeListener('gateway-transcript', this.onGatewayTranscriptBound);
    ipcRenderer.invoke('gateway-transcript-unsubscribe').catch((err) => {
      console.warn('[SecretaryMode] Transcript unsubscribe failed:', err);
    });

    // Stop mic recorder (channel 0)
    if (this.gatewayStreamRecorder && this.gatewayStreamRecorder.state !== 'inactive') {
      try { this.gatewayStreamRecorder.stop(); } catch (err) { console.warn('[SecretaryMode] Mic recorder stop error:', err); }
    }
    this.gatewayStreamRecorder = null;

    // Disconnect from audio-driver (speaker audio, channel 1)
    if (this.audioDriverConnected) {
      ipcRenderer.invoke('audio-driver-disconnect').catch(() => {});
      this.audioDriverConnected = false;
    }

    if (this.gatewaySessionId) {
      ipcRenderer.invoke('gateway-audio-stop').catch((err) => {
        console.error('[SecretaryMode] gateway-audio-stop failed:', err);
      });
      this.gatewaySessionId = null;
    }
  }

  // ─── Analysis loop ────────────────────────────────────────────

  private startAnalysisLoop(): void {
    this.analysisInterval = setInterval(() => {
      if (!this.cb.getIsListening()) return;
      this.analyzeNewTranscript();
    }, ANALYSIS_INTERVAL);

    setTimeout(() => {
      if (this.cb.getIsListening()) this.analyzeNewTranscript();
    }, 15_000);
  }

  private stopAnalysisLoop(): void {
    if (this.analysisInterval) {
      clearInterval(this.analysisInterval);
      this.analysisInterval = null;
    }
  }

  async analyzeNewTranscript(): Promise<void> {
    const entries = this.cb.getTranscript().slice(this.lastAnalyzedIndex);
    if (entries.length === 0) return;

    const newText = entries
      .filter(e => e.type === 'transcript')
      .map(e => `[${this.formatTime(e.timestamp)}] ${e.text}`)
      .join('\n');

    if (!newText.trim()) return;

    this.lastAnalyzedIndex = this.cb.getTranscript().length;
    this.cb.setIsAnalyzing(true);

    const isFirst = this.analysisMessageCount === 0;
    const prompt = isFirst
      ? `${SECRETARY_SYSTEM_PROMPT}\n\n--- NEW TRANSCRIPT SEGMENT ---\n${newText}`
      : `--- NEW TRANSCRIPT SEGMENT ---\n${newText}`;

    this.analysisMessageCount++;

    const reply = await this.cb.sendToChat(prompt, 'secretary-analysis');
    if (reply) {
      this.parseAnalysisResponse(reply);
    }
    this.cb.setIsAnalyzing(false);
  }

  private parseAnalysisResponse(text: string): void {
    if (!text || text.trim() === 'LISTENING') return;

    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    const time = this.formatTimeNow();
    let hasNewContent = false;

    for (const line of lines) {
      if (line.startsWith('ACTION:')) {
        const item = line.slice(7).trim();
        if (item && !this.cb.getActionItems().includes(item)) {
          this.cb.addActionItem(item);
          hasNewContent = true;
        }
      } else if (line.startsWith('DECISION:')) {
        const item = line.slice(9).trim();
        if (item && !this.cb.getDecisions().includes(item)) {
          this.cb.addDecision(item);
          hasNewContent = true;
        }
      } else if (line.startsWith('INSIGHT:')) {
        const item = line.slice(8).trim();
        if (item) {
          this.cb.addInsight({ time, text: item });
          hasNewContent = true;
        }
      } else if (line !== 'LISTENING') {
        this.cb.addAgentMessage({
          id:   this.generateEntryId(),
          time,
          text: line,
        });
        hasNewContent = true;
      }
    }

    if (hasNewContent) this.cb.scrollAnalysis();
  }

  // ─── Utility ──────────────────────────────────────────────────

  private generateEntryId(): string {
    return `se_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  }

  private formatTime(date: Date): string {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  private formatTimeNow(): string {
    return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  get currentTranscriptionMode(): string {
    return this.transcriptionMode;
  }

  get currentSessionDuration(): string {
    const elapsed = Math.floor((Date.now() - this.sessionStartTime) / 1000);
    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }
}
