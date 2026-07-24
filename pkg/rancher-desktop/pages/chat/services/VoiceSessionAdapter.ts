/*
  VoiceSessionAdapter — bridges the existing mic + whisper + TTS pipeline
  (same IPC surface that `useVoiceSession` talks to) into the new
  ChatController world.

  The old composable owned both the audio plumbing and the message model
  (it pushes/pops `voice_interim` messages into an ad-hoc messages ref).
  The new chat is controller-first, so this adapter speaks the controller
  vocabulary instead — InterimMessage / TtsMessage / setVoice / send.

  Flow:
    1. toggle() → starts mic (pcm-s16le) + whisper transcribe-start.
    2. As transcript events stream in, an InterimMessage is appended to
       the transcript and kept in sync; level meter updates voice.level.
    3. Silence for SILENCE_SEND_DELAY → final transcript is committed via
       controller.send(). PersonaAdapter then handles the backend round-trip.
    4. User toggles off early → current transcript is committed if present,
       otherwise voice state is cleared and the interim removed.
    5. Sulla speaks → whoever has the text (PersonaAdapter's speak listener,
       for example) calls adapter.speak(text) → TTSPlayerService drains its
       queue; playbackStart appends a TtsMessage + sets voice.phase='playing',
       queueEmpty resets.

  This adapter DOES NOT pull in ChatInterface — it talks directly to the
  audio-driver IPC surface the same way `useVoiceSession` does. Keeping
  our own copy of that tiny plumbing is cheaper than smuggling a
  ChatInterface shim through useVoiceSession just to steal its semantics.

  TTS flow end-to-end:
    PersonaAdapter subscribes to ci.onSpeakDispatch, dispatches
    `chat:speak` window events with the text. This adapter listens for
    those events and pushes into the TTS queue. playbackStart appends a
    TtsMessage + sets voice.phase='playing', queueEmpty clears.
*/

import { ipcRenderer as _ipcRenderer } from '@pkg/utils/ipcRenderer';

import { TTSPlayerService, createVoiceTurnAccumulator } from '@pkg/composables/voice';

import type { ChatController } from '../controller/ChatController';
import type { InterimMessage, TtsMessage } from '../models/Message';
import { newMessageId, type MessageId } from '../types/chat';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ipcRenderer = _ipcRenderer as any;

/** Window-level TTS suppression toggle mirrored from the old path. */
declare global {
  interface Window {
    __sullaTTSDisabled?: boolean;
  }
}

export interface VoiceSessionAdapterOptions {
  /** Channel this adapter reports speak events against. */
  channelId?: string;
  /** Surfaces recoverable errors (missing whisper model, mic permission, …). */
  onError?: (message: string) => void;
}

// Fallback commit delay (ms). PRIMARY end-of-turn trigger is the main-process
// `utterance_end` event (VAD silence + drained pipeline); this is only a safety net
// for when that signal never arrives. Long on purpose — the old 2000ms collided with
// whisper's 2000ms chunk cadence and split utterances into separate agent turns.
const UTTERANCE_FALLBACK_MS = 8000;

export class VoiceSessionAdapter {
  private readonly controller: ChatController;
  private readonly onError?: (message: string) => void;

  private readonly tts: TTSPlayerService;

  private unsubs: Array<() => void> = [];

  // Recording state — tracked locally, mirrored into controller.voice.
  private recording = false;
  private interimId: MessageId | null = null;

  // Shared turn accumulation (partials → interim, transcript_turn → text, utterance_end →
  // commit). Same module the classic chat uses, so both surfaces behave identically.
  private readonly turn = createVoiceTurnAccumulator({
    onInterim:    text => this.updateInterim(text),
    onCommit:     text => this.commitTurn(text),
    isTTSPlaying: () => this.tts.isPlaying,
    fallbackMs:   UTTERANCE_FALLBACK_MS,
  });

  // TTS transcript bubble — one active at a time.
  private activeTtsMessageId: MessageId | null = null;

  // Bound IPC listeners so we can unregister on dispose().
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly onTranscript = (_event: any, msg: any) => this.handleTranscript(msg);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly onMicVad = (_event: any, data: { speaking: boolean; level: number }) => {
    if (!this.recording) return;
    const v = this.controller.voice.value;
    if (v.phase !== 'recording') return;
    this.controller.setVoice({
      ...v,
      level:    Math.max(0, Math.min(1, data.level)),
      speaking: !!data.speaking,
    });
  };

  // Window-level ⌘/ shortcut bridge.
  private readonly onWindowVoiceToggle = () => { void this.toggle(); };

  // Speak bridge — PersonaAdapter listens for backend `speak` events
  // and re-dispatches them as this window event. We pick them up and
  // push the text into the TTS queue.
  private readonly onWindowSpeak = (ev: Event) => {
    const text = (ev as CustomEvent<string>).detail;
    if (typeof text === 'string' && text.trim()) this.speak(text);
  };

  constructor(controller: ChatController, opts: VoiceSessionAdapterOptions = {}) {
    this.controller = controller;
    this.onError = opts.onError;

    this.tts = new TTSPlayerService({
      ipcInvoke: ipcRenderer.invoke.bind(ipcRenderer),
    });

    this.unsubs.push(
      this.tts.on('playbackStart', () => this.handleTtsStart()),
      this.tts.on('queueEmpty',    () => this.handleTtsEnd()),
    );

    window.addEventListener('chat:voice-toggle', this.onWindowVoiceToggle);
    window.addEventListener('chat:speak', this.onWindowSpeak as EventListener);
  }

