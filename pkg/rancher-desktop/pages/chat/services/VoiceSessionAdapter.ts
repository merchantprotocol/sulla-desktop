/*
  VoiceSessionAdapter — bridges the mic + whisper + TTS pipeline into the
  ChatController world for ONE chat tab.

  Two ways to talk, same pipeline:

    • Hands-free (mic button / ⌘/) — the audio driver's VAD decides when you
      stopped talking; whisper's `utterance_end` commits each utterance.
    • Hold-to-talk (hold Space) — works like Sulla Mobile's PTT: hold to talk,
      release to send. Pauses never end the turn, the whole hold is one message,
      and starting to talk cuts Sulla off. Driven by usePushToTalk via
      controller.voiceCommand('ptt-*'):
        ptt-arm      key down  → mic + whisper start silently (hides mic spin-up)
        ptt-activate held past threshold → stop TTS, show the recording UI
        ptt-end      key up    → transcribe the whole hold, send it as one message
        ptt-cancel   tap / Esc / window blur → discard

  Ending a turn is graceful: `audio-driver:transcribe-finish` transcribes
  everything captured and emits the final transcript + utterance_end before
  stopping, so the last words are never dropped.

  Everything arrives on this tab's controller bus (voiceCommand /
  speakRequested) — never window events: all chat tabs stay mounted, so a
  window event made every tab start its mic or speak the same reply.

  Only one voice session is live at a time across tabs (whisper and the mic
  are app-wide singletons); starting one ends any other.

  TTS: PersonaAdapter forwards backend `speak` payloads via
  controller.requestSpeak → speak() → TTSPlayerService. playbackStart appends a
  TtsMessage + sets voice.phase='playing', queueEmpty clears it.
*/

import { newMessageId, type MessageId } from '../types/chat';

import {
  TTSPlayerService,
  createVoiceBargeInDetector,
  createVoiceTurnAccumulator,
} from '@pkg/composables/voice';
import { logBargeIn } from '@pkg/composables/voice/VoiceLogger';
import { ipcRenderer as _ipcRenderer } from '@pkg/utils/ipcRenderer';

import type { ChatController } from '../controller/ChatController';
import type { VoiceCommand } from '../controller/events';
import type { InterimMessage, TtsMessage } from '../models/Message';

const ipcRenderer = _ipcRenderer as any;

/** Window-level TTS suppression toggle mirrored from the old path. */
declare global {
  interface Window {
    __sullaTTSDisabled?: boolean;
  }
}

export interface VoiceSessionAdapterOptions {
  /** Surfaces recoverable errors (missing whisper model, mic permission, …). */
  onError?:  (message: string) => void;
  /** Is this adapter's tab the one on screen? Background tabs never speak. Default: yes. */
  isActive?: () => boolean;
}

// Fallback commit delay (ms). PRIMARY end-of-turn trigger is the main-process
// `utterance_end` event (VAD silence + drained pipeline); this is only a safety net
// for when that signal never arrives. Long on purpose — the old 2000ms collided with
// whisper's 2000ms chunk cadence and split utterances into separate agent turns.
const UTTERANCE_FALLBACK_MS = 8000;

// Hold-to-talk shorter than this after activation is a slip, not a message
// (Sulla Mobile's MIN_RECORDING_MS).
export const PTT_MIN_HOLD_MS = 500;

// After release, keep the mic open this long so the last syllable (still in the
// capture/processing pipeline) makes it into the transcript.
const PTT_RELEASE_TAIL_MS = 180;

type Mode = 'handsfree' | 'ptt';

// The one adapter whose mic/whisper session is live (whisper + mic are singletons).
let liveAdapter: VoiceSessionAdapter | null = null;

export class VoiceSessionAdapter {
  private readonly controller: ChatController;
  private readonly onError?:   (message: string) => void;
  private readonly isActive:   () => boolean;

  private readonly tts: TTSPlayerService;

  private unsubs: (() => void)[] = [];

  // Session state — tracked locally, mirrored into controller.voice.
  private mode: Mode | null = null;
  /** Mic + whisper are running (armed or live). */
  private capturing = false;
  /** The session is visible (recording UI) — false while a PTT press is only armed. */
  private active = false;
  /** Released; waiting for the final transcript before sending. */
  private finishing = false;
  private startPromise: Promise<boolean> | null = null;
  /** Bumped on every teardown so a late async start can tell it was abandoned. */
  private generation = 0;

