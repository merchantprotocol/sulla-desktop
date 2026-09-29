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

import { parseSecretaryAnalysis } from '@pkg/agent/controllers/SecretaryExtractor';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

// ─── Types ──────────────────────────────────────────────────────

export interface TranscriptEntry {
  id:        string;
  timestamp: Date;
  text:      string;
  type:      'transcript' | 'wake-command' | 'agent-response';
  speaker?:  string;
}

export interface InsightEntry {
  time: string;
  text: string;
}

export interface AgentMessage {
  id:   string;
  time: string;
  text: string;
}

export interface SecretaryCallbacks {
  addEntry:           (text: string, type?: TranscriptEntry['type'], speaker?: string) => void;
  updateLastEntry:    (text: string) => void;
  setWakeWordActive:  (active: boolean) => void;
  getWakeWordActive:  () => boolean;
  setAudioLevel:      (level: number) => void;
  setSessionDuration: (duration: string) => void;
  setIsListening:     (listening: boolean) => void;
  getIsListening:     () => boolean;
  setIsAnalyzing:     (analyzing: boolean) => void;
  getIsMuted:         () => boolean;
  getTranscript:      () => TranscriptEntry[];
  addActionItem:      (item: string) => void;
  getActionItems:     () => string[];
  addDecision:        (item: string) => void;
  getDecisions:       () => string[];
  addInsight:         (entry: InsightEntry) => void;
  addAgentMessage:    (msg: AgentMessage) => void;
  scrollAnalysis:     () => void;
  playTTS:            (text: string) => Promise<void>;
  stopTTS:            () => void;
  sendToChat:         (prompt: string, inputSource: string) => Promise<string | null>;
  /** Non-fatal problem the user should know about (e.g. only the mic is captured). */
  setWarning?:        (message: string | null) => void;
}

// ─── Constants ──────────────────────────────────────────────────

