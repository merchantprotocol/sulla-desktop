// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

/** Buffers transcript segments without losing words when recognition resumes. */
export class TurnBuffer {
  private segments: string[] = [];

  append(text: string): string {
    const clean = text.trim();
    if (clean) this.segments.push(clean);
    return this.text;
  }

  get text(): string { return this.segments.join(' '); }
  clear(): void { this.segments = []; }
}

/** Pluggable decision point for a future semantic end-of-turn model. */
export interface EndOfTurnDetector {
  delayMs(transcript: string, defaultHoldMs: number): number;
}

/** Extends the silence hold when the last words suggest an unfinished thought. */
export class HeuristicEndOfTurnDetector implements EndOfTurnDetector {
  private readonly unfinished = /(?:\b(?:and|so|but|a|an|the|to|of|for|with|because|if|when|that)|,)\s*$/i;
  delayMs(transcript: string, defaultHoldMs: number): number {
    return this.unfinished.test(transcript.trim()) ? defaultHoldMs * 2 : defaultHoldMs;
  }
}
