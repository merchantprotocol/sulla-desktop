/**
 * TTSPlayerService — owns the TTS playback queue, prefetch, and audio elements.
 *
 * Manages sentence-level TTS playback with:
 *   - Queue with sequential playback
 *   - Look-ahead prefetch (fetch next sentence while current plays)
 *   - Sequence counter to prevent race conditions
 *   - Content deduplication (10s window)
 *   - Browser SpeechSynthesis fallback
 *
 * This service is the ONLY component that plays TTS audio. All TTS goes through
 * enqueue() -> playNext() -> IPC 'audio-speak'. The enqueue() method logs a caller
 * stack trace to VoiceLogger for debugging.
 */

import { TypedEventEmitter } from './TypedEventEmitter';
import { logTTSEnqueue, logTTSPlayStart, logTTSPlayEnd, logTTSStop, logTTSDedup, logTTSFallback, timingFirstAudio } from './VoiceLogger';

// ─── Types ──────────────────────────────────────────────────────

export interface TTSPlayerEvents {
  /** Audio playback started for a sentence */
  playbackStart: void;
  /** Audio playback ended for a sentence */
  playbackEnd: void;
  /** Queue is now empty and nothing is playing */
  queueEmpty: void;
}

export interface TTSPlayerConfig {
  /** IPC invoke function */
  ipcInvoke: (channel: string, ...args: any[]) => Promise<any>;
}

// ─── Service ────────────────────────────────────────────────────

export class TTSPlayerService extends TypedEventEmitter<TTSPlayerEvents> {
  private readonly ipcInvoke: TTSPlayerConfig['ipcInvoke'];

  // ── Public state ──
  isPlaying = false;
  queueLength = 0;

  // ── Queue & playback ──
  private readonly queue: string[] = [];
  private playing = false; // internal re-entrancy lock
  private currentAudio: HTMLAudioElement | null = null;
  private sequence = 0; // monotonic counter — incremented on stop()

  // ── Deduplication ──
  private readonly processedIds = new Set<string>();
  private readonly recentContent = new Set<string>();

  // ── Prefetch ──
  private prefetchedAudio: { text: string; result: any } | null = null;
  private prefetchAbort: AbortController | null = null;
  private prefetchingText: string | null = null;

  constructor(config: TTSPlayerConfig) {
    super();
    this.ipcInvoke = config.ipcInvoke;
  }

  // ─── Public API ───────────────────────────────────────────────

  /**
   * Adds text to the TTS playback queue. Deduplicates by message ID and by
   * content (10s window). Logs a caller stack trace via VoiceLogger for tracing
   * which code path initiated TTS. Starts playback if idle.
   */
  enqueue(text: string, messageId?: string): void {
    if (!text.trim()) return;

    // ID-based dedup
    if (messageId) {
      if (this.processedIds.has(messageId)) return;
      this.processedIds.add(messageId);
    }

    // Content-based dedup (10s window)
    if (this.recentContent.has(text)) {
      logTTSDedup(text);

      return;
    }
    this.recentContent.add(text);
    setTimeout(() => this.recentContent.delete(text), 10_000);

    const callerStack = new Error().stack?.split('\n').slice(1, 5).map(l => l.trim()).join(' < ') || '';
    logTTSEnqueue(text, callerStack);
    this.queue.push(text);
    this.queueLength = this.queue.length;
    this.playNext();
  }

  /**
   * Immediately stops all TTS playback. Clears the queue, cancels in-flight
   * prefetch, pauses current audio, cancels browser speechSynthesis. Increments
   * sequence counter to invalidate in-flight operations.
   */
  stop(): void {
    logTTSStop();
    this.sequence++; // invalidate in-flight operations
    this.queue.length = 0;
    this.queueLength = 0;

    if (this.currentAudio) {
      this.currentAudio.pause();
      this.currentAudio.src = '';
      this.currentAudio = null;
    }

    // Cancel in-flight prefetch
    if (this.prefetchAbort) {
      this.prefetchAbort.abort();
      this.prefetchAbort = null;
    }
    this.prefetchedAudio = null;
    this.prefetchingText = null;

    // Cancel browser speechSynthesis fallback if active
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }

