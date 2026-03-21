/**
 * VoicePipeline — orchestrator / state machine.
 *
 * Coordinates VoiceRecorderService, TTSPlayerService, and ChatInterface.
 * State machine: IDLE → LISTENING → THINKING → SPEAKING
 *
 * Responsibilities:
 *  - Fragment accumulation & turn detection (silence, speaker change, time-based)
 *  - Interim bubble management (creates/updates/removes voice_interim messages)
 *  - Speak event handling → enqueues TTS
 *  - Barge-in coordination (user speaks during TTS → stop TTS)
 *  - Turn correlation (filters stale speak events after barge-in)
 *  - Secretary analysis parsing
 *
 * TTS Detection: `handleSpeakEvent()` receives speak events directly from
 * AgentPersonaModel via ChatInterface.onSpeakDispatch(). This bypasses the
 * messages array deep watcher for lower latency. Turn correlation uses the
 * pipelineSequence to filter stale events from aborted graph runs.
 */

import { watch, nextTick, type Ref, type WatchStopHandle } from 'vue';
import type { ChatInterface, ChatMessage } from '../../pages/agent/ChatInterface';
import type { VoiceRecorderService, TranscriptionFragment } from './VoiceRecorderService';
import type { TTSPlayerService } from './TTSPlayerService';
import { logPipelineState, logBargeIn, logSilence, logFlush, logSpeakerChange, logSpeakDetected, timingFlush, timingFirstSpeak } from './VoiceLogger';

// ─── Types ──────────────────────────────────────────────────────

export type VoiceMode = 'voice' | 'secretary' | 'intake';
export type PipelineState = 'IDLE' | 'LISTENING' | 'THINKING' | 'SPEAKING';

export interface VoicePipelineConfig {
  recorder: VoiceRecorderService;
  ttsPlayer: TTSPlayerService;
  chatController: ChatInterface;
  messages: Ref<ChatMessage[]>;
  mode: Ref<VoiceMode>;
  flushIntervalMs?: Partial<Record<VoiceMode, number>>;
}

// ─── Constants ──────────────────────────────────────────────────

const VOICE_INTERIM_MSG_ID = '__voice_interim__';

const DEFAULT_FLUSH_INTERVALS: Record<VoiceMode, number> = {
  voice:     5_000,  // Safety backstop — primary flush is silence-after-transcription
  secretary: 30_000,
  intake:    15_000,
};

// ─── Pipeline ───────────────────────────────────────────────────

export class VoicePipeline {
  private readonly recorder: VoiceRecorderService;
  private readonly ttsPlayer: TTSPlayerService;
  private readonly chatController: ChatInterface;
  private readonly messages: Ref<ChatMessage[]>;
  private readonly mode: Ref<VoiceMode>;
  private readonly flushIntervalMs: Partial<Record<VoiceMode, number>>;

  // ── State ──
  state: PipelineState = 'IDLE';
  accumulatedText = '';
  currentSequence = 0;

  // ── Internal ──
  private readonly buffer: string[] = [];
  private currentSpeaker: string | null = null;
  private activeGraphRunSequence: number | null = null;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  // ── Subscriptions ──
  private readonly unsubs: Array<() => void> = [];
  private readonly watchers: WatchStopHandle[] = [];

  constructor(config: VoicePipelineConfig) {
    this.recorder = config.recorder;
    this.ttsPlayer = config.ttsPlayer;
    this.chatController = config.chatController;
    this.messages = config.messages;
    this.mode = config.mode;
    this.flushIntervalMs = config.flushIntervalMs ?? {};
  }

  // ─── Public API ───────────────────────────────────────────────

  /**
   * Subscribes to recorder events (speech/silence/fragment), TTS events (queueEmpty),
   * direct speak delivery via ChatInterface.onSpeakDispatch(), and Vue watchers
   * (graphRunning, mode).
   */
  start(): void {
    // Subscribe to recorder events
    this.unsubs.push(
      this.recorder.on('speechStart', () => this.handleSpeechStart()),
      this.recorder.on('silence', () => this.handleSilence()),
      this.recorder.on('fragment', (f) => this.handleFragment(f)),
    );

    // Subscribe to TTS events
    this.unsubs.push(
      this.ttsPlayer.on('queueEmpty', () => this.handleTTSComplete()),
    );

    // Direct speak event delivery — bypasses messages array deep watcher
    this.unsubs.push(
      this.chatController.onSpeakDispatch((text, _threadId, pipelineSequence) => {
        this.handleSpeakEvent(text, pipelineSequence);
      }),
    );

    // Watch graphRunning
    const { graphRunning } = this.chatController;
    this.watchers.push(
      watch(graphRunning, (running, wasRunning) => {
        if (wasRunning && !running) {
          this.handleGraphComplete();
        }
      }),
    );

    // Watch mode changes → restart flush timer
    this.watchers.push(
      watch(this.mode, () => {
        if (this.state === 'LISTENING') {
          this.startFlushTimer();
        }
      }),
    );

  }

