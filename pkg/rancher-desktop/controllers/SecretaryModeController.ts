/**
 * SecretaryModeController — owns all decision-making for Secretary Mode.
 *
 * Runs in the renderer process. The Vue component (SecretaryMode.vue) delegates
 * to this controller for all business logic and only handles rendering + UI events.
 *
 * All mic audio goes through MicrophoneDriverController (tray panel renderer).
 * Transcription uses the whisper.cpp pipeline via audio-driver IPC.
 * No local getUserMedia — the controller's VAD provides audio levels.
 *
 * Responsibilities:
 *   - Session lifecycle (start/stop)
 *   - Transcription via whisper (audio-driver pipeline)
 *   - Wake word detection state machine
 *   - Barge-in logic (audio level → cut TTS)
 *   - Audio level monitoring (from controller VAD)
 *   - Analysis loop orchestration
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
  updateLastEntry: (text: string) => void;
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
  private sttLanguage = 'en-US';

  // Gateway session (for GhostAgent monitoring — REST only, no streaming)
  private gatewaySessionId: string | null = null;

  // Audio level monitoring (from controller VAD)
  private vadHandler: ((_event: any, data: any) => void) | null = null;

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
    const rawLang: string = await ipcRenderer.invoke('sulla-settings-get', 'audioSttLanguage', 'en');
    // Whisper uses ISO 639-1 codes (e.g. 'en'), not locale codes (e.g. 'en-US')
    this.sttLanguage = rawLang.split('-')[0];

    // Start mic via the MicrophoneDriverController (ref-counted).
    // Request pcm-s16le so the tray panel starts PCM capture for whisper.
    await ipcRenderer.invoke('audio-driver:start-mic', 'secretary-mode', ['webm-opus', 'pcm-s16le']);

    // Start speaker capture for system audio monitoring
    try {
      await ipcRenderer.invoke('audio-driver:start-speaker', 'secretary-mode');
    } catch (err) {
      console.warn('[SecretaryMode] Speaker capture failed:', (err as Error).message);
    }

    this.lastAnalyzedIndex = 0;
    this.analysisMessageCount = 0;

    // Create a REST-only gateway session for GhostAgent monitoring
    try {
      const sessionResult = await ipcRenderer.invoke('desktop-session-start', { callerName: 'Sulla Secretary' });
      this.gatewaySessionId = sessionResult?.sessionId || null;
    } catch {
      this.gatewaySessionId = null;
    }

    this.startSessionTimer();
    this.startAudioLevelMonitor();
    this.startAnalysisLoop();

    // Start whisper transcription via the controller pipeline
    await this.startWhisperTranscription();
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

    // Stop whisper transcription
    this.stopWhisperTranscription();

    // Release mic and speaker via the controllers (ref-counted)
    ipcRenderer.invoke('audio-driver:stop-mic', 'secretary-mode').catch((err) => {
      console.warn('[SecretaryMode] stop-mic failed:', err);
    });
    ipcRenderer.invoke('audio-driver:stop-speaker', 'secretary-mode').catch((err) => {
      console.warn('[SecretaryMode] stop-speaker failed:', err);
    });

    // End the REST-only gateway session
    if (this.gatewaySessionId) {
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
      if (pattern.test(text)) {
        this.cb.setWakeWordActive(true);
        break;
      }
    }
  }

  private async sendWakeCommand(command: string): Promise<void> {
    const response = await this.cb.sendToChat(command, 'secretary-wake');
    if (response) {
      const agentMsg: AgentMessage = {
        id:   `agent-${Date.now()}`,
        time: new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
        text: response,
      };
      this.cb.addAgentMessage(agentMsg);
      this.cb.addEntry(response, 'agent-response', 'Sulla');
      this.cb.scrollAnalysis();

      if (!this.cb.getIsMuted()) {
        await this.cb.playTTS(response);
      }
    }
  }

  private checkBargeIn(level: number): void {
    if (level > BARGE_IN_THRESHOLD && this.hasTTSActive) {
      this.cb.stopTTS();
    }
  }

  // ─── Audio level monitoring (from controller VAD) ─────────────

  private startAudioLevelMonitor(): void {
    // Listen for VAD events from the MicrophoneDriverController.
    // The controller sends audio-driver:mic-vad to all holders.
    this.vadHandler = (_event: any, data: any) => {
      if (!data || !this.cb.getIsListening()) return;
      const level = Math.min(100, Math.round((data.level ?? 0) * 300));
      this.cb.setAudioLevel(level);
      this.checkBargeIn(level);
    };
    ipcRenderer.on('audio-driver:mic-vad', this.vadHandler);
  }

  private stopAudioLevelMonitor(): void {
    if (this.vadHandler) {
      ipcRenderer.removeListener('audio-driver:mic-vad', this.vadHandler);
      this.vadHandler = null;
    }
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

  // ─── Turn-taking accumulator ───────────────────────────────────
  // Combines consecutive transcripts from the same speaker into a
  // single entry. A new entry is created when:
  //   - The speaker changes (mic → speaker or vice versa)
  //   - A long pause occurs (>5 seconds between transcripts)

  private currentTurnSpeaker: string | null = null;
  private lastTranscriptTime = 0;
  private static readonly PAUSE_THRESHOLD_MS = 5000;

  private appendOrCreateEntry(text: string, speaker: string): void {
    const now = Date.now();
    const pauseMs = now - this.lastTranscriptTime;
    this.lastTranscriptTime = now;

    const sameSpeaker = speaker === this.currentTurnSpeaker;
    const longPause = pauseMs > SecretaryModeController.PAUSE_THRESHOLD_MS;

    if (sameSpeaker && !longPause) {
      // Same speaker, no long pause — append to current entry
      const transcript = this.cb.getTranscript();
      const last = transcript[transcript.length - 1];
      if (last && last.speaker === speaker && last.type === 'transcript') {
        // Add paragraph break on moderate pauses (>2s), otherwise space
        const separator = pauseMs > 2000 ? '\n\n' : ' ';
        last.text += separator + text;
        // Trigger reactivity by replacing the entry
        this.cb.updateLastEntry(last.text);
        return;
      }
    }

    // New speaker or long pause — create new entry
    this.currentTurnSpeaker = speaker;
    this.cb.addEntry(text, 'transcript', speaker);
  }

  // ─── Whisper STT (internal transcription) ─────────────────────

  private whisperTranscriptHandler: ((_event: any, msg: any) => void) | null = null;

  private async startWhisperTranscription(): Promise<void> {
    // Start whisper in secretary mode so both mic (channel 0) and speaker
    // (channel 1) audio are transcribed. The speaker pipeline feeds
    // whisperTranscribe.feedSpeaker() from lifecycle.ts.
    const result = await ipcRenderer.invoke('audio-driver:transcribe-start', {
      mode: 'secretary',
      language: this.sttLanguage,
    });

    if (!result?.ok) {
      console.error('[SecretaryMode] Whisper transcription failed to start');
      return;
    }

    // Listen for transcript events from whisper — both mic and speaker channels
    this.whisperTranscriptHandler = (_event: any, msg: any) => {
      if (!msg?.text || !this.cb.getIsListening()) return;
      const text = msg.text.trim();
      if (!text) return;
      if (msg.event_type !== 'transcript_partial') {
        const speaker = msg.speaker === 'Speaker' ? 'Caller' : 'You';
        this.appendOrCreateEntry(text, speaker);
        this.checkAndHandleWakeWord(text);
      }
    };
    ipcRenderer.on('gateway-transcript', this.whisperTranscriptHandler);
    console.log('[SecretaryMode] Whisper transcription started (secretary mode — mic + speaker)');
  }

  private stopWhisperTranscription(): void {
    if (this.whisperTranscriptHandler) {
      ipcRenderer.removeListener('gateway-transcript', this.whisperTranscriptHandler);
      this.whisperTranscriptHandler = null;
    }
    ipcRenderer.invoke('audio-driver:transcribe-stop').catch(() => {});
  }

  // ─── Agent audio playback (PCM 16kHz via Web Audio API) ────────

  private agentAudioContext: AudioContext | null = null;
  private agentAudioNextTime = 0;
  private agentAudioSources: AudioBufferSourceNode[] = [];

  stopAgentAudio(): void {
    for (const src of this.agentAudioSources) {
      try { src.stop(); } catch { /* already stopped */ }
    }
    this.agentAudioSources = [];

    if (this.agentAudioContext) {
      this.agentAudioContext.close().catch(() => {});
      this.agentAudioContext = null;
    }
    this.agentAudioNextTime = 0;
  }

  private playAgentAudioChunk(base64Audio: string): void {
    try {
      if (!this.agentAudioContext) {
        this.agentAudioContext = new AudioContext({ sampleRate: 16000 });
        this.agentAudioNextTime = 0;
      }
      const ctx = this.agentAudioContext;

      const raw = atob(base64Audio);
      const samples = raw.length / 2;
      const audioBuffer = ctx.createBuffer(1, samples, 16000);
      const channelData = audioBuffer.getChannelData(0);
      for (let i = 0; i < samples; i++) {
        const lo = raw.charCodeAt(i * 2);
        const hi = raw.charCodeAt(i * 2 + 1);
        const sample = (hi << 8) | lo;
        channelData[i] = (sample >= 0x8000 ? sample - 0x10000 : sample) / 32768;
      }

      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(ctx.destination);

      const now = ctx.currentTime;
      const startTime = Math.max(now, this.agentAudioNextTime);
      source.start(startTime);
      this.agentAudioNextTime = startTime + audioBuffer.duration;

      this.agentAudioSources.push(source);
      source.onended = () => {
        const idx = this.agentAudioSources.indexOf(source);
        if (idx !== -1) this.agentAudioSources.splice(idx, 1);
      };
    } catch (err) {
      console.warn('[SecretaryMode] Agent audio playback error:', err);
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

  private async analyzeNewTranscript(): Promise<void> {
    const transcript = this.cb.getTranscript();
    if (transcript.length <= this.lastAnalyzedIndex) return;

    const newEntries = transcript.slice(this.lastAnalyzedIndex);
    this.lastAnalyzedIndex = transcript.length;

    const newText = newEntries.map(e => e.text).join('\n');
    if (!newText.trim() || newText.trim().length < 20) return;

    this.analysisMessageCount++;
    const analysisId = this.analysisMessageCount;
    const fullTranscript = transcript.map(e => e.text).join('\n');

    this.cb.setIsAnalyzing(true);

    const prompt = `Analysis #${analysisId}\n\nFull transcript so far:\n---\n${fullTranscript}\n---\n\nNew segment to analyze:\n---\n${newText}\n---`;

    try {
      const response = await this.cb.sendToChat(prompt, 'secretary-analysis');
      if (response) {
        const lines = response.split('\n').map(l => l.trim()).filter(Boolean);
        const time = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

        for (const line of lines) {
          if (/^ACTION:\s*/i.test(line)) {
            this.cb.addActionItem(line.replace(/^ACTION:\s*/i, ''));
          } else if (/^DECISION:\s*/i.test(line)) {
            this.cb.addDecision(line.replace(/^DECISION:\s*/i, ''));
          } else if (/^INSIGHT:\s*/i.test(line)) {
            this.cb.addInsight({ time, text: line.replace(/^INSIGHT:\s*/i, '') });
          }
        }

        this.cb.scrollAnalysis();
      }
    } catch (err) {
      console.warn('[SecretaryMode] Analysis failed:', err);
    } finally {
      this.cb.setIsAnalyzing(false);
    }
  }

  setTTSActive(active: boolean): void {
    this.hasTTSActive = active;
  }
}