    this.playing = false;
    this.isPlaying = false;
    this.emit('queueEmpty', undefined as any);
  }

  dispose(): void {
    this.stop();
    this.processedIds.clear();
    this.recentContent.clear();
    this.clearAllHandlers();
  }

  // ─── Internal Playback ────────────────────────────────────────

  /**
   * Plays the next item in the queue. Checks prefetch cache first, waits for
   * in-flight prefetch, or makes a fresh 'audio-speak' IPC call. Uses sequence
   * counter to detect stale operations (e.g. stop() was called during fetch).
   * Triggers prefetch of next item while current plays.
   */
  private async playNext(): Promise<void> {
    if (this.playing || this.queue.length === 0) return;
    this.playing = true;
    this.isPlaying = true;
    const seq = this.sequence;

    const text = this.queue.shift()!;
    this.queueLength = this.queue.length;
    const playStartTime = Date.now();
    logTTSPlayStart(text, seq, this.queue.length);

    this.emit('playbackStart', undefined as any);

    try {
      let result: any;
      let source: string;

      if (this.prefetchedAudio?.text === text) {
        result = this.prefetchedAudio.result;
        this.prefetchedAudio = null;
        source = 'prefetched';
      } else if (this.prefetchingText === text) {
        // Wait for in-flight prefetch (max 5s)
        console.log('[TTSPlayer] Waiting for in-flight prefetch...');
        const waitStart = Date.now();
        while (this.prefetchingText === text && Date.now() - waitStart < 5000) {
          await new Promise(r => setTimeout(r, 50));
        }
        if (this.prefetchedAudio?.text === text) {
          result = this.prefetchedAudio.result;
          this.prefetchedAudio = null;
          source = 'waited-for-prefetch';
        } else {
          this.prefetchedAudio = null;
          result = await this.ipcInvoke('audio-speak', { text });
          source = 'fresh-after-wait';
        }
      } else {
        this.prefetchedAudio = null;
        result = await this.ipcInvoke('audio-speak', { text });
        source = 'fresh';
      }

      // Stale check
      if (seq !== this.sequence) {
        console.log('[TTSPlayer] Stale sequence after fetch, aborting');
        this.playing = false;

        return;
      }

      console.log(`[TTSPlayer] Audio ready (source=${source}), size=${result?.audio?.byteLength ?? 0}`);

      if (result?.audio) {
        const blob = new Blob([result.audio], { type: result.mimeType || 'audio/mpeg' });
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        this.currentAudio = audio;

        // Prefetch next while this plays
        this.prefetch();

        await new Promise<void>((resolve) => {
          audio.onended = () => {
            logTTSPlayEnd(text, Date.now() - playStartTime);
            URL.revokeObjectURL(url);
            this.currentAudio = null;
            resolve();
          };
          audio.onerror = (e) => {
            console.warn('[TTSPlayer] Audio error:', e, text.slice(0, 40));
            URL.revokeObjectURL(url);
            this.currentAudio = null;
            resolve();
          };
          audio.play().then(() => {
            timingFirstAudio();
          }).catch((err) => {
            console.warn('[TTSPlayer] audio.play() rejected:', err);
            this.currentAudio = null;
            resolve();
          });
        });

        this.emit('playbackEnd', undefined as any);
      } else {
        console.warn('[TTSPlayer] No audio data in result');
      }
    } catch (err) {
      logTTSFallback(text);
      await this.browserFallback(text);
      this.emit('playbackEnd', undefined as any);
    } finally {
      this.playing = false;
      if (seq === this.sequence) {
        if (this.queue.length > 0) {
          this.playNext();
        } else {
          this.isPlaying = false;
          this.queueLength = 0;
          this.emit('queueEmpty', undefined as any);
        }
      } else {
        this.isPlaying = false;
        this.queueLength = 0;
        this.emit('queueEmpty', undefined as any);
      }
    }
  }

  // ─── Prefetch ─────────────────────────────────────────────────

  /**
   * Prefetches audio for the next queued sentence while the current one plays.
   * Non-fatal failures are logged but don't break playback.
   */
  private async prefetch(): Promise<void> {
    if (this.queue.length === 0 || this.prefetchedAudio) return;
    const nextText = this.queue[0]; // peek, don't shift
    if (this.prefetchingText === nextText) return;

    this.prefetchingText = nextText;
    const seq = this.sequence;
    console.log('[TTSPlayer:prefetch] Starting for:', nextText.slice(0, 60));

    try {
      this.prefetchAbort = new AbortController();
      const result = await this.ipcInvoke('audio-speak', { text: nextText });

      if (seq !== this.sequence) {
        console.log('[TTSPlayer:prefetch] Stale sequence, discarding');

        return;
      }
      if (this.queue[0] === nextText) {
        this.prefetchedAudio = { text: nextText, result };
        console.log('[TTSPlayer:prefetch] Cached audio for:', nextText.slice(0, 60));
      }
    } catch (err) {
      console.log('[TTSPlayer:prefetch] Failed (non-fatal):', err);
    } finally {
      this.prefetchAbort = null;
      this.prefetchingText = null;
    }
  }

  // ─── Browser Fallback ─────────────────────────────────────────

  /**
   * Fallback TTS using browser's SpeechSynthesis API when the IPC
   * 'audio-speak' call fails.
   */
  private browserFallback(text: string): Promise<void> {
    return new Promise<void>((resolve) => {
      if (typeof window === 'undefined' || !window.speechSynthesis) {
        console.warn('[TTSPlayer:fallback] speechSynthesis not available');
        resolve();

        return;
      }
      console.log('[TTSPlayer:fallback] Using browser speechSynthesis:', text.slice(0, 40));
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.onstart = () => timingFirstAudio();
      utterance.onend = () => resolve();
      utterance.onerror = () => resolve();
      window.speechSynthesis.speak(utterance);
    });
  }
}
