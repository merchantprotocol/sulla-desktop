// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

interface SpokenEntry { words: string[]; expiresAt: number }

export interface SelfEchoFilterOptions {
  now?: () => number;
  /** Seconds of playback assumed per word, used to keep an entry alive while it is heard. */
  secondsPerWord?: number;
  /** Extra time after estimated playback to catch delayed recognition chunks. */
  tailMs?: number;
  /** Fraction of a transcript's words that must match recent speech to count as echo. */
  overlap?: number;
}

/**
 * Recognises transcripts that are Sulla hearing her own voice through the speakers.
 * The mic runs without echo cancellation, so Kokoro playback comes back as "user" speech;
 * treating it as a turn made Sulla interrupt herself.
 */
export class SelfEchoFilter {
  private entries: SpokenEntry[] = [];
  private playbackActive = false;
  private readonly now: () => number;
  private readonly secondsPerWord: number;
  private readonly tailMs: number;
  private readonly overlap: number;

  constructor(options: SelfEchoFilterOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.secondsPerWord = options.secondsPerWord ?? 0.5;
    this.tailMs = options.tailMs ?? 6000;
    this.overlap = options.overlap ?? 0.6;
  }

  private static words(text: string): string[] {
    const numbers: Record<string, string> = {
      zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6',
      seven: '7', eight: '8', nine: '9', ten: '10', eleven: '11', twelve: '12',
      thirteen: '13', fourteen: '14', fifteen: '15', sixteen: '16', seventeen: '17',
      eighteen: '18', nineteen: '19', twenty: '20',
    };
    return text.toLowerCase().replace(/[^a-z0-9'\s]/g, ' ').split(/\s+/).filter(Boolean)
      .flatMap(word => {
        const expanded = word.replace(/\bcan't\b/g, 'can not').replace(/\bwon't\b/g, 'will not')
          .replace(/n't\b/g, ' not').replace(/'re\b/g, ' are').replace(/'ve\b/g, ' have')
          .replace(/'ll\b/g, ' will').replace(/'m\b/g, ' am').replace(/'d\b/g, ' would')
          .replace(/'s\b/g, ' is');
        return expanded.split(/\s+/).map(token => numbers[token] ?? token);
      });
  }

  /** Record text that is about to be spoken aloud. */
  recordSpoken(text: string): void {
    const words = SelfEchoFilter.words(text);
    if (!words.length) return;
    const start = Math.max(this.now(), this.entries.at(-1)?.expiresAt ? this.entries.at(-1)!.expiresAt - this.tailMs : 0);
    this.entries.push({ words, expiresAt: start + words.length * this.secondsPerWord * 1000 + this.tailMs });
  }

  clear(): void { this.entries = []; this.playbackActive = false; }

  /** Anchor the estimate to audible playback, not enqueue/synthesis time. */
  playbackStarted(): void {
    this.playbackActive = true;
    const start = this.now();
    for (const entry of this.entries) {
      entry.expiresAt = start + entry.words.length * this.secondsPerWord * 1000 + this.tailMs;
    }
  }

  /** Keep all queued speech through the actual end of playback and the recognition tail. */
  playbackEnded(): void {
    this.playbackActive = false;
    const expiresAt = this.now() + this.tailMs;
    for (const entry of this.entries) entry.expiresAt = expiresAt;
  }

  hasRecentSpeech(): boolean {
    const now = this.now();
    this.entries = this.entries.filter(entry => this.playbackActive || entry.expiresAt > now);
    return this.playbackActive || this.entries.length > 0;
  }

  /** Remove exact contiguous echo spans anywhere while preserving surrounding user words. */
  stripEchoSpans(transcript: string): string {
    const entries = this.entries.filter(e => this.playbackActive || e.expiresAt > this.now());
    this.entries = entries;
    const spoken = entries.flatMap(e => e.words);
    if (!spoken.length) return transcript;
    const tokens = transcript.match(/\S+/g) ?? [];
    const heardTokens: Array<{ word: string; tokenIndex: number }> = [];
    tokens.forEach((token, tokenIndex) => {
      for (const word of SelfEchoFilter.words(token)) heardTokens.push({ word, tokenIndex });
    });
    const heard = heardTokens.map(token => token.word);
    if (!heard.length) return transcript;
    const longestOverlapAt = (start: number): number => {
      let best = 0;
      for (let i = 0; i < spoken.length; i++) {
        let n = 0;
        while (start + n < heard.length && i + n < spoken.length && heard[start + n] === spoken[i + n]) n++;
        best = Math.max(best, n);
      }
      return best >= 2 ? best : 0;
    };
    const removed = new Set<number>();
    for (let i = 0; i < heard.length;) {
      const span = longestOverlapAt(i);
      // Short exact spans are safe to remove only when they are part of a mixed
      // transcript; an all-echo two-word turn is handled by isEcho() instead.
      if (span >= 2 && heard.length > span) {
        for (let n = i; n < i + span; n++) removed.add(heardTokens[n].tokenIndex);
        i += span;
      } else i++;
    }
    return tokens.filter((_, index) => !removed.has(index)).join(' ').trim();
  }

  isEcho(transcript: string): boolean {
    const now = this.now();
    this.entries = this.entries.filter(e => this.playbackActive || e.expiresAt > now);
    if (!this.entries.length) return false;
    const heard = SelfEchoFilter.words(transcript);
    if (!heard.length) return false;
    const spoken = new Set<string>();
    for (const e of this.entries) for (const w of e.words) spoken.add(w);
    const matches = heard.filter(w => spoken.has(w)).length;
    return matches / heard.length >= this.overlap;
  }
}
