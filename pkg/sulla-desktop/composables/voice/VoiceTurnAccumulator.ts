// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { HeuristicEndOfTurnDetector, TurnBuffer, type EndOfTurnDetector } from './ConversationTurnPolicy';

export interface VoiceTurnAccumulatorConfig {
  onInterim: (text: string) => void;
  onCommit: (text: string) => void;
  isTTSPlaying: () => boolean;
  fallbackMs?: number;
  endOfTurnHoldMs?: number;
  endOfTurnDetector?: EndOfTurnDetector;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}

export interface VoiceTurnAccumulator {
  handleEvent: (msg: any) => void;
  commitNow: () => void;
  reset: () => void;
  speechStarted: () => void;
}

/** Owns transcript buffering and commit timers for a single voice session. */
export class VoiceTurnAccumulatorService implements VoiceTurnAccumulator {
  private readonly text = new TurnBuffer();
  private partialText = '';
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly setTimer: typeof setTimeout;
  private readonly clearTimerFn: typeof clearTimeout;
  private readonly detector: EndOfTurnDetector;
  private readonly fallbackMs: number;
  private readonly holdMs: number;

  constructor(private readonly config: VoiceTurnAccumulatorConfig) {
    this.setTimer = config.setTimer ?? setTimeout;
    this.clearTimerFn = config.clearTimer ?? clearTimeout;
    this.detector = config.endOfTurnDetector ?? new HeuristicEndOfTurnDetector();
    this.fallbackMs = config.fallbackMs ?? 8000;
    this.holdMs = config.endOfTurnHoldMs ?? 700;
  }

  private clearTimer(): void {
    if (this.timer !== null) this.clearTimerFn(this.timer);
    this.timer = null;
  }

  private arm(delay: number): void {
    this.clearTimer();
    this.timer = this.setTimer(() => this.commitNow(), delay);
  }

  commitNow(): void {
    this.clearTimer();
    const transcript = this.text.text;
    this.text.clear();
    this.partialText = '';
    this.config.onCommit(transcript);
  }

  handleEvent(msg: any): void {
    if (msg?.event_type === 'utterance_end') {
      this.arm(this.detector.delayMs(this.text.text, this.holdMs));
      return;
    }
    if (!msg?.text || this.config.isTTSPlaying()) return;
    const transcript = String(msg.text).trim();
    if (!transcript) return;
    this.clearTimer();
    if (msg.event_type === 'transcript_partial') {
      this.partialText = this.partialText ? `${ this.partialText } ${ transcript }` : transcript;
      this.config.onInterim(this.text.text ? `${ this.text.text } ${ this.partialText }` : this.partialText);
      return;
    }
    this.text.append(transcript);
    this.partialText = '';
    this.config.onInterim(this.text.text);
    this.arm(this.fallbackMs);
  }

  /** Cancel only the short end-of-turn hold; preserve/re-arm buffered-text fallback. */
  speechStarted(): void {
    if (this.timer === null || !this.text.text) return;
    this.clearTimer();
    this.arm(this.fallbackMs);
  }

  reset(): void {
    this.clearTimer();
    this.text.clear();
    this.partialText = '';
  }
}

/** Backwards-compatible factory. */
export function createVoiceTurnAccumulator(config: VoiceTurnAccumulatorConfig): VoiceTurnAccumulator {
  return new VoiceTurnAccumulatorService(config);
}