const WAKE_PATTERNS = [/\bhey\s+(?:sulla|sula|soula|sola)\b/i];
const ANALYSIS_INTERVAL = 30_000;
const BARGE_IN_THRESHOLD = 25;
// Whisper delivers ~2s chunks, so a spoken command after the wake word usually
// spans several transcripts. Collect them until the speaker pauses this long.
const WAKE_COMMAND_SETTLE_MS = 2_500;
// Transcript context sent with each analysis. The new segment is always sent in
// full; this caps the "so far" part so long meetings don't grow without bound.
const ANALYSIS_CONTEXT_CHARS = 12_000;

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
  private analysisInFlight = false;
  private analysisPending = false;
  private seenAnalysisItems = new Set<string>();

  // Wake command being collected across transcript chunks
  private wakeCommandParts: string[] = [];
  private wakeCommandTimer: ReturnType<typeof setTimeout> | null = null;

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
    const mic = await ipcRenderer.invoke('audio-driver:start-mic', 'secretary-mode', ['webm-opus', 'pcm-s16le']);
    if (mic && !mic.ok) {
      throw new Error(mic.error === 'microphone-permission-denied'
        ? 'Microphone access denied — allow Sulla Desktop in System Settings → Privacy & Security → Microphone.'
        : `Microphone failed to start${ mic.error ? `: ${ mic.error }` : '' }`);
    }

    // Start speaker capture for system audio monitoring
    this.cb.setWarning?.(null);
    try {
      await ipcRenderer.invoke('audio-driver:start-speaker', 'secretary-mode');
    } catch (err) {
      console.warn('[SecretaryMode] Speaker capture failed:', (err as Error).message);
      this.cb.setWarning?.('System audio capture failed — only your microphone is being transcribed. Other participants may be missing.');
    }

    this.lastAnalyzedIndex = 0;
    this.analysisMessageCount = 0;
    this.analysisPending = false;
    this.seenAnalysisItems.clear();
    this.clearWakeCommand();

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

    // Start whisper transcription via the controller pipeline. Without it the
    // session would sit on "Listening..." and never produce a transcript.
    if (!await this.startWhisperTranscription()) {
      this.endSession();
      throw new Error('Transcription could not start — check that whisper and a speech model are installed in Audio settings.');
    }
  }

  endSession(): void {
    this.clearWakeCommand();
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

  // Muting only silences Sulla's voice — the person driving Sulla can still
  // give commands from the mic; answers then show as text only.
  checkAndHandleWakeWord(text: string): void {
    if (this.cb.getWakeWordActive()) {
      this.queueWakeCommandText(text);
      return;
    }

    for (const pattern of WAKE_PATTERNS) {
      const match = pattern.exec(text);
      if (match) {
        this.cb.setWakeWordActive(true);
        // "Hey Sulla, what's on my calendar?" — the command can start in the
        // same chunk as the wake word.
        this.queueWakeCommandText(text.slice(match.index + match[0].length));
        break;
      }
    }
  }

  private queueWakeCommandText(text: string): void {
    const part = text.replace(/^[\s,.!?:;-]+/, '').trim();
    if (!part) return;

    this.wakeCommandParts.push(part);
    if (this.wakeCommandTimer) clearTimeout(this.wakeCommandTimer);
    this.wakeCommandTimer = setTimeout(() => this.flushWakeCommand(), WAKE_COMMAND_SETTLE_MS);
  }

  private flushWakeCommand(): void {
    const command = this.wakeCommandParts.join(' ').trim();
    this.clearWakeCommand();
    this.cb.setWakeWordActive(false);
    if (!command) return;

    this.cb.addEntry(command, 'wake-command', 'You');
    this.sendWakeCommand(command);
  }

  private clearWakeCommand(): void {
    if (this.wakeCommandTimer) { clearTimeout(this.wakeCommandTimer); this.wakeCommandTimer = null }
    this.wakeCommandParts = [];
  }

  /**
   * Private message typed into the Secretary tab. Kept out of the meeting
   * transcript (so it never feeds analysis) and never spoken aloud.
   */
  async sendChatMessage(text: string): Promise<void> {
    const message = text.trim();
    if (!message) return;

    this.cb.addAgentMessage(this.makeAgentMessage(`You: ${ message }`));
    this.cb.scrollAnalysis();

    const response = await this.cb.sendToChat(message, 'secretary-chat');
    this.cb.addAgentMessage(this.makeAgentMessage(response ?? 'No reply from Sulla (timed out).'));
    this.cb.scrollAnalysis();
  }

  private makeAgentMessage(text: string): AgentMessage {
    return {
      id:   `agent-${ Date.now() }-${ Math.random().toString(36).slice(2, 6) }`,
      time: new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
      text,
    };
  }

  private async sendWakeCommand(command: string): Promise<void> {
    const response = await this.cb.sendToChat(command, 'secretary-wake');
    if (response) {
      this.cb.addAgentMessage(this.makeAgentMessage(response));
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
      this.cb.setSessionDuration(`${ mins }:${ secs.toString().padStart(2, '0') }`);
    }, 1000);
  }

  private stopSessionTimer(): void {
    if (this.timerInterval) { clearInterval(this.timerInterval); this.timerInterval = null }
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
      if (last?.speaker === speaker && last.type === 'transcript') {
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

  private async startWhisperTranscription(): Promise<boolean> {
    // Start whisper in secretary mode so both mic (channel 0) and speaker
    // (channel 1) audio are transcribed. The speaker pipeline feeds
    // whisperTranscribe.feedSpeaker() from lifecycle.ts.
    const result = await ipcRenderer.invoke('audio-driver:transcribe-start', {
      mode:     'secretary',
      language: this.sttLanguage,
    });

    if (!result?.ok) {
      console.error('[SecretaryMode] Whisper transcription failed to start');
      return false;
    }

    // Listen for transcript events from whisper — both mic and speaker channels
    this.whisperTranscriptHandler = (_event: any, msg: any) => {
      if (!msg?.text || !this.cb.getIsListening()) return;
      const text = msg.text.trim();
      if (!text) return;
      if (msg.event_type !== 'transcript_partial') {
        const speaker = msg.speaker === 'Speaker' ? 'Caller' : 'You';
        this.appendOrCreateEntry(text, speaker);
        // Only the user's own mic can address Sulla — a remote participant
        // saying "hey Sulla" must not be able to command the agent.
        if (speaker === 'You') this.checkAndHandleWakeWord(text);
      }
    };
    ipcRenderer.on('gateway-transcript', this.whisperTranscriptHandler);
    console.log('[SecretaryMode] Whisper transcription started (secretary mode — mic + speaker)');

    return true;
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
      try { src.stop() } catch { /* already stopped */ }
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
    // One analysis at a time. A slow model would otherwise stack requests on
    // the same thread and each reply could be read by the wrong waiter.
    if (this.analysisInFlight) {
      this.analysisPending = true;
      return;
    }

    const transcript = this.cb.getTranscript();
    if (transcript.length <= this.lastAnalyzedIndex) return;

    const newEntries = transcript.slice(this.lastAnalyzedIndex);
    this.lastAnalyzedIndex = transcript.length;

    const newText = newEntries.map(formatTranscriptLine).join('\n');
    if (newEntries.map(e => e.text).join(' ').trim().length < 20) return;

    this.analysisMessageCount++;
    const analysisId = this.analysisMessageCount;
    const fullTranscript = tail(transcript.map(formatTranscriptLine).join('\n'), ANALYSIS_CONTEXT_CHARS);

    this.analysisInFlight = true;
    this.cb.setIsAnalyzing(true);

    const captured = [...this.cb.getActionItems(), ...this.cb.getDecisions()];
    const capturedBlock = captured.length ? `\n\nAlready captured (do not repeat):\n${ captured.map(i => `- ${ i }`).join('\n') }` : '';
    const prompt = `Analysis #${ analysisId }\n\nFull transcript so far:\n---\n${ fullTranscript }\n---\n\nNew segment to analyze:\n---\n${ newText }\n---${ capturedBlock }`;

    try {
      const response = await this.cb.sendToChat(prompt, 'secretary-analysis');
      const analysis = response ? parseSecretaryAnalysis(response) : null;
      if (analysis) {
        const time = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

        for (const item of analysis.actions) {
          if (this.isNewItem('action', item)) this.cb.addActionItem(item);
        }
        for (const item of analysis.decisions) {
          if (this.isNewItem('decision', item)) this.cb.addDecision(item);
        }
        for (const item of [...analysis.facts, ...analysis.conclusions]) {
          if (this.isNewItem('insight', item)) this.cb.addInsight({ time, text: item });
        }

        this.cb.scrollAnalysis();
      }
    } catch (err) {
      console.warn('[SecretaryMode] Analysis failed:', err);
    } finally {
      this.analysisInFlight = false;
      this.cb.setIsAnalyzing(false);
      if (this.analysisPending) {
        this.analysisPending = false;
        void this.analyzeNewTranscript();
      }
    }
  }

  private isNewItem(kind: string, text: string): boolean {
    const key = `${ kind }:${ text.toLowerCase().replace(/\s+/g, ' ').trim() }`;
    if (this.seenAnalysisItems.has(key)) return false;
    this.seenAnalysisItems.add(key);

    return true;
  }

  setTTSActive(active: boolean): void {
    this.hasTTSActive = active;
  }
}

// ─── Helpers ────────────────────────────────────────────────────

function formatTranscriptLine(entry: TranscriptEntry): string {
  return `${ entry.speaker || 'Speaker' }: ${ entry.text }`;
}

function tail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(text.length - maxChars);
  const lineStart = cut.indexOf('\n');

  return `[…earlier transcript omitted…]\n${ lineStart >= 0 ? cut.slice(lineStart + 1) : cut }`;
}