  private interimId: MessageId | null = null;
  private recordingStartedAt = 0;
  private lastLevel = 0;
  private lastSpeaking = false;

  private readonly bargeIn = createVoiceBargeInDetector();

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

  // Bound IPC listeners so we can unregister on teardown.
  private readonly onTranscript = (_event: any, msg: any) => {
    if (!this.capturing && !this.finishing) return;
    this.turn.handleEvent(msg);
  };

  private readonly onMicVad = (_event: any, data: { speaking: boolean; level: number }) => {
    if (!this.capturing) return;
    this.lastLevel = Math.max(0, Math.min(1, data.level));
    this.lastSpeaking = !!data.speaking;

    // Hands-free barge-in: sustained speech while Sulla talks stops her.
    // (Hold-to-talk stops TTS outright on activation.)
    if (this.mode === 'handsfree' && this.bargeIn.update(this.lastSpeaking, this.tts.isPlaying)) {
      logBargeIn();
      this.tts.stop();
    }

    const v = this.controller.voice.value;
    if (v.phase !== 'recording' || v.finishing) return;
    this.controller.setVoice({
      ...v,
      level:    this.lastLevel,
      speaking: this.lastSpeaking,
    });
  };

  constructor(controller: ChatController, opts: VoiceSessionAdapterOptions = {}) {
    this.controller = controller;
    this.onError = opts.onError;
    this.isActive = opts.isActive ?? (() => true);

    this.tts = new TTSPlayerService({
      ipcInvoke: ipcRenderer.invoke.bind(ipcRenderer),
    });

    this.unsubs.push(
      this.tts.on('playbackStart', () => this.handleTtsStart()),
      this.tts.on('queueEmpty', () => this.handleTtsEnd()),
      controller.on('voiceCommand', e => this.handleCommand(e.command)),
      controller.on('speakRequested', e => this.speak(e.text)),
      // The transcript's "stop" button (TtsIndicator) and Esc only flip controller
      // state — actually silence the audio.
      controller.on('ttsStopped', () => {
        if (this.tts.isPlaying || this.tts.queueLength > 0) this.tts.stop();
      }),
    );
  }

  // ─── Commands ─────────────────────────────────────────────────────

  private handleCommand(command: VoiceCommand): void {
    const run = (p: Promise<void>) => p.catch((err) => {
      console.error(`[VoiceSessionAdapter] ${ command } failed`, err);
      this.onError?.('Voice capture failed.');
    });

    switch (command) {
    case 'toggle':       void run(this.toggle()); break;
    case 'ptt-arm':      void run(this.pttArm()); break;
    case 'ptt-activate': this.pttActivate(); break;
    case 'ptt-end':      void run(this.pttEnd()); break;
    case 'ptt-cancel':   this.pttCancel(); break;
    }
  }

  // ─── Hands-free ───────────────────────────────────────────────────

  async toggle(): Promise<void> {
    if (this.finishing) return;
    if (this.capturing) await this.stop(true);
    else await this.start();
  }

  async start(): Promise<void> {
    if (this.capturing || this.finishing) return;
    // Opening the mic to talk cuts Sulla off now — don't wait for VAD barge-in.
    this.tts.stop();
    this.mode = 'handsfree';
    this.activate();
    await this.beginCapture(false);
  }

  /**
   * Stop listening.
   * @param commit  when true, transcribe and send what was said so far;
   *                when false, drop it.
   */
  async stop(commit = true): Promise<void> {
    if (!this.capturing || this.finishing) return;
    if (commit && this.active) await this.finishTurn();
    else this.teardown();
  }

  // ─── Hold-to-talk ─────────────────────────────────────────────────

  /** Key down: start mic + whisper silently so they're live by the time the hold registers. */
  private async pttArm(): Promise<void> {
    // Hands-free already listening, or a previous turn still transcribing — leave it be.
    if (this.capturing || this.finishing) return;
    this.mode = 'ptt';
    await this.beginCapture(true);
  }

  /** Held past the tap threshold: this is a real turn. */
  private pttActivate(): void {
    if (this.mode !== 'ptt' || !this.capturing || this.active) return;
    // Talking over Sulla cuts her off, like Sulla Mobile.
    this.tts.stop();
    this.activate();
  }

