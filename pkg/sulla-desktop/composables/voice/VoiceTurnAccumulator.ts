// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { HeuristicEndOfTurnDetector, TurnBuffer, type EndOfTurnDetector } from './ConversationTurnPolicy';

export interface VoiceTurnAccumulatorConfig {
  onInterim: (text: string) => void;
  onCommit: (text: string) => void;
  isTTSPlaying: () => boolean;
  /** @deprecated Ignored. Turns now end when the words stop changing, not on a VAD-driven fallback. */
  fallbackMs?: number;
  /** Short hold after the main-process utterance_end (VAD silence) signal. */
  endOfTurnHoldMs?: number;
  /** Commit once the transcript has stopped changing for this long, whatever the VAD says. */
  wordsStableMs?: number;
  endOfTurnDetector?: EndOfTurnDetector;
  noiseFilter?: TranscriptNoiseFilter;
  /** Returns true when a transcript is Sulla's own voice picked up by the mic. */
  isEcho?: (text: string) => boolean;
  now?: () => number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}

export interface VoiceTurnAccumulator {
  handleEvent: (msg: any) => void;
  commitNow: () => void;
  reset: () => void;
  speechStarted: () => void;
}

/** Recognises transcripts that are only background noise or Whisper's known silence hallucinations. */
export class TranscriptNoiseFilter {
  private readonly tagOnly = /^[\s[\](){}*.\-_,!?♪]*(?:[[(][^\])]*[\])][\s.,!?]*)+$/;
  private readonly hallucinations = new Set([
    'you', 'thank you', 'thanks', 'thank you very much', 'thanks for watching', 'thank you for watching',
    'bye', 'okay', 'oh', 'um', 'uh', 'hmm', 'mm', 'so', '.', '...',
  ]);

  shouldDropShortNearNoiseFloor(text: string, peakMicLevel: number, noiseFloor = 0.005): boolean {
    const words = text.trim().match(/[a-z0-9']+/gi) ?? [];
    return words.length > 0 && words.length <= 3 && peakMicLevel <= noiseFloor;
  }

  isNoise(text: string): boolean {
    const clean = text.trim();
    if (!clean) return true;
    if (this.tagOnly.test(clean)) return true;
    if (!/[a-z0-9]/i.test(clean)) return true;
    const normalized = clean.toLowerCase().replace(/[.,!?]+$/g, '').trim();
    if (this.hallucinations.has(normalized)) return true;

    const words = normalized.match(/[a-z0-9']+/g) ?? [];
    if (words.length < 3) return false;
    // Reject obvious repeated-word loops without suppressing meaningful short
    // emphasis such as "no no no stop".
    const distinctRatio = new Set(words).size / words.length;
    if (distinctRatio <= 0.34 && words.length >= 5) return true;
    for (let n = 1; n <= 3; n++) {
      if (words.length < n * 3 || words.length % n !== 0) continue;
      const unit = words.slice(0, n).join(' ');
      if (words.every((word, index) => word === words[index % n]) && words.length / n >= 3) return true;
      if (unit && words.every((word, index) => word === words[index % n])) return true;
    }
    return false;
  }
}

type TimerKind = 'hold' | 'stable' | null;

/**
 * Owns transcript buffering and the commit decision for one voice session.
 *
 * A turn ends when the WORDS stop changing (wordsStableMs, extended for unfinished phrases),
 * or sooner after the main-process utterance_end signal. Raw VAD frames never postpone a
 * commit: background noise keeps VAD "speaking" forever, which used to hold the turn open.
 * Nothing is dropped: a follow-up after a commit becomes a new turn that the chat layer merges.
 */
export class VoiceTurnAccumulatorService implements VoiceTurnAccumulator {
  private readonly text = new TurnBuffer();
  private partialText = '';
  private lastPartialChunk = '';
  private timer: ReturnType<typeof setTimeout> | null = null;
  private timerKind: TimerKind = null;
  private lastWordChangeAt = 0;
  private readonly setTimer: typeof setTimeout;
  private readonly clearTimerFn: typeof clearTimeout;
  private readonly detector: EndOfTurnDetector;
  private readonly noise: TranscriptNoiseFilter;
  private readonly now: () => number;
  private readonly holdMs: number;
  private readonly stableMs: number;

  constructor(private readonly config: VoiceTurnAccumulatorConfig) {
    // Never store the bare globals: calling them as this.setTimer(...) rebinds `this` and
    // Chromium throws "Illegal invocation", so no turn would ever commit in the app.
    this.setTimer = config.setTimer ?? (((fn: () => void, ms?: number) => setTimeout(fn, ms)) as typeof setTimeout);
    this.clearTimerFn = config.clearTimer ?? ((id?: ReturnType<typeof setTimeout>) => clearTimeout(id));
    this.detector = config.endOfTurnDetector ?? new HeuristicEndOfTurnDetector();
    this.noise = config.noiseFilter ?? new TranscriptNoiseFilter();
    this.now = config.now ?? (() => Date.now());
    this.holdMs = config.endOfTurnHoldMs ?? 700;
    this.stableMs = config.wordsStableMs ?? 1500;
  }

  private clearTimer(): void {
    if (this.timer !== null) this.clearTimerFn(this.timer);
    this.timer = null;
    this.timerKind = null;
  }

  private arm(kind: Exclude<TimerKind, null>, delay: number): void {
    this.clearTimer();
    this.timerKind = kind;
    this.timer = this.setTimer(() => this.commitNow(), Math.max(0, delay));
  }

  private currentText(): string {
    return [this.text.text, this.partialText].filter(Boolean).join(' ');
  }

  private stableDelay(): number {
    const due = this.lastWordChangeAt + this.detector.delayMs(this.currentText(), this.stableMs);
    return due - this.now();
  }

  private wordsChanged(): void {
    this.lastWordChangeAt = this.now();
    this.arm('stable', this.stableDelay());
  }

  commitNow(): void {
    this.clearTimer();
    const transcript = this.currentText();
    this.text.clear();
    this.partialText = '';
    this.lastPartialChunk = '';
    if (transcript) this.config.onCommit(transcript);
  }

  handleEvent(msg: any): void {
    if (msg?.event_type === 'utterance_end') {
      if (this.currentText()) this.arm('hold', this.detector.delayMs(this.currentText(), this.holdMs));
      return;
    }
    if (!msg?.text || this.config.isTTSPlaying()) return;
    const transcript = String(msg.text).trim();
    if (this.noise.isNoise(transcript)) return;
    if (this.config.isEcho?.(transcript)) return;
    if (msg.event_type === 'transcript_partial') {
      // Partials arrive as incremental chunks; keep every one. An exact repeat of the last
      // chunk is a stuck recogniser on noise, so it must not count as new words.
      if (transcript === this.lastPartialChunk) return;
      this.lastPartialChunk = transcript;
      this.partialText = this.partialText ? `${ this.partialText } ${ transcript }` : transcript;
      this.config.onInterim(this.currentText());
      this.wordsChanged();
      return;
    }
    this.text.append(transcript);
    this.partialText = '';
    this.lastPartialChunk = '';
    this.config.onInterim(this.text.text);
    this.wordsChanged();
  }

  /**
   * VAD reports speech. Only cancels a pending short utterance_end hold, falling back to the
   * words-stable deadline measured from the last real word, so noise can never extend a turn.
   */
  speechStarted(): void {
    if (this.timerKind !== 'hold' || !this.currentText()) return;
    this.arm('stable', this.stableDelay());
  }

  reset(): void {
    this.clearTimer();
    this.text.clear();
    this.partialText = '';
    this.lastPartialChunk = '';
  }
}

/** Backwards-compatible factory. */
export function createVoiceTurnAccumulator(config: VoiceTurnAccumulatorConfig): VoiceTurnAccumulator {
  return new VoiceTurnAccumulatorService(config);
}