  // ─── Public API ───────────────────────────────────────────────────

  async toggle(): Promise<void> {
    if (this.recording) this.stop(true);
    else                await this.start();
  }

  async start(): Promise<void> {
    if (this.recording) return;
    this.recording = true;
    this.turn.reset();

    // Drop in an interim message the transcript can render while we listen.
    this.spawnInterim();

    try {
      await ipcRenderer.invoke('audio-driver:start-mic', 'voice-chat', ['pcm-s16le']);
      const whisperResult = await ipcRenderer.invoke('audio-driver:transcribe-start', {
        mode: 'conversation',
      });
      if (!whisperResult?.ok) {
        this.onError?.('Failed to start transcription. Check that whisper is installed with a model downloaded.');
        this.stop(false);
        return;
      }
    } catch (err) {
      console.error('[VoiceSessionAdapter] start failed', err);
      this.onError?.('Voice capture failed to start.');
      this.stop(false);
      return;
    }

    ipcRenderer.on('gateway-transcript',       this.onTranscript);
    ipcRenderer.on('audio-driver:mic-vad',     this.onMicVad);
  }

  /**
   * Stop recording.
   * @param commit  when true, send whatever transcript has accumulated;
   *                when false, drop it.
   */
  stop(commit: boolean = true): void {
    if (!this.recording) return;
    this.recording = false;

    ipcRenderer.removeListener('gateway-transcript',    this.onTranscript);
    ipcRenderer.removeListener('audio-driver:mic-vad',  this.onMicVad);

    // recording is already false, so commitTurn() below won't re-spawn an interim.
    if (commit) {
      // Commit any accumulated turn as one message (also removes interim + stopVoice).
      this.turn.commitNow();
    } else {
      this.turn.reset();
      if (this.interimId) {
        this.controller.removeMessage(this.interimId);
        this.interimId = null;
      }
      this.controller.stopVoice(false);
    }

    // Release the mic / whisper — fire-and-forget.
    ipcRenderer.invoke('audio-driver:transcribe-stop').catch(() => { /* noop */ });
    ipcRenderer.invoke('audio-driver:stop-mic', 'voice-chat').catch(() => { /* noop */ });
  }

  /** Create a fresh interim bubble and mark the voice UI as recording. */
  private spawnInterim(): void {
    const interim: InterimMessage = {
      id:        newMessageId(),
      kind:      'interim',
      createdAt: Date.now(),
      text:      '',
      startedAt: Date.now(),
    };
    this.interimId = interim.id;
    this.controller.appendMessage(interim);
    this.controller.setVoice({
      phase:            'recording',
      startedAt:        Date.now(),
      interimMessageId: interim.id,
      level:            0,
      speaking:         false,
    });
  }

  dispose(): void {
    this.stop(false);
    window.removeEventListener('chat:voice-toggle', this.onWindowVoiceToggle);
    window.removeEventListener('chat:speak', this.onWindowSpeak as EventListener);
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
    this.tts.dispose();
    if (this.activeTtsMessageId) {
      this.controller.removeMessage(this.activeTtsMessageId);
      this.activeTtsMessageId = null;
    }
  }

  // ─── Whisper transcript ───────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handleTranscript(msg: any): void {
    if (!this.recording) return;
    this.turn.handleEvent(msg);
  }

  private updateInterim(text: string): void {
    if (!this.interimId) return;
    this.controller.updateMessage<InterimMessage>(this.interimId, { text });
  }

  /** Commit one finished turn (from utterance_end or stop). `text` may be empty. */
  private commitTurn(text: string): void {
    // Remove the interim bubble; controller.send() will append the real user message.
    if (this.interimId) {
      this.controller.removeMessage(this.interimId);
      this.interimId = null;
    }

    // Mark voice idle — a fresh interim will spawn if the user keeps talking.
    this.controller.stopVoice(true);

    if (text) this.controller.send(text);

    // Still holding the mic? Spin up a fresh interim bubble for the next utterance.
    if (this.recording) this.spawnInterim();
  }

  // ─── TTS ──────────────────────────────────────────────────────────

  /** Enqueue text for spoken playback. Caller decides *what* gets spoken. */
  speak(text: string, messageId?: string): void {
    if (window.__sullaTTSDisabled) return;
    if (!text?.trim()) return;
    this.tts.enqueue(text.trim(), messageId ?? `speak_${ Date.now() }`);
  }

  /** Stop any in-flight TTS playback. */
  stopTTS(): void {
    this.tts.stop();
  }

  private handleTtsStart(): void {
    // If we already have a TTS bubble in the transcript we leave it alone —
    // TTSPlayerService fires playbackStart for every sentence in the queue.
    if (!this.activeTtsMessageId) {
      const msg: TtsMessage = {
        id:        newMessageId(),
        kind:      'tts',
        createdAt: Date.now(),
        text:      '',
      };
      this.activeTtsMessageId = msg.id;
      this.controller.appendMessage(msg);
    }

    this.controller.setVoice({
      phase:     'playing',
      refId:     this.activeTtsMessageId,
      startedAt: Date.now(),
    });
  }

  private handleTtsEnd(): void {
    const id = this.activeTtsMessageId;
    this.activeTtsMessageId = null;
    if (id) this.controller.removeMessage(id);
    if (this.controller.voice.value.phase === 'playing') {
      this.controller.stopTTS(id ?? undefined);
    }
  }
}