  /** Key up: send the whole hold as one message (or drop a slip). */
  private async pttEnd(): Promise<void> {
    if (this.mode !== 'ptt' || !this.capturing || this.finishing) return;
    if (!this.active || Date.now() - this.recordingStartedAt < PTT_MIN_HOLD_MS) {
      this.teardown();
      return;
    }
    await this.finishTurn();
  }

  private pttCancel(): void {
    if (this.mode !== 'ptt' || !this.capturing || this.finishing) return;
    this.teardown();
  }

  // ─── Session plumbing ─────────────────────────────────────────────

  /** Show the recording UI (interim bubble + controller voice state). */
  private activate(): void {
    this.active = true;
    this.recordingStartedAt = Date.now();
    this.spawnInterim();
  }

  /** Start mic + whisper. `ptt` = raw mic, and the turn ends only on finish. */
  private beginCapture(ptt: boolean): Promise<boolean> {
    if (liveAdapter && liveAdapter !== this) liveAdapter.teardown();
    liveAdapter = this;

    this.capturing = true;
    this.turn.reset();
    this.bargeIn.reset();
    this.lastLevel = 0;
    this.lastSpeaking = false;

    ipcRenderer.on('gateway-transcript', this.onTranscript);
    ipcRenderer.on('audio-driver:mic-vad', this.onMicVad);
    // A reply is coming — have the voice warm by the time it arrives.
    this.tts.prepare();

    const gen = this.generation;

    this.startPromise = (async() => {
      try {
        await ipcRenderer.invoke('audio-driver:start-mic', 'voice-chat', ['pcm-s16le']);
        if (gen !== this.generation) return false;
        const whisperResult = await ipcRenderer.invoke('audio-driver:transcribe-start', {
          mode:       'conversation',
          manualTurn: ptt,
        });
        if (gen !== this.generation) return false;
        if (!whisperResult?.ok) {
          this.onError?.('Failed to start transcription. Check that whisper is installed with a model downloaded.');
          this.teardown();
          return false;
        }
        return true;
      } catch (err) {
        console.error('[VoiceSessionAdapter] start failed', err);
        if (gen === this.generation) {
          this.onError?.('Voice capture failed to start.');
          this.teardown();
        }
        return false;
      }
    })();

    return this.startPromise;
  }

  /**
   * Graceful end of turn: let the tail of speech land, have whisper transcribe
   * everything captured (final transcript_turn + utterance_end → commitTurn →
   * send), then release the mic.
   */
  private async finishTurn(): Promise<void> {
    const gen = this.generation;
    const started = await this.startPromise;

    if (gen !== this.generation) return;
    if (!started) {
      this.teardown();
      return;
    }

    this.finishing = true;
    const v = this.controller.voice.value;
    if (v.phase === 'recording') this.controller.setVoice({ ...v, finishing: true, speaking: false });

    await new Promise(r => setTimeout(r, PTT_RELEASE_TAIL_MS));
    this.capturing = false;
    try {
      await ipcRenderer.invoke('audio-driver:transcribe-finish');
    } catch (err) {
      console.warn('[VoiceSessionAdapter] transcribe-finish failed', err);
    }
    if (gen !== this.generation) return;
    // utterance_end normally committed already; this sends anything left if it never came.
    this.turn.commitNow();
    this.teardown();
  }

  /** Stop everything and discard whatever wasn't committed. Safe to call repeatedly. */
  private teardown(): void {
    const wasCapturing = this.capturing || this.finishing;

    this.generation++;
    this.capturing = false;
    this.finishing = false;
    this.active = false;
    this.startPromise = null;
    this.bargeIn.reset();
    this.turn.reset();

    ipcRenderer.removeListener('gateway-transcript', this.onTranscript);
    ipcRenderer.removeListener('audio-driver:mic-vad', this.onMicVad);

    if (this.interimId) {
      this.controller.removeMessage(this.interimId);
      this.interimId = null;
    }
    if (this.controller.voice.value.phase === 'recording') this.controller.stopVoice(false);

    if (wasCapturing) {
      // Release the mic / whisper — fire-and-forget (both are no-ops when already stopped).
      ipcRenderer.invoke('audio-driver:transcribe-stop').catch(() => { /* noop */ });
      ipcRenderer.invoke('audio-driver:stop-mic', 'voice-chat').catch(() => { /* noop */ });
    }
    if (liveAdapter === this) liveAdapter = null;
    this.mode = null;
  }

