/**
 * TTSPlayerService — owns the TTS playback queue, prefetch, and audio elements.
 *
 * Manages sentence-level TTS playback with:
 *   - Queue with sequential playback
 *   - Look-ahead prefetch (fetch next sentence while current plays)
 *   - Sequence counter to prevent race conditions
 *   - Content deduplication (10s window)
 *   - No fallback voice: a unit the selected engine can't render is skipped
 *
 * This service is the ONLY component that plays TTS audio. All TTS goes through
 * enqueue() -> playNext() -> IPC 'audio-speak'. The enqueue() method logs a caller
 * stack trace to VoiceLogger for debugging.
 */

import { splitForSynthesis } from './speechText';
import { TypedEventEmitter } from './TypedEventEmitter';
import { logTTSEnqueue, logTTSPlayStart, logTTSPlayEnd, logTTSStop, logTTSDedup, logTTSSynthFailed, timingFirstAudio } from './VoiceLogger';

// Speaking-rate multipliers for the native OS voice, mirroring Sulla Mobile's TtsService.
const RATE_MAP: Record<string, number> = {
  slow:   0.85,
  normal: 1.0,
  fast:   1.2,
};

// The one player allowed to make sound. Every chat tab (and the classic voice
// session) owns its own player; without this, replies from several
// conversations talk over each other. Newest speaker wins.
const audible: { player: TTSPlayerService | null } = { player: null };

// ─── Types ──────────────────────────────────────────────────────

export interface TTSPlayerEvents {
  /** Audio playback started for a sentence */
  playbackStart: void;
  /** Audio playback ended for a sentence */
  playbackEnd:   void;
  /** Queue is now empty and nothing is playing */
  queueEmpty:    void;
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
  private currentAudio:   HTMLAudioElement | null = null;
  private sequence = 0; // monotonic counter — incremented on stop()

  // ── Deduplication ──
  private readonly processedIds = new Set<string>();
  private readonly recentContent = new Set<string>();

  // ── Prefetch ──
  private prefetchedAudio: { text: string; result: any } | null = null;
  private prefetchAbort:   AbortController | null = null;
  private prefetchingText: string | null = null;