  stop(): void {
    // Unsubscribe from events
    for (const unsub of this.unsubs) unsub();
    this.unsubs.length = 0;

    // Stop watchers
    for (const stop of this.watchers) stop();
    this.watchers.length = 0;

    this.stopFlushTimer();
    this.buffer.length = 0;
    this.accumulatedText = '';
    this.state = 'IDLE';
  }

  /**
   * Flushes accumulated voice buffer as a user message. Sets the chatController
   * query and calls send() with inputSource='microphone' and voiceMode. Increments
   * sequence counter. Aborts any in-progress graph run (barge-in).
   */
  flush(): void {
    if (this.disposed) return;
    if (this.buffer.length === 0) return;

    this.currentSequence++;
    const seq = this.currentSequence;

    const text = this.buffer.splice(0).join(' ').trim();
    this.accumulatedText = '';
    if (!text) return;

    logFlush(seq, this.mode.value, text);
    timingFlush(seq);

    // If a graph run is active, abort it (barge-in)
    if (this.activeGraphRunSequence !== null) {
      console.log(`[VoicePipeline] Aborting previous graph run (seq=${this.activeGraphRunSequence})`);
      this.chatController.stop();
    }

    this.activeGraphRunSequence = seq;
    this.removeInterimBubble();

    // Set query and send
    this.chatController.query.value = text;
    nextTick(() => {
      this.chatController.send({
        inputSource:       'microphone',
        voiceMode:         this.mode.value,
        pipelineSequence:  seq,
      });
    });

    this.transitionTo('THINKING');
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
  }

  // ─── State Machine ────────────────────────────────────────────

  private transitionTo(newState: PipelineState): void {
    const oldState = this.state;
    if (oldState === newState) return;
    logPipelineState(oldState, newState);
    this.state = newState;

    if (newState === 'LISTENING') {
      this.startFlushTimer();
    } else {
      this.stopFlushTimer();
    }
  }

  // ─── Event Handlers ───────────────────────────────────────────

  /**
   * Called when VAD detects speech. Implements barge-in: if state is SPEAKING
   * or THINKING, stops TTS and aborts graph run. Transitions from IDLE to LISTENING.
   */
  private handleSpeechStart(): void {
    if (this.disposed) return;

    // Barge-in: user started speaking while TTS is playing OR thinking
    // Dump ALL queued TTS immediately — the user didn't hear those messages
    if (this.state === 'SPEAKING' || this.state === 'THINKING') {
      logBargeIn();
      this.ttsPlayer.stop();
      // Also abort any in-progress graph run — user is interrupting
      if (this.activeGraphRunSequence !== null) {
        this.chatController.stop();
        this.activeGraphRunSequence = null;
      }
      this.transitionTo('LISTENING');

      return;
    }

    if (this.state === 'IDLE') {
      this.transitionTo('LISTENING');
    }
  }

  /**
   * Called when VAD detects silence after speech. In voice mode, triggers
   * flush() to send accumulated text.
   */
  private handleSilence(): void {
    if (this.disposed) return;

    if (this.mode.value === 'voice' && this.buffer.length > 0 && this.state === 'LISTENING') {
      logSilence();
      this.flush();
    }
  }

  /**
   * Called when a transcription fragment arrives. Detects speaker changes
   * (flush on change). Accumulates text in buffer. Updates the interim voice bubble.
   */
  private handleFragment(fragment: TranscriptionFragment): void {
    if (this.disposed) return;
    if (!fragment.text.trim()) return;

    // Speaker change detection → flush before appending
    if (fragment.speakerId && this.currentSpeaker && fragment.speakerId !== this.currentSpeaker) {
      logSpeakerChange(this.currentSpeaker, fragment.speakerId);
      if (this.buffer.length > 0 && this.state === 'LISTENING') {
        this.flush();
      }
    }

    if (fragment.speakerId) {
      this.currentSpeaker = fragment.speakerId;
    }

    if (this.state === 'IDLE') {
      this.transitionTo('LISTENING');
    }

    this.buffer.push(fragment.text.trim());
    this.accumulatedText = this.buffer.join(' ').trim();
    this.updateInterimBubble(this.accumulatedText);
  }