  /** Create a fresh interim bubble and mark the voice UI as recording. */
  private spawnInterim(): void {
    const interim: InterimMessage = {
      id:        newMessageId(),
      kind:      'interim',
      createdAt: Date.now(),
      text:      '',
      startedAt: this.recordingStartedAt,
    };
    this.interimId = interim.id;
    this.controller.appendMessage(interim);
    this.controller.setVoice({
      phase:            'recording',
      startedAt:        this.recordingStartedAt,
      interimMessageId: interim.id,
      level:            0,
      speaking:         false,
      ptt:              this.mode === 'ptt',
    });
  }

  dispose(): void {
    this.teardown();
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
    this.tts.dispose();
    if (this.activeTtsMessageId) {
      this.controller.removeMessage(this.activeTtsMessageId);
      this.activeTtsMessageId = null;
    }
  }

  // ─── Whisper transcript ───────────────────────────────────────────

  private updateInterim(text: string): void {
    if (!this.interimId) return;
    this.controller.updateMessage<InterimMessage>(this.interimId, { text });
  }

  /** Commit one finished turn (from utterance_end or finish). `text` may be empty. */
  private commitTurn(text: string): void {
    // A PTT press that never activated (a tap) sends nothing.
    if (!this.active) return;

    // Remove the interim bubble; controller.send() will append the real user message.
    if (this.interimId) {
      this.controller.removeMessage(this.interimId);
      this.interimId = null;
    }

    // Mark voice idle — a fresh interim will spawn if the user keeps talking.
    this.controller.stopVoice(true);

    // Tagged as voice so the reply comes back in voice mode (<speak> → TTS).
    if (text) this.controller.send(text, [], { inputSource: 'voice' });

    // Hands-free and still listening? Spin up a fresh interim bubble for the next utterance.
    if (this.capturing && this.mode === 'handsfree') {
      this.recordingStartedAt = Date.now();
      this.spawnInterim();
    }
  }

  // ─── TTS ──────────────────────────────────────────────────────────

  /** Enqueue text for spoken playback. Caller decides *what* gets spoken. */
  speak(text: string, messageId?: string): void {
    if (window.__sullaTTSDisabled) return;
    if (!text?.trim()) return;
    // Only the conversation on screen — or the one you're talking to by voice —
    // gets a voice. Background tabs stay silent.
    if (!this.isActive() && liveAdapter !== this) return;
    // Holding Space means "I'm talking" — don't talk over the user.
    if (this.mode === 'ptt' && this.active && !this.finishing) return;
    this.tts.enqueue(text.trim(), messageId ?? `speak_${ Date.now() }`);
  }

  /** Stop any in-flight TTS playback. */
  stopTTS(): void {
    this.tts.stop();
  }

  /** The tab went to the background: silence it unless it owns the live voice session. */
  handleDeactivated(): void {
    if (liveAdapter === this) return;
    if (this.tts.isPlaying || this.tts.queueLength > 0) this.tts.stop();
  }

  private handleTtsStart(): void {
    this.bargeIn.reset();
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

    // Don't hide a live recording UI behind the playing state.
    if (this.controller.voice.value.phase === 'recording') return;
    this.controller.setVoice({
      phase:     'playing',
      refId:     this.activeTtsMessageId,
      startedAt: Date.now(),
    });
  }

  private handleTtsEnd(): void {
    this.bargeIn.reset();
    const id = this.activeTtsMessageId;
    this.activeTtsMessageId = null;
    if (id) this.controller.removeMessage(id);
    if (this.controller.voice.value.phase === 'playing') {
      this.controller.stopTTS(id ?? undefined);
    }
    if (this.capturing && this.active && this.interimId && this.controller.voice.value.phase !== 'recording') {
      this.controller.setVoice({
        phase:            'recording',
        startedAt:        this.recordingStartedAt,
        interimMessageId: this.interimId,
        level:            this.lastLevel,
        speaking:         this.lastSpeaking,
        ptt:              this.mode === 'ptt',
      });
    }
  }
}