  // ── TTS provider config ──
  // Cached provider selection. Loaded lazily from settings and cleared on stop() so a
  // provider/voice change in Audio Settings takes effect on the next spoken turn.
  private ttsConfig: { provider: string; voiceURI: string; rate: number } | null = null;
  private kokoroWarmed = false;

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
    void this.getTtsConfig(); // start loading provider config (and warming Kokoro) now

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
    // Short units: the first renders fast so audio starts sooner, and each later
    // unit synthesizes while the one before it plays.
    this.queue.push(...splitForSynthesis(text));
    this.queueLength = this.queue.length;
    if (this.playing) {
      void this.prefetch(); // current unit is busy — get the next one rendering now
    }
    this.playNext();
  }

  /**
   * Immediately stops all TTS playback. Clears the queue, cancels in-flight
   * prefetch, pauses current audio, cancels browser speechSynthesis. Increments
   * sequence counter to invalidate in-flight operations.
   */
  stop(): void {
    logTTSStop();
    if (audible.player === this) audible.player = null;
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

    // Drop any queued on-device synthesis so the sidecar is free for the next turn
    if (this.ttsConfig?.provider === 'kokoro') {
      this.ipcInvoke('audio-speak-cancel').catch(() => { /* best-effort */ });
    }

    // Re-read provider/voice config next turn (may have changed in Audio Settings)
    this.ttsConfig = null;

    // Cancel native OS voice playback (system provider) if active
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }

    this.playing = false;
    this.isPlaying = false;
    this.emit('queueEmpty', undefined as any);
  }

  /**
   * Get ready to speak soon (e.g. the user started talking): loads the provider
   * config and, for Kokoro, boots the sidecar + model so the reply's first
   * sentence doesn't pay the ~1s model load.
   */
  prepare(): void {
    void this.getTtsConfig();
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

    // One voice app-wide: silence any other conversation before this one speaks.
    if (audible.player && audible.player !== this) audible.player.stop();
    audible.player = this;

    const text = this.queue.shift()!;
    this.queueLength = this.queue.length;
    const playStartTime = Date.now();
    logTTSPlayStart(text, seq, this.queue.length);

    this.emit('playbackStart', undefined as any);

    try {
      const cfg = await this.getTtsConfig();

      // Native OS voice: speak in-renderer via SpeechSynthesis — no IPC, no prefetch, no audio blob.
      if (cfg.provider === 'system') {
        if (seq !== this.sequence) {
          this.playing = false;

          return;
        }
        await this.speakNative(text, cfg.voiceURI, cfg.rate);
        logTTSPlayEnd(text, Date.now() - playStartTime);
        this.emit('playbackEnd', undefined as any);

        return;
      }

      let result: any;
      let source: string;

      if (this.prefetchedAudio?.text === text) {
        result = this.prefetchedAudio.result;
        this.prefetchedAudio = null;
        source = 'prefetched';
      } else if (this.prefetchingText === text) {
        // Wait for the in-flight prefetch rather than asking twice — a duplicate
        // request would queue behind it in the on-device engine anyway.
        console.log('[TTSPlayer] Waiting for in-flight prefetch...');
        const waitStart = Date.now();
        while (this.prefetchingText === text && seq === this.sequence && Date.now() - waitStart < 30_000) {
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
        const current = this.ipcInvoke('audio-speak', { text });

        // Queue the next unit right behind this one instead of waiting for this
        // one to finish — synthesis stays ahead of playback.
        void this.prefetch();
        result = await current;
        source = 'fresh';
      }

      // Stale check
      if (seq !== this.sequence) {
        console.log('[TTSPlayer] Stale sequence after fetch, aborting');
        this.playing = false;

        return;
      }

      console.log(`[TTSPlayer] Audio ready (source=${ source }), size=${ result?.audio?.byteLength ?? 0 }`);

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
      // No fallback to the OS voice: a unit the selected engine (e.g. Kokoro
      // while its model downloads) can't render is skipped, not read in a
      // different voice.
      logTTSSynthFailed(text);
      console.warn('[TTSPlayer] Synthesis failed, skipping unit:', err);
      this.emit('playbackEnd', undefined as any);
    } finally {
      this.playing = false;
      if (seq === this.sequence) {
        if (this.queue.length > 0) {
          this.playNext();
        } else {
          if (audible.player === this) audible.player = null;
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
    // One look-ahead at a time: synthesis is faster than playback, so staying one
    // unit ahead is enough, and overlapping requests would only compete for CPU.
    if (this.queue.length === 0 || this.prefetchedAudio || this.prefetchingText !== null) return;
    // Native OS voice is synthesized locally on demand — nothing to prefetch over IPC.
    if ((this.ttsConfig ?? await this.getTtsConfig()).provider === 'system') return;
    if (this.queue.length === 0 || this.prefetchedAudio || this.prefetchingText !== null) return;
    const nextText = this.queue[0]; // peek, don't shift

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
      if (this.prefetchingText === nextText) this.prefetchingText = null;
    }
  }

  // ─── Provider config ──────────────────────────────────────────

  /**
   * Reads the selected TTS provider, voice, and rate from settings (cached until
   * stop() clears it). Defaults to on-device Kokoro (Bella) — free and keyless; while
   * its model downloads, nothing is spoken (no native OS voice fallback).
   */
  private async getTtsConfig(): Promise<{ provider: string; voiceURI: string; rate: number }> {
    if (this.ttsConfig) return this.ttsConfig;
    try {
      const [provider, voiceURI, rateKey] = await Promise.all([
        this.ipcInvoke('sulla-settings-get', 'audioTtsProvider', 'kokoro'),
        this.ipcInvoke('sulla-settings-get', 'audioTtsVoice', ''),
        this.ipcInvoke('sulla-settings-get', 'audioTtsRate', 'normal'),
      ]);
      this.ttsConfig = {
        provider: provider || 'kokoro',
        voiceURI: voiceURI || '',
        rate:     RATE_MAP[rateKey as string] ?? 1.0,
      };
    } catch {
      this.ttsConfig = { provider: 'kokoro', voiceURI: '', rate: 1.0 };
    }

    // Load the on-device model before the first sentence needs it (no-op when warm;
    // starts the one-time download when the model is missing).
    if (this.ttsConfig.provider === 'kokoro' && !this.kokoroWarmed) {
      this.kokoroWarmed = true;
      this.ipcInvoke('voice-kokoro-warm').catch(() => { /* best-effort */ });
    }

    return this.ttsConfig;
  }

  // ─── Native (OS) Voice ────────────────────────────────────────

  /**
   * Speaks text through the OS speech engine via SpeechSynthesis. In Electron on
   * macOS these are the native system voices. Honors the selected voiceURI (or an
   * auto pick of the default English voice) and speaking rate.
   */
  private speakNative(text: string, voiceURI: string, rate: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const synth = typeof window !== 'undefined' ? window.speechSynthesis : undefined;
      if (!synth) {
        console.warn('[TTSPlayer:native] speechSynthesis not available');
        resolve();

        return;
      }

      const utterance = new SpeechSynthesisUtterance(text);
      const allVoices = synth.getVoices();

      if (voiceURI && voiceURI !== 'auto') {
        const match = allVoices.find(v => v.voiceURI === voiceURI);
        if (match) utterance.voice = match;
      } else {
        // Auto: prefer the OS default English voice, else the first English voice.
        const english = allVoices.filter(v => v.lang?.toLowerCase().startsWith('en'));
        const pick = english.find(v => v.default) || english[0];
        if (pick) utterance.voice = pick;
      }

      utterance.rate = rate;
      utterance.onstart = () => timingFirstAudio();
      utterance.onend = () => resolve();
      utterance.onerror = () => resolve();
      synth.speak(utterance);
    });
  }
}