  /**
   * Called when the LLM graph run finishes. Transitions THINKING -> IDLE
   * or LISTENING (if buffer has content).
   */
  private handleGraphComplete(): void {
    if (this.disposed) return;
    this.activeGraphRunSequence = null;

    if (this.state === 'THINKING') {
      if (this.mode.value === 'voice') {
        // Delay transition: speak_dispatch events arrive via WebSocket after
        // graphRunning flips false. Give them time to land before going IDLE.
        // If a speak event arrives during this window, handleSpeakEvent()
        // transitions to SPEAKING, and this callback becomes a no-op.
        setTimeout(() => {
          if (this.disposed) return;
          if (this.state === 'THINKING' && this.ttsPlayer.queueLength === 0) {
            this.transitionTo(this.buffer.length > 0 ? 'LISTENING' : 'IDLE');
          }
        }, 300);
      } else {
        this.transitionTo(this.buffer.length > 0 ? 'LISTENING' : 'IDLE');
      }
    }
  }

  /**
   * Called when TTS queue empties. Transitions SPEAKING -> IDLE or LISTENING.
   */
  private handleTTSComplete(): void {
    if (this.disposed) return;
    if (this.state === 'SPEAKING') {
      this.transitionTo(this.buffer.length > 0 ? 'LISTENING' : 'IDLE');
    }
  }

  // ─── Direct Speak Event Handling ─────────────────────────────

  /**
   * The SOLE frontend entry point for TTS playback. Receives speak events
   * directly from AgentPersonaModel via ChatInterface.onSpeakDispatch(),
   * bypassing the messages array deep watcher for lower latency.
   *
   * Turn correlation: if pipelineSequence is present and doesn't match the
   * active graph run sequence, the event is stale (from before a barge-in)
   * and is discarded.
   */
  private handleSpeakEvent(text: string, pipelineSequence: number | null): void {
    if (this.disposed) return;
    if (!text.trim()) return;

    // Turn correlation — discard stale speak events from aborted graph runs
    if (
      pipelineSequence !== null &&
      this.activeGraphRunSequence !== null &&
      pipelineSequence < this.activeGraphRunSequence
    ) {
      console.log(
        `[VoicePipeline] Discarding stale speak event (seq=${pipelineSequence}, active=${this.activeGraphRunSequence})`,
      );

      return;
    }

    const speakId = `speak_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    timingFirstSpeak();
    logSpeakDetected(speakId, 'speak', text.trim());

    // Enqueue for TTS playback
    this.ttsPlayer.enqueue(text.trim(), speakId);

    // Transition to SPEAKING if we were THINKING
    if (this.state === 'THINKING') {
      this.transitionTo('SPEAKING');
    }
  }

  // ─── Flush Timer ──────────────────────────────────────────────

  private getFlushInterval(): number {
    const m = this.mode.value;

    return this.flushIntervalMs[m] ?? DEFAULT_FLUSH_INTERVALS[m];
  }

  private startFlushTimer(): void {
    this.stopFlushTimer();
    const interval = this.getFlushInterval();
    if (interval <= 0) return;

    this.flushTimer = setInterval(() => {
      if (this.buffer.length > 0 && this.state === 'LISTENING') {
        logFlush(-1, this.mode.value, `time-based (${interval}ms)`);
        this.flush();
      }
    }, interval);
  }

  private stopFlushTimer(): void {
    if (this.flushTimer !== null) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  // ─── Interim Bubble Management ────────────────────────────────

  private updateInterimBubble(text: string): void {
    const msgs = this.messages.value;
    const existing = msgs.find((m: ChatMessage) => m.id === VOICE_INTERIM_MSG_ID);
    if (existing) {
      existing.content = text;
    } else {
      msgs.push({
        id:        VOICE_INTERIM_MSG_ID,
        channelId: '',
        threadId:  '',
        role:      'user',
        kind:      'voice_interim',
        content:   text,
      } as ChatMessage);
    }
  }

  private removeInterimBubble(): void {
    const msgs = this.messages.value;
    const idx = msgs.findIndex((m: ChatMessage) => m.id === VOICE_INTERIM_MSG_ID);
    if (idx !== -1) {
      msgs.splice(idx, 1);
    }
  }
}