export interface MeetingNotes {
  startedAt:     Date;
  duration:      string;
  transcript:    TranscriptEntry[];
  actionItems:   string[];
  decisions:     string[];
  insights:      InsightEntry[];
  agentMessages: AgentMessage[];
}

/** File name for a session's notes, e.g. "2026-09-28-2105-meeting.md" (local time). */
export function meetingNotesFileName(startedAt: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');

  return `${ startedAt.getFullYear() }-${ pad(startedAt.getMonth() + 1) }-${ pad(startedAt.getDate()) }-${ pad(startedAt.getHours()) }${ pad(startedAt.getMinutes()) }-meeting.md`;
}

/** Render a session as markdown for the saved meeting notes file. */
export function buildMeetingNotesMarkdown(notes: MeetingNotes): string {
  const list = (items: string[]) => (items.length ? items.map(i => `- ${ i }`).join('\n') : '_None captured._');
  const time = (d: Date) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const lines = [
    `# Meeting notes — ${ notes.startedAt.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) }`,
    '',
    `Duration: ${ notes.duration }`,
    '',
    '## Action items',
    list(notes.actionItems),
    '',
    '## Decisions',
    list(notes.decisions),
    '',
    '## Insights',
    list(notes.insights.map(i => i.text)),
  ];

  if (notes.agentMessages.length) {
    lines.push('', '## Sulla', notes.agentMessages.map(m => `- ${ m.time } — ${ m.text }`).join('\n'));
  }

  lines.push('', '## Transcript');
  lines.push(notes.transcript.length
    ? notes.transcript.map(e => `**${ e.speaker || 'Speaker' }** (${ time(e.timestamp) }): ${ e.text }`).join('\n\n')
    : '_No speech transcribed._');

  return `${ lines.join('\n') }\n`;
}
